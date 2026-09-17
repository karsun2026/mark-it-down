/**
 * Compressor agent (spec §10.5).
 *
 * Consumes ONLY verified signals and the document map (never raw evidence),
 * and produces selections + renderings for all six nested tiers in one unit —
 * which is what lets the UI depth slider change tiers without any model call.
 *
 * Deterministic post-checks: every selected signal id must resolve to a
 * verified signal, and the tier nesting invariant
 * `ONE_THING ⊆ BRUTAL ⊆ QUICK_SCAN ⊆ BRIEF ⊆ READMAP ⊆ DEEP_DIVE` must hold.
 */

import type { DocumentMapV1 } from "../schemas/signal";
import {
  CompressorRankingV1Schema,
  type CompressedTiersV1,
  type TierEntry,
} from "../schemas/signal";
import type { ModelResult, StructuredModelClient } from "../models/client";
import { AgentContractError, assertTierNesting } from "./contract";
import type { AgentRun } from "./run";
import {
  COMPRESSOR_PROMPT_VERSION,
  COMPRESSOR_SYSTEM_PROMPT,
} from "../prompts/compressor";

/**
 * Target size of each nested tier — the six stops of the depth slider. Each
 * tier is a prefix of the single ranked list, so shorter ⊆ longer holds by
 * construction and ONE_THING is always exactly one. DEEP_DIVE is every signal.
 */
const TIER_TARGET_SIZES: Record<keyof CompressedTiersV1["tiers"], number | "all"> = {
  ONE_THING: 1,
  BRUTAL: 3,
  QUICK_SCAN: 6,
  BRIEF: 12,
  READMAP: 20,
  DEEP_DIVE: "all",
};

export interface VerifiedSignalRef {
  id: string;
  claim: string;
  epistemicStatus: string;
}

/**
 * Deterministic subset check used by the grounding gate as well: every
 * selected id must be a verified signal id. Nestedness itself is enforced by
 * `assertTierNesting` (contract.ts).
 */
export function assertSelectionsResolve(
  tiers: CompressedTiersV1,
  verified: readonly VerifiedSignalRef[],
): void {
  const known = new Set(verified.map((signal) => signal.id));
  for (const tierName of Object.keys(tiers.tiers) as (keyof CompressedTiersV1["tiers"])[]) {
    for (const entry of tiers.tiers[tierName]) {
      if (!known.has(entry.signalId)) {
        throw new AgentContractError(
          `tier ${tierName} selects ${entry.signalId}, which is not a verified signal`,
        );
      }
    }
  }
}

/**
 * Assemble the six nested tiers deterministically from the model's ranked list.
 * The model only ranks and renders; nesting is enforced here, in code:
 *
 * - Ranked entries with an unknown or duplicated signal id are dropped (this is
 *   what neutralises the M2 failures: a merged id like "s0035,s0002" is not a
 *   known id, so it is simply skipped instead of failing the whole job).
 * - Any verified signal the model omitted is appended in the pipeline's own
 *   order, so DEEP_DIVE is always the complete set and the deepest view never
 *   silently loses a fact.
 * - Each tier is a prefix of that completed list, so ONE_THING ⊆ BRUTAL ⊆ … ⊆
 *   DEEP_DIVE holds by construction and ONE_THING has exactly one entry.
 *
 * `rankingDegraded` is true when the model contributed no usable ranking at
 * all and the order is entirely the fallback (document order, not importance) —
 * the pipeline surfaces this as a visible warning rather than downgrading
 * quality silently.
 */
export function buildTiers(
  ranked: readonly TierEntry[] | undefined,
  verified: readonly VerifiedSignalRef[],
): { tiers: CompressedTiersV1; rankingDegraded: boolean } {
  const claimById = new Map(verified.map((signal) => [signal.id, signal.claim]));
  const seen = new Set<string>();
  const ordered: TierEntry[] = [];

  for (const entry of ranked ?? []) {
    const id = entry?.signalId;
    if (typeof id !== "string" || !claimById.has(id) || seen.has(id)) continue;
    seen.add(id);
    const text =
      typeof entry.text === "string" && entry.text.trim().length > 0
        ? entry.text.trim()
        : (claimById.get(id) as string);
    ordered.push({ signalId: id, text });
  }

  const rankedFromModel = ordered.length;
  // Completeness: append any verified signal the model left out, in order.
  for (const signal of verified) {
    if (!seen.has(signal.id)) {
      seen.add(signal.id);
      ordered.push({ signalId: signal.id, text: signal.claim });
    }
  }

  const prefix = (target: number | "all"): TierEntry[] =>
    ordered.slice(0, target === "all" ? ordered.length : Math.min(target, ordered.length));

  const tiers: CompressedTiersV1 = {
    tiers: {
      ONE_THING: prefix(TIER_TARGET_SIZES.ONE_THING),
      BRUTAL: prefix(TIER_TARGET_SIZES.BRUTAL),
      QUICK_SCAN: prefix(TIER_TARGET_SIZES.QUICK_SCAN),
      BRIEF: prefix(TIER_TARGET_SIZES.BRIEF),
      READMAP: prefix(TIER_TARGET_SIZES.READMAP),
      DEEP_DIVE: prefix(TIER_TARGET_SIZES.DEEP_DIVE),
    },
  };
  return { tiers, rankingDegraded: rankedFromModel === 0 && verified.length > 0 };
}

export function runCompressor(
  client: StructuredModelClient,
  input: {
    verified: readonly VerifiedSignalRef[];
    documentMap: DocumentMapV1;
    idempotencyKey: string;
  },
): Promise<AgentRun<CompressedTiersV1> & { rankingDegraded: boolean }> {
  const payload = {
    documentMap: input.documentMap,
    verifiedSignals: input.verified.map((signal) => ({
      id: signal.id,
      claim: signal.claim,
      epistemicStatus: signal.epistemicStatus,
    })),
  };

  return client
    .generate({
      task: "compression",
      system: COMPRESSOR_SYSTEM_PROMPT,
      messages: [{ role: "user", text: JSON.stringify(payload) }],
      schema: CompressorRankingV1Schema,
      temperature: 0,
      idempotencyKey: input.idempotencyKey,
    })
    .then((result) => {
      const { tiers, rankingDegraded } = buildTiers(result.value.ranked, input.verified);
      // Defence-in-depth: both invariants now hold by construction, but a code
      // regression in buildTiers must still fail loudly, never ship.
      assertTierNesting(tiers);
      assertSelectionsResolve(tiers, input.verified);
      const built: ModelResult<CompressedTiersV1> = { ...result, value: tiers };
      return { result: built, promptVersion: COMPRESSOR_PROMPT_VERSION, rankingDegraded };
    });
}
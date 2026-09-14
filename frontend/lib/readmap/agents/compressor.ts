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
  CompressedTiersV1Schema,
  type CompressedTiersV1,
} from "../schemas/signal";
import type { StructuredModelClient } from "../models/client";
import { AgentContractError, assertTierNesting } from "./contract";
import type { AgentRun } from "./run";
import {
  COMPRESSOR_PROMPT_VERSION,
  COMPRESSOR_SYSTEM_PROMPT,
} from "../prompts/compressor";

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

export function runCompressor(
  client: StructuredModelClient,
  input: {
    verified: readonly VerifiedSignalRef[];
    documentMap: DocumentMapV1;
    idempotencyKey: string;
  },
): Promise<AgentRun<CompressedTiersV1>> {
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
      schema: CompressedTiersV1Schema,
      temperature: 0,
      idempotencyKey: input.idempotencyKey,
    })
    .then((result) => {
      assertTierNesting(result.value);
      assertSelectionsResolve(result.value, input.verified);
      return { result, promptVersion: COMPRESSOR_PROMPT_VERSION };
    });
}
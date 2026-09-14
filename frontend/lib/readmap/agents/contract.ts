/**
 * Deterministic contract checks shared by the agents (spec §10; rules 12–14).
 *
 * These are the checks Zod cannot express: that citations resolve to the
 * supplied evidence, that quotes are verbatim spans, and that compression
 * tiers nest. A violation means the MODEL unit failed — it is thrown, recorded
 * by the pipeline, and never silently repaired by inventing content.
 *
 * Error messages carry ids and counts only (rule 16): never a quotation or
 * any other document content.
 */

import type { EvidenceBlockInput } from "../schemas/evidence";
import { COMPRESSION_TIERS, type CompressedTiersV1 } from "../schemas/signal";

export class AgentContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentContractError";
  }
}

/** Whitespace-insensitive comparison form for verbatim-quote checks. */
export function normalizeForQuoteMatch(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/**
 * True when `quote` appears verbatim (whitespace-insensitively) in the cited
 * block's text. Checks `normalizedText` and, when present, `sourceText`.
 */
export function quoteIsVerbatim(
  quote: string,
  block: Pick<EvidenceBlockInput, "normalizedText" | "sourceText">,
): boolean {
  const needle = normalizeForQuoteMatch(quote);
  if (needle.length === 0) return false;
  return (
    normalizeForQuoteMatch(block.normalizedText).includes(needle) ||
    normalizeForQuoteMatch(block.sourceText).includes(needle)
  );
}

/**
 * Validate every candidate signal's citations against the evidence the
 * extractor was actually given:
 *
 * - each cited block id must exist in the supplied set (rule 9: no source, no
 *   signal — a citation to a block the model never saw is fabrication);
 * - each quote's block must be listed in `evidenceBlockIds`;
 * - each quote must be a verbatim span of its cited block.
 */
export function validateSignalCitations(
  signals: readonly {
    evidenceBlockIds: readonly string[];
    evidenceQuotes: readonly { blockId: string; quote: string }[];
  }[],
  blocks: readonly EvidenceBlockInput[],
): void {
  const byId = new Map(blocks.map((block) => [block.id, block]));
  let signalIndex = 0;
  for (const signal of signals) {
    for (const blockId of signal.evidenceBlockIds) {
      if (!byId.has(blockId)) {
        throw new AgentContractError(
          `signal #${signalIndex + 1} cites block ${blockId} that was not in the supplied evidence`,
        );
      }
    }
    for (const quote of signal.evidenceQuotes) {
      if (!signal.evidenceBlockIds.includes(quote.blockId)) {
        throw new AgentContractError(
          `signal #${signalIndex + 1} quotes block ${quote.blockId} without listing it in evidenceBlockIds`,
        );
      }
      const block = byId.get(quote.blockId);
      if (!block || !quoteIsVerbatim(quote.quote, block)) {
        throw new AgentContractError(
          `signal #${signalIndex + 1} has a quote that is not a verbatim span of block ${quote.blockId}`,
        );
      }
    }
    signalIndex += 1;
  }
}

/**
 * Enforce the spec §10.5 nesting invariant:
 * `ONE_THING ⊆ BRUTAL ⊆ QUICK_SCAN ⊆ BRIEF ⊆ READMAP ⊆ DEEP_DIVE`,
 * with exactly one ONE_THING signal and no duplicates inside a tier.
 */
export function assertTierNesting(tiers: CompressedTiersV1): void {
  let previous: ReadonlySet<string> | null = null;
  let previousName: string | null = null;
  for (const tierName of COMPRESSION_TIERS) {
    const ids = tiers.tiers[tierName].map((entry) => entry.signalId);
    const current = new Set(ids);
    if (current.size !== ids.length) {
      throw new AgentContractError(`tier ${tierName} contains duplicate signal ids`);
    }
    if (tierName === "ONE_THING" && ids.length !== 1) {
      throw new AgentContractError(
        `tier ONE_THING must contain exactly one signal (got ${ids.length})`,
      );
    }
    if (previous !== null && previousName !== null) {
      for (const id of previous) {
        if (!current.has(id)) {
          throw new AgentContractError(
            `tier ${tierName} drops ${id} from ${previousName}: nesting invariant violated`,
          );
        }
      }
    }
    previous = current;
    previousName = tierName;
  }
}
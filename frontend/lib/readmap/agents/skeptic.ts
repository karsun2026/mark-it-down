/**
 * Skeptic agent (spec §10.3).
 *
 * The Skeptic's honesty property is enforced at the INPUT boundary: it is
 * given exactly one candidate signal, its cited evidence, and nearby context —
 * never the whole document, never external knowledge (there is no tool access
 * at all). A candidate whose citations cannot be resolved fails before any
 * model call is made.
 */

import type { EvidenceBlockInput } from "../schemas/evidence";
import {
  SkepticVerdictV1Schema,
  type CandidateSignalV1,
  type SkepticVerdictV1,
} from "../schemas/signal";
import type { StructuredModelClient } from "../models/client";
import { AgentContractError } from "./contract";
import type { AgentRun } from "./run";
import { SKEPTIC_PROMPT_VERSION, SKEPTIC_SYSTEM_PROMPT } from "../prompts/skeptic";

/** Upper bound on nearby context blocks per verdict unit (bounded cost). */
export const NEARBY_CONTEXT_LIMIT = 8;

/**
 * Assemble the Skeptic's evidence set: the cited blocks first, then nearby
 * context — blocks sharing a page/slide or a section-path entry with a cited
 * block, nearest first, capped at NEARBY_CONTEXT_LIMIT.
 */
export function skepticEvidenceFor(
  signal: CandidateSignalV1,
  blocks: readonly EvidenceBlockInput[],
): EvidenceBlockInput[] {
  const byId = new Map(blocks.map((block) => [block.id, block]));
  const cited = signal.evidenceBlockIds.map((id) => {
    const block = byId.get(id);
    if (!block) {
      throw new AgentContractError(
        `candidate signal ${signal.id} cites block ${id} that is not available to the skeptic`,
      );
    }
    return block;
  });

  const citedIds = new Set(signal.evidenceBlockIds);
  const anchors = cited.map((block) => ({
    pageNumber: block.pageNumber,
    slideNumber: block.slideNumber,
    sectionPath: block.sectionPath,
  }));
  const nearby: EvidenceBlockInput[] = [];
  for (const block of blocks) {
    if (nearby.length >= NEARBY_CONTEXT_LIMIT) break;
    if (citedIds.has(block.id)) continue;
    const isNearby = anchors.some(
      (anchor) =>
        (anchor.pageNumber !== undefined && block.pageNumber === anchor.pageNumber) ||
        (anchor.slideNumber !== undefined && block.slideNumber === anchor.slideNumber) ||
        anchor.sectionPath.some((part) => block.sectionPath.includes(part)),
    );
    if (isNearby) nearby.push(block);
  }
  return [...cited, ...nearby];
}

export function runSkeptic(
  client: StructuredModelClient,
  input: { signal: CandidateSignalV1; blocks: readonly EvidenceBlockInput[]; idempotencyKey: string },
): Promise<AgentRun<SkepticVerdictV1>> {
  const evidence = skepticEvidenceFor(input.signal, input.blocks);
  const evidenceById = new Map(evidence.map((block) => [block.id, block]));
  const payload = {
    candidateSignal: {
      id: input.signal.id,
      claim: input.signal.claim,
      type: input.signal.type,
      evidenceBlockIds: input.signal.evidenceBlockIds,
      speakerOrAttribution: input.signal.speakerOrAttribution,
      epistemicStatus: input.signal.epistemicStatus,
      warnings: input.signal.warnings,
    },
    citedEvidence: input.signal.evidenceBlockIds.map((id) => ({
      id,
      text: evidenceById.get(id)?.normalizedText ?? "",
    })),
    nearbyContext: evidence
      .filter((block) => !input.signal.evidenceBlockIds.includes(block.id))
      .map((block) => ({ id: block.id, text: block.normalizedText })),
  };

  return client
    .generate({
      task: "skeptic",
      system: SKEPTIC_SYSTEM_PROMPT,
      messages: [{ role: "user", text: JSON.stringify(payload) }],
      schema: SkepticVerdictV1Schema,
      temperature: 0,
      idempotencyKey: input.idempotencyKey,
    })
    .then((result) => ({ result, promptVersion: SKEPTIC_PROMPT_VERSION }));
}
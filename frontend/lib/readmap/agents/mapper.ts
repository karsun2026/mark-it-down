/**
 * Mapper agent (spec §10.1).
 *
 * Thin on purpose: build the evidence summary, call the model client with the
 * versioned Mapper prompt and the `DocumentMapV1` contract, then run the
 * deterministic post-check the prompt demands (every mapped section path must
 * exist verbatim in the supplied evidence — no invented structure).
 */

import type { ConvertedDocumentV1, EvidenceBlockInput } from "../schemas/evidence";
import { DocumentMapV1Schema, type DocumentMapV1 } from "../schemas/signal";
import type { StructuredModelClient } from "../models/client";
import { AgentContractError } from "./contract";
import type { AgentRun } from "./run";
import { MAPPER_PROMPT_VERSION, MAPPER_SYSTEM_PROMPT } from "../prompts/mapper";

export interface MapperInput {
  document: ConvertedDocumentV1;
  idempotencyKey: string;
}

/** Block summaries given to the mapper: identity, anchors, and full text. */
export interface EvidenceBlockSummary {
  id: string;
  pageNumber?: number;
  slideNumber?: number;
  sectionPath: string[];
  blockType: EvidenceBlockInput["blockType"];
  text: string;
}

export function mapperPayload(
  blocks: readonly EvidenceBlockInput[],
): { blocks: EvidenceBlockSummary[] } {
  return {
    blocks: blocks.map((block) => ({
      id: block.id,
      pageNumber: block.pageNumber,
      slideNumber: block.slideNumber,
      sectionPath: block.sectionPath,
      blockType: block.blockType,
      text: block.normalizedText,
    })),
  };
}

/**
 * The prompt promises section paths exist in the evidence; this is the check.
 * A section path the model invented fails the unit — structure may not be
 * fabricated any more than facts may.
 */
export function validateMapSections(
  map: DocumentMapV1,
  blocks: readonly EvidenceBlockInput[],
): void {
  const knownPaths = new Set<string>();
  for (const block of blocks) {
    for (const part of block.sectionPath) knownPaths.add(part);
  }
  for (const section of map.sections) {
    for (const part of section.sectionPath) {
      if (!knownPaths.has(part)) {
        throw new AgentContractError(
          `mapper output section ${part} does not exist in the supplied evidence`,
        );
      }
    }
  }
}

export function runMapper(
  client: StructuredModelClient,
  input: MapperInput,
): Promise<AgentRun<DocumentMapV1>> {
  const payload = {
    document: {
      filename: input.document.document.filename,
      sourceType: input.document.document.sourceType,
      pagesOrSlides: input.document.document.pagesOrSlides,
      wordCount: input.document.document.wordCount,
      warnings: input.document.warnings,
    },
    ...mapperPayload(input.document.blocks),
  };

  return client
    .generate({
      task: "mapper",
      system: MAPPER_SYSTEM_PROMPT,
      messages: [{ role: "user", text: JSON.stringify(payload) }],
      schema: DocumentMapV1Schema,
      temperature: 0,
      idempotencyKey: input.idempotencyKey,
    })
    .then((result) => {
      validateMapSections(result.value, input.document.blocks);
      return { result, promptVersion: MAPPER_PROMPT_VERSION };
    });
}

// Re-exported for the grounding gate, tests, and the pipeline.
export { DocumentMapV1Schema, AgentContractError };
export type { ConvertedDocumentV1, EvidenceBlockInput };
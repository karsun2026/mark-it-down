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

/** The set of section-path elements that exist in the evidence. */
function knownSectionParts(blocks: readonly EvidenceBlockInput[]): Set<string> {
  const known = new Set<string>();
  for (const block of blocks) {
    for (const part of block.sectionPath) known.add(part);
  }
  return known;
}

/**
 * The evidence's own section anchor for a heading the model named. A reader
 * (and the model) names a section by its heading ("Executive Summary"); the
 * evidence's only anchors may be page markers ("Page 1"), because PDF
 * conversion exposes no semantic headings. If that heading appears verbatim in
 * a block's text, its section is real — return that block's section anchor so
 * the section can be rebound to it. A heading that appears nowhere is not real.
 */
function anchorForHeading(
  heading: string,
  blocks: readonly EvidenceBlockInput[],
): string[] | null {
  const needle = heading.trim().toLowerCase();
  if (needle.length === 0) return null;
  for (const block of blocks) {
    if (block.normalizedText.toLowerCase().includes(needle)) {
      return block.sectionPath;
    }
  }
  return null;
}

/**
 * Rebind model-named sections to the evidence's own section anchors. Each
 * section-path element that is already an evidence section (e.g. a Pandoc
 * heading from a DOCX, or a page anchor) is kept as-is; one that is not (a
 * PDF's prose heading like "Executive Summary") is resolved to the anchor of
 * the block whose text contains it, and the human name is preserved in
 * `purpose` so the reading guide still reads well. A heading that appears
 * nowhere in the document text is left untouched, so `validateMapSections`
 * fails it — the model may not fabricate structure.
 */
export function resolveSectionPaths(
  map: DocumentMapV1,
  blocks: readonly EvidenceBlockInput[],
): DocumentMapV1 {
  const known = knownSectionParts(blocks);
  const sections = map.sections.map((section) => {
    const resolved: string[] = [];
    const renamed: string[] = [];
    for (const part of section.sectionPath) {
      if (known.has(part)) {
        if (!resolved.includes(part)) resolved.push(part);
        continue;
      }
      const anchor = anchorForHeading(part, blocks);
      if (anchor && anchor.length > 0) {
        for (const a of anchor) if (!resolved.includes(a)) resolved.push(a);
        renamed.push(part);
      } else {
        // Unresolved: keep it so validateMapSections rejects the fabrication.
        resolved.push(part);
      }
    }
    const purpose =
      renamed.length > 0 && !section.purpose.startsWith(renamed[0] ?? "")
        ? `${renamed.join(" › ")} — ${section.purpose}`
        : section.purpose;
    return {
      ...section,
      sectionPath: resolved.length > 0 ? resolved : section.sectionPath,
      purpose,
    };
  });
  return { ...map, sections };
}

/** Distinct section-path elements the mapper output that are not in evidence. */
function invalidSectionParts(
  map: DocumentMapV1,
  blocks: readonly EvidenceBlockInput[],
): string[] {
  const known = knownSectionParts(blocks);
  const bad = new Set<string>();
  for (const section of map.sections) {
    for (const part of section.sectionPath) {
      if (!known.has(part)) bad.add(part);
    }
  }
  return [...bad];
}

/**
 * The prompt promises section paths exist in the evidence; this is the check,
 * run AFTER {@link resolveSectionPaths} has rebound real prose headings to
 * their evidence anchors. Anything still unknown is invented structure and
 * fails the unit — structure may not be fabricated any more than facts may.
 */
export function validateMapSections(
  map: DocumentMapV1,
  blocks: readonly EvidenceBlockInput[],
): void {
  const bad = invalidSectionParts(map, blocks);
  if (bad.length > 0) {
    throw new AgentContractError(
      `mapper output section ${bad[0]} does not exist in the supplied evidence`,
    );
  }
}

export function runMapper(
  client: StructuredModelClient,
  input: MapperInput,
): Promise<AgentRun<DocumentMapV1>> {
  const blocks = input.document.blocks;
  const payload = {
    document: {
      filename: input.document.document.filename,
      sourceType: input.document.document.sourceType,
      pagesOrSlides: input.document.document.pagesOrSlides,
      wordCount: input.document.document.wordCount,
      warnings: input.document.warnings,
    },
    ...mapperPayload(blocks),
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
      // Rebind the model's prose section names to the evidence's own anchors
      // (a PDF exposes only page anchors), then reject anything still invented.
      const value = resolveSectionPaths(result.value, blocks);
      validateMapSections(value, blocks);
      return { result: { ...result, value }, promptVersion: MAPPER_PROMPT_VERSION };
    });
}

// Re-exported for the grounding gate, tests, and the pipeline.
export { DocumentMapV1Schema, AgentContractError };
export type { ConvertedDocumentV1, EvidenceBlockInput };
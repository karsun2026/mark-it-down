/**
 * Zod schemas for the READMAP evidence layer (READMAP_MASTER_BUILD_SPEC §7,
 * §9; ADR-003 and ADR-004 in docs/readmap/ARCHITECTURE_DECISIONS.md).
 *
 * `ConvertedDocumentV1` is the versioned contract between the converter's
 * Markdown output and every READMAP agent downstream. It is deliberately
 * narrow: page/slide numbers are optional because DOCX output genuinely has
 * no page anchors, and a missing anchor must stay missing rather than be
 * invented.
 */

import { z } from "zod";

export const BlockTypeSchema = z.enum([
  "HEADING",
  "PARAGRAPH",
  "LIST",
  "TABLE",
  "CHART",
  "IMAGE",
  "FOOTNOTE",
]);
export type BlockType = z.infer<typeof BlockTypeSchema>;

export const ExtractionMethodSchema = z.enum([
  "MARKDOWN",
  "OCR",
  "TABLE",
  "VISION",
]);
export type ExtractionMethod = z.infer<typeof ExtractionMethodSchema>;

export const SourceTypeSchema = z.enum(["pdf", "pptx", "docx"]);
export type SourceType = z.infer<typeof SourceTypeSchema>;

export const EvidenceBlockInputSchema = z.object({
  /** Stable within one document: `b` + zero-padded sequence. */
  id: z.string().min(1),
  /** Present for PDF output (`## Page N`); absent for DOCX. */
  pageNumber: z.number().int().positive().optional(),
  /** Present for PPTX output (`## Slide N`). */
  slideNumber: z.number().int().positive().optional(),
  /** Heading hierarchy at the block's position, e.g. ["Market Study", "Findings"]. */
  sectionPath: z.array(z.string()),
  blockType: BlockTypeSchema,
  /** Whitespace-normalised text; wording is never altered. */
  normalizedText: z.string(),
  /** The exact source slice, kept for deterministic citation verification. */
  sourceText: z.string(),
  extractionMethods: z.array(ExtractionMethodSchema).min(1),
  /** SHA-256 of `sourceText`; tampering with either must be detectable. */
  contentHash: z.string().regex(/^[0-9a-f]{64}$/),
});
export type EvidenceBlockInput = z.infer<typeof EvidenceBlockInputSchema>;

export const ConvertedDocumentV1Schema = z.object({
  schemaVersion: z.literal("1.0"),
  document: z.object({
    filename: z.string().min(1),
    sourceType: SourceTypeSchema,
    /** Page count (PDF) / slide count (PPTX); null when unknown (DOCX). */
    pagesOrSlides: z.number().int().nonnegative().nullable(),
    wordCount: z.number().int().nonnegative(),
  }),
  blocks: z.array(EvidenceBlockInputSchema),
  /** Converter warnings plus this pipeline's own honest coverage signals. */
  warnings: z.array(z.string()),
});
export type ConvertedDocumentV1 = z.infer<typeof ConvertedDocumentV1Schema>;

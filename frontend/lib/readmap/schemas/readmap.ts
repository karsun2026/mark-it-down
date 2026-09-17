/**
 * Zod contract for the READMAP result itself (spec §7 "READMAP output").
 *
 * Every factual entry carries immutable `signalId`s — citations resolve
 * through the signal store, never through model-generated display text
 * (spec §7 closing rule). `kind` separates verified facts from agent
 * interpretation (rule 13): interpretation may appear ONLY in the
 * `interpretation` field, and the grounding gate enforces that.
 */

import { z } from "zod";

export const OutputClaimKindSchema = z.enum(["VERIFIED", "INTERPRETATION"]);
export type OutputClaimKind = z.infer<typeof OutputClaimKindSchema>;

export const OutputClaimSchema = z.object({
  text: z.string().min(1),
  /** One or more immutable signal ids; empty is illegal (spec §11.1). */
  signalIds: z.array(z.string().min(1)).min(1),
  kind: OutputClaimKindSchema,
});
export type OutputClaim = z.infer<typeof OutputClaimSchema>;

/**
 * Numbers are displayed verbatim with their signal citation. Independent
 * numeric validation is Phase 3 (spec §10.4/§11.4); Phase 1 numbers carry an
 * explicit UNVERIFIED status the UI must show — they are never labelled
 * "verified".
 */
export const OutputNumberSchema = z.object({
  signalIds: z.array(z.string().min(1)).min(1),
  text: z.string().min(1),
  numericStatus: z.literal("UNVERIFIED_PHASE_1"),
});
export type OutputNumber = z.infer<typeof OutputNumberSchema>;

export const PageRecommendationSchema = z.object({
  /** PDF/PPTX only; DOCX has no page anchors and must use sectionPath. */
  pages: z.object({ from: z.number().int().positive(), to: z.number().int().positive() }).optional(),
  sectionPath: z.array(z.string()).optional(),
  reason: z.string().min(1),
});
export type PageRecommendation = z.infer<typeof PageRecommendationSchema>;

export const DocumentShapeEntrySchema = z.object({
  sectionPath: z.array(z.string()).min(1),
  shape: z.string().min(1),
});
export type DocumentShapeEntry = z.infer<typeof DocumentShapeEntrySchema>;

export const ReadMapV1Schema = z.object({
  schemaVersion: z.literal("1.0"),
  jobId: z.string().min(1),
  coverage: z.object({
    readablePages: z.number().int().nonnegative(),
    totalPages: z.number().int().nonnegative(),
    ratio: z.number().min(0).max(1),
    limitations: z.array(z.string()),
  }),
  compression: z.object({
    originalWords: z.number().int().nonnegative(),
    originalReadingMinutes: z.number().int().nonnegative(),
    selectedPreset: z.enum(["DEEP_DIVE", "READMAP", "BRIEF", "QUICK_SCAN", "BRUTAL", "ONE_THING"]),
    outputWords: z.number().int().nonnegative(),
  }),
  thePoint: OutputClaimSchema,
  rememberThese: z.array(OutputClaimSchema),
  numbersWorthRemembering: z.array(OutputNumberSchema),
  caution: z.array(OutputClaimSchema),
  actuallyRead: z.array(PageRecommendationSchema),
  safelySkip: z.array(PageRecommendationSchema),
  documentShape: z.array(DocumentShapeEntrySchema),
  /** Interpretation claims only — never mixed into the fields above. */
  interpretation: z.array(OutputClaimSchema).optional(),
});
export type ReadMapV1 = z.infer<typeof ReadMapV1Schema>;
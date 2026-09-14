/**
 * Zod contracts for the READMAP agent layer (spec §7 "Signal", §10 agent
 * contracts; Phase 1 plan §8).
 *
 * These schemas are what the MODEL must return — the agents hand them to the
 * model client, which validates output against them (spec §10: structured
 * output, one repair attempt, then the unit fails). Deterministic post-checks
 * that Zod cannot express (verbatim quotes, tier nesting) live beside the
 * agents and fail the unit loudly.
 *
 * Signal ids are NEVER model output: the Signal Extractor assigns
 * deterministic ids (`s0001`, ...) after validation, so a signal's identity
 * is a pipeline fact that citations and the grounding gate can rely on.
 */

import { z } from "zod";

/** Signal categories from spec §7. */
export const SignalTypeSchema = z.enum([
  "QUANTITATIVE",
  "FINDING",
  "DECISION",
  "ACTION",
  "RISK",
  "FORECAST",
  "RECOMMENDATION",
  "CONTRADICTION",
]);
export type SignalType = z.infer<typeof SignalTypeSchema>;

/**
 * Candidate signals come FROM the document, so `AGENT_INTERPRETATION` is not
 * a legal candidate status — interpretation is a separate, visibly labelled
 * output kind (rule 13). The full status enum gains AGENT_INTERPRETATION only
 * on derived/interpretation records later in the pipeline.
 */
export const CandidateEpistemicStatusSchema = z.enum([
  "STATED_FACT",
  "SOURCE_OPINION",
  "FORECAST",
]);
export type CandidateEpistemicStatus = z.infer<typeof CandidateEpistemicStatusSchema>;

/** Skeptic verdicts, exactly the four spec §10.3 values. */
export const VerdictSchema = z.enum([
  "SUPPORTED",
  "PARTIAL",
  "UNSUPPORTED",
  "CONTRADICTED",
]);
export type Verdict = z.infer<typeof VerdictSchema>;

export const EvidenceQuoteSchema = z.object({
  blockId: z.string().min(1),
  /** The minimum source span supporting the claim, verbatim. */
  quote: z.string().min(1),
});
export type EvidenceQuote = z.infer<typeof EvidenceQuoteSchema>;

/** One Signal Extractor unit of output (model-facing; no id). */
export const CandidateSignalOutputSchema = z.object({
  claim: z.string().min(1),
  type: SignalTypeSchema,
  evidenceBlockIds: z.array(z.string().min(1)).min(1),
  evidenceQuotes: z.array(EvidenceQuoteSchema).min(1),
  speakerOrAttribution: z.string().optional(),
  epistemicStatus: CandidateEpistemicStatusSchema,
  /** Honest gap flags, e.g. missing year/unit/denominator (spec §10.2). */
  warnings: z.array(z.string()),
});
export type CandidateSignalOutput = z.infer<typeof CandidateSignalOutputSchema>;

/** The batch schema the extractor's model call must satisfy. */
export const CandidateSignalBatchV1Schema = z.object({
  signals: z.array(CandidateSignalOutputSchema),
});
export type CandidateSignalBatchV1 = z.infer<typeof CandidateSignalBatchV1Schema>;

/** A candidate signal after deterministic id assignment (pipeline-facing). */
export const CandidateSignalV1Schema = CandidateSignalOutputSchema.extend({
  /** `s` + zero-padded sequence, stable within one document/version. */
  id: z.string().regex(/^s\d{4}$/),
});
export type CandidateSignalV1 = z.infer<typeof CandidateSignalV1Schema>;

/** Mapper output (spec §10.1): structure, thesis candidates, section values. */
export const DocumentMapV1Schema = z.object({
  documentType: z.string().min(1),
  mainThesisCandidates: z.array(z.string().min(1)).min(1),
  sections: z
    .array(
      z.object({
        sectionPath: z.array(z.string()).min(1),
        purpose: z.string().min(1),
        signalDensity: z.enum(["HIGH", "MEDIUM", "LOW"]),
        value: z.enum(["HIGH_VALUE", "LOW_VALUE"]),
      }),
    )
    .min(1),
  warnings: z.array(z.string()),
});
export type DocumentMapV1 = z.infer<typeof DocumentMapV1Schema>;

/** Skeptic output (spec §10.3): verdict + explanation code + optional repair. */
export const SkepticVerdictV1Schema = z
  .object({
    verdict: VerdictSchema,
    /** Stable explanation code, e.g. `OK`, `OVERREACH`, `MISSING_PERIOD`. */
    explanationCode: z.string().min(1),
    explanation: z.string().min(1),
    /** Only a PARTIAL verdict may carry a repaired claim. */
    repairedClaim: z.string().optional(),
  })
  .refine(
    (verdict) =>
      verdict.verdict === "PARTIAL"
        ? verdict.repairedClaim !== undefined
        : verdict.repairedClaim === undefined,
    {
      message:
        "repairedClaim is required exactly when the verdict is PARTIAL (spec §10.3)",
    },
  );
export type SkepticVerdictV1 = z.infer<typeof SkepticVerdictV1Schema>;

/** Reading-depth presets; the tier names double as preset names (spec §1). */
export const COMPRESSION_TIERS = [
  "ONE_THING",
  "BRUTAL",
  "QUICK_SCAN",
  "BRIEF",
  "READMAP",
  "DEEP_DIVE",
] as const;
export type CompressionTier = (typeof COMPRESSION_TIERS)[number];
export const CompressionPresetSchema = z.enum(COMPRESSION_TIERS);
export type CompressionPreset = z.infer<typeof CompressionPresetSchema>;

export const TierEntrySchema = z.object({
  signalId: z.string().min(1),
  /** Concise rendering of that signal at this depth; no new propositions. */
  text: z.string().min(1),
});
export type TierEntry = z.infer<typeof TierEntrySchema>;

/** Compressor output: selections + renderings for every nested tier. */
export const CompressedTiersV1Schema = z.object({
  tiers: z.object({
    ONE_THING: z.array(TierEntrySchema),
    BRUTAL: z.array(TierEntrySchema),
    QUICK_SCAN: z.array(TierEntrySchema),
    BRIEF: z.array(TierEntrySchema),
    READMAP: z.array(TierEntrySchema),
    DEEP_DIVE: z.array(TierEntrySchema),
  }),
});
export type CompressedTiersV1 = z.infer<typeof CompressedTiersV1Schema>;
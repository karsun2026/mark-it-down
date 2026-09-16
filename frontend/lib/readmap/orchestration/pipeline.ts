/**
 * The READMAP pipeline (plan §4–§5): sequences Mapper → Signal Extractor →
 * Skeptic → Compressor over one `ConvertedDocumentV1`, then validates the
 * assembled result through the deterministic grounding gate.
 *
 * Honesty properties, all in code:
 *
 * - `evidence.v1.json` is persisted BEFORE any model call (plan §5: the
 *   evidence snapshot is immutable and must exist even if analysis dies).
 * - Stage status is published per plan §4 with fixed, honest progress values;
 *   publishing is best-effort and never fails the job.
 * - Every model unit runs under an idempotency key derived from
 *   (checksum, pipeline version, stage, unit id) so retries never re-bill.
 * - Bounded units: extraction runs on bounded chunks, verdicts one per
 *   candidate, and the candidate count is capped with a visible warning.
 * - Gate failures are repaired by omission, at most ONE round; if thePoint
 *   itself cannot be validated, the job fails — a wrong core conclusion is
 *   never shipped.
 * - No document content is ever logged (rule 16); status carries ids/counts.
 */

import type { ConvertedDocumentV1, EvidenceBlockInput } from "../schemas/evidence";
import type {
  CandidateSignalV1,
  CompressedTiersV1,
  DocumentMapV1,
  VerifiedSignalV1,
} from "../schemas/signal";
import {
  effectiveClaim,
  isUsableSignal,
} from "../schemas/signal";
import type { ReadMapV1 } from "../schemas/readmap";
import type {
  ReadMapStatusV1,
  ReadMapTerminalState,
  ReadmapStage,
} from "../schemas/status";
import { STAGE_PROGRESS } from "../schemas/status";
import type { AgentTask, ModelUsage, StructuredModelClient } from "../models/client";
import { runMapper } from "../agents/mapper";
import { runSignalExtractor, assignSignalIds } from "../agents/signal-extractor";
import { runSkeptic } from "../agents/skeptic";
import { runCompressor } from "../agents/compressor";
import { runGroundingGate, type GroundingReport } from "../grounding/grounding-gate";
import { deriveStageKey } from "./stages";

/** Max evidence blocks per extraction unit (bounded cost per call). */
export const MAX_BLOCKS_PER_CHUNK = 12;
/**
 * Hard cap on candidate signals per job, with a visible warning when hit.
 * Lowered from 100 to 40 for the Phase-1 vertical slice (review §6-C3): the
 * durable fix is the resumable-stage split of ADR-005, which needs the
 * per-unit checkpoints (§6-C2, now wired).
 */
export const MAX_CANDIDATE_SIGNALS = 40;
/** Default depth tier the result renders first (slider never calls a model). */
export const DEFAULT_PRESET = "READMAP" as const;
/**
 * Concurrent skeptic calls during VERIFYING (review §6-C3). Kept small to
 * respect provider rate limits; order is preserved by `mapWithConcurrency`.
 */
export const VERIFY_CONCURRENCY = 6;

/**
 * Per-unit checkpoint store (review §6-C2): keyed by the exact
 * `deriveStageKey` idempotency key, so a retried or resumed run reuses
 * previous unit results instead of re-billing them.
 */
export interface UnitCheckpoint {
  get<T>(key: string): Promise<T | null>;
  put(key: string, value: unknown): Promise<void>;
}

/**
 * Rough per-token cost estimate in USD used ONLY for the
 * READMAP_MAX_JOB_COST_USD budget guard (review §6-L2). Conservative upper
 * bound for the gemini-2.5-flash family; never displayed as a fact — only
 * the "budget reached" limitation is user-visible.
 */
const ESTIMATED_INPUT_COST_PER_TOKEN_USD = 0.3e-6;
const ESTIMATED_OUTPUT_COST_PER_TOKEN_USD = 2.5e-6;

function estimateUsageCostUsd(usage: ModelUsage): number {
  return (
    usage.inputTokens * ESTIMATED_INPUT_COST_PER_TOKEN_USD +
    usage.outputTokens * ESTIMATED_OUTPUT_COST_PER_TOKEN_USD
  );
}

function maxJobCostUsd(): number | null {
  const raw = process.env.READMAP_MAX_JOB_COST_USD;
  if (!raw) return null;
  const parsed = Number.parseFloat(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

export interface ReadmapPipelineInput {
  jobId: string;
  checksumSha256: string;
  document: ConvertedDocumentV1;
  getClient: (task: AgentTask) => StructuredModelClient;
  onStage?: (status: ReadMapStatusV1) => void;
  /** ADR-004 artifact writer (Blob in production; injectable for tests). */
  persistArtifact?: (name: string, value: unknown) => Promise<void>;
  /**
   * Per-unit checkpoint store (§6-C2). Before each model unit the pipeline
   * consults it under the unit's idempotency key; a hit skips the model call
   * entirely, so a retry never re-bills a unit that already completed.
   */
  checkpoint?: UnitCheckpoint;
}

export interface ReadmapPipelineResult {
  status: ReadMapTerminalState;
  readmap?: ReadMapV1;
  signals: VerifiedSignalV1[];
  tiers?: CompressedTiersV1;
  gate: GroundingReport | null;
  usage: ModelUsage;
  warnings: string[];
  failedStage?: ReadmapStage;
}

type StatusPublisher = (
  stage: ReadmapStage | ReadMapTerminalState,
  options?: { unitsDone?: number; unitsTotal?: number; failure?: string; warnings?: string[] },
) => void;

function buildStatus(
  jobId: string,
  stage: ReadMapStatusV1["stage"],
  progress: number,
  options?: { unitsDone?: number; unitsTotal?: number; failure?: string; warnings?: string[] },
): ReadMapStatusV1 {
  return {
    schemaVersion: "1.0",
    jobId,
    stage,
    progress,
    unitsDone: options?.unitsDone ?? 0,
    unitsTotal: options?.unitsTotal ?? 0,
    updatedAt: new Date().toISOString(),
    warnings: options?.warnings ?? [],
    ...(options?.failure ? { failure: options.failure } : {}),
  };
}

function publisherFor(input: ReadmapPipelineInput): StatusPublisher {
  return (stage, options) => {
    if (!input.onStage) return;
    const isTerminal = stage === "READY" || stage === "PARTIAL_READY" || stage === "FAILED";
    const status = buildStatus(input.jobId, stage, isTerminal ? 1 : STAGE_PROGRESS[stage as ReadmapStage], options);
    // Best-effort, never-fail-the-job semantics (D-002 precedent).
    try {
      input.onStage(status);
    } catch {
      // Swallowed deliberately: a status-publishing fault must never take the
      // job down. The stage markers are advisory; the result is authoritative.
    }
  };
}

/** Consecutive blocks, split on section change and size ceiling. */
export function chunkBlocks(
  blocks: readonly EvidenceBlockInput[],
  maxBlocksPerChunk: number = MAX_BLOCKS_PER_CHUNK,
): EvidenceBlockInput[][] {
  const chunks: EvidenceBlockInput[][] = [];
  let current: EvidenceBlockInput[] = [];
  let currentSection: string | null = null;
  for (const block of blocks) {
    const section = block.sectionPath[0] ?? "";
    const boundaryChanged =
      current.length > 0 && (section !== currentSection || current.length >= maxBlocksPerChunk);
    if (boundaryChanged) {
      chunks.push(current);
      current = [];
    }
    currentSection = section;
    current.push(block);
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

/** Run `fn` over items with a bounded number of in-flight calls, preserving order. */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  async function worker(): Promise<void> {
    while (true) {
      const index = cursor++;
      if (index >= items.length) return;
      results[index] = await fn(items[index] as T, index);
    }
  }
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker);
  await Promise.all(workers);
  return results;
}

// ---------------------------------------------------------------------------
// Result assembly (deterministic — no model calls)
// ---------------------------------------------------------------------------

/** Assemble the READMAP from verified signals, tiers, and the mapper output. */
export function assembleReadmap(input: {
  jobId: string;
  document: ConvertedDocumentV1;
  map: DocumentMapV1;
  signals: readonly VerifiedSignalV1[];
  tiers: CompressedTiersV1;
  extraWarnings: readonly string[];
}): ReadMapV1 {
  const { map, tiers } = input;
  const usable = input.signals.filter(isUsableSignal);
  const usableById = new Map(usable.map((signal) => [signal.id, signal]));

  const readTier = tiers.tiers[DEFAULT_PRESET];

  // thePoint must resolve to a USABLE signal, or the gate hard-fails the job
  // (SIGNAL_NOT_USABLE at thePoint is unrepairable, review §6-M3). Fall
  // through to the honest fallback when no tier entry cites a usable signal.
  const oneThing = readTier.find((entry) => usableById.has(entry.signalId));
  const rememberThese = readTier
    .slice(1)
    .filter((entry) => usableById.has(entry.signalId))
    .map((entry) => ({
      text: entry.text,
      signalIds: [entry.signalId],
      kind: "VERIFIED" as const,
    }));

  const numbersWorthRemembering = usable
    .filter((signal) => signal.type === "QUANTITATIVE")
    .map((signal) => ({
      signalIds: [signal.id],
      text: effectiveClaim(signal),
      numericStatus: "UNVERIFIED_PHASE_1" as const,
    }));

  const caution = usable
    .filter((signal) => signal.type === "RISK" || signal.type === "CONTRADICTION")
    .map((signal) => ({
      text: effectiveClaim(signal),
      signalIds: [signal.id],
      kind: "VERIFIED" as const,
    }));

  // Coverage: page/slide-anchored when anchors exist; word-level otherwise,
  // and that limitation is disclosed rather than hidden.
  const blocks = input.document.blocks;
  const hasAnchors = blocks.some((b) => b.pageNumber !== undefined || b.slideNumber !== undefined);
  const anchorValues = new Set<number>();
  for (const block of blocks) {
    if (block.pageNumber !== undefined) anchorValues.add(block.pageNumber);
    if (block.slideNumber !== undefined) anchorValues.add(block.slideNumber);
  }
  const totalPages = hasAnchors
    ? (input.document.document.pagesOrSlides ?? anchorValues.size)
    : 1;
  const readablePages = hasAnchors ? anchorValues.size : 1;
  const ratio = totalPages > 0 ? Math.min(1, readablePages / totalPages) : 1;
  const limitations = [
    ...input.document.warnings,
    ...input.extraWarnings,
    ...(hasAnchors
      ? []
      : ["No page or slide anchors in the converted text; coverage is document-level, not page-level."]),
  ];

  const compression = {
    originalWords: input.document.document.wordCount,
    originalReadingMinutes: Math.ceil(input.document.document.wordCount / 200),
    selectedPreset: DEFAULT_PRESET,
    outputWords: readTier.reduce((sum, entry) => {
      const words = entry.text.trim();
      return sum + (words.length === 0 ? 0 : words.split(/\s+/).length);
    }, 0),
  };

  const actuallyRead = map.sections
    .filter((section) => section.value === "HIGH_VALUE")
    .slice(0, 5)
    .map((section) => recommendationFor(section.sectionPath, blocks, "high signal density"));
  const safelySkip = map.sections
    .filter((section) => section.value === "LOW_VALUE")
    .slice(0, 5)
    .map((section) => recommendationFor(section.sectionPath, blocks, "low signal density"));

  return {
    schemaVersion: "1.0",
    jobId: input.jobId,
    coverage: {
      readablePages,
      totalPages,
      ratio,
      limitations,
    },
    compression,
    thePoint: oneThing
      ? { text: oneThing.text, signalIds: [oneThing.signalId], kind: "VERIFIED" as const }
      : { text: "No core conclusion could be verified.", signalIds: usable[0]?.id ? [usable[0].id] : [], kind: "VERIFIED" as const },
    rememberThese,
    numbersWorthRemembering,
    caution,
    actuallyRead,
    safelySkip,
    documentShape: map.sections.map((section) => ({
      sectionPath: section.sectionPath,
      shape: section.purpose,
    })),
  };
}

/** Real page range for a section when anchors exist; section path otherwise. */
function recommendationFor(
  sectionPath: readonly string[],
  blocks: readonly EvidenceBlockInput[],
  reason: string,
): { pages?: { from: number; to: number }; sectionPath?: string[]; reason: string } {
  const inSection = blocks.filter(
    (block) =>
      block.pageNumber !== undefined &&
      sectionPath.some((part) => block.sectionPath.includes(part)),
  );
  if (inSection.length > 0) {
    const pages = inSection
      .map((block) => block.pageNumber as number)
      .filter((page): page is number => page !== undefined);
    if (pages.length > 0) {
      return {
        pages: { from: Math.min(...pages), to: Math.max(...pages) },
        reason,
      };
    }
  }
  return { sectionPath: [...sectionPath], reason };
}

/** Repair by omission: drop the located entries the gate flagged. */
export function omitGateFailures(
  readmap: ReadMapV1,
  failures: readonly { code: string; location: string }[],
): ReadMapV1 | null {
  for (const f of failures) {
    const match = f.location.match(/^(\w+)\[(\d+)\]$/);
    if (!match) continue;
    const [, field, rawIndex] = match;
    if (field === "thePoint") return null; // unrepairable: a wrong core
    const index = Number.parseInt(rawIndex ?? "-1", 10);
    if (field === "rememberThese") {
      readmap.rememberThese = readmap.rememberThese.filter((_, i) => i !== index);
    } else if (field === "caution") {
      readmap.caution = readmap.caution.filter((_, i) => i !== index);
    } else if (field === "numbersWorthRemembering") {
      readmap.numbersWorthRemembering = readmap.numbersWorthRemembering.filter(
        (_, i) => i !== index,
      );
    } else if (field === "actuallyRead") {
      readmap.actuallyRead = readmap.actuallyRead.filter((_, i) => i !== index);
    } else if (field === "safelySkip") {
      readmap.safelySkip = readmap.safelySkip.filter((_, i) => i !== index);
    }
  }
  return readmap;
}

function failureResult(
  publish: (
    stage: ReadMapStatusV1["stage"],
    options?: { failure?: string; warnings?: string[] },
  ) => void,
  partial: {
    signals: VerifiedSignalV1[];
    tiers?: CompressedTiersV1;
    gate: GroundingReport | null;
    usage: ModelUsage;
    warnings: string[];
  },
): ReadmapPipelineResult {
  publish("FAILED", { failure: "grounding gate refused the output" });
  return {
    status: "FAILED",
    readmap: undefined,
    signals: partial.signals,
    tiers: partial.tiers,
    gate: partial.gate,
    usage: partial.usage,
    warnings: partial.warnings,
    failedStage: "GROUNDING",
  };
}

function addUsage(total: ModelUsage, addition: ModelUsage): void {
  total.inputTokens += addition.inputTokens;
  total.outputTokens += addition.outputTokens;
}

/**
 * Run one model unit under its checkpoint key (§6-C2): a checkpoint hit
 * reuses the stored value and reports ZERO usage — the tokens were already
 * spent and billed on the run that produced the checkpoint, so a retry does
 * not re-bill. Checkpoint store faults are swallowed: checkpointing is an
 * optimization and must never fail the job.
 */
async function cachedUnit<V>(
  checkpoint: UnitCheckpoint | undefined,
  key: string,
  call: () => Promise<{ value: V; usage: ModelUsage }>,
): Promise<{ value: V; usage: ModelUsage }> {
  if (checkpoint) {
    try {
      const hit = await checkpoint.get<{ value: V }>(key);
      if (hit && typeof hit === "object" && "value" in hit) {
        return { value: hit.value, usage: { inputTokens: 0, outputTokens: 0 } };
      }
    } catch {
      // A unreadable checkpoint degrades to a fresh (billed) call.
    }
  }
  const fresh = await call();
  if (checkpoint) {
    try {
      await checkpoint.put(key, { value: fresh.value });
    } catch {
      // An unstorable checkpoint only costs the next retry, not this job.
    }
  }
  return fresh;
}

/**
 * READMAP_MAX_JOB_COST_USD guard (review §6-L2): when the estimated spend of
 * this run reaches the configured cap, later model units are skipped and a
 * disclosed limitation is added — the job ends PARTIAL_READY, never silently
 * over budget. Absent/invalid configuration disables the guard.
 */
function budgetReached(usage: ModelUsage, warnings: string[]): boolean {
  const cap = maxJobCostUsd();
  if (cap === null) return false;
  if (estimateUsageCostUsd(usage) < cap) return false;
  const notice =
    "READMAP_MAX_JOB_COST_USD budget reached; analysis stopped early and this result is partial.";
  if (!warnings.includes(notice)) warnings.push(notice);
  return true;
}

async function persist(
  persistArtifact: ReadmapPipelineInput["persistArtifact"] | undefined,
  name: string,
  value: unknown,
): Promise<void> {
  if (!persistArtifact) return;
  // A persistence failure must fail the job, not silently continue without
  // the immutable evidence snapshot.
  await persistArtifact(name, value);
}

export async function runReadmapPipeline(
  input: ReadmapPipelineInput,
): Promise<ReadmapPipelineResult> {
  const publish = publisherFor(input);
  const usage: ModelUsage = { inputTokens: 0, outputTokens: 0 };
  const warnings: string[] = [];
  let currentStage: ReadmapStage = "SEGMENTING";

  try {
    // SEGMENTING — persist the evidence snapshot BEFORE any model call (§5):
    // even if analysis dies here, the immutable evidence exists.
    currentStage = "SEGMENTING"; publish("SEGMENTING");
    await persist(input.persistArtifact, "evidence.v1.json", input.document);

    // MAPPING
    currentStage = "MAPPING"; publish("MAPPING");
    const mapper = await cachedUnit(
      input.checkpoint,
      deriveStageKey({
        checksumSha256: input.checksumSha256,
        stage: "MAPPING",
        unitId: "whole",
      }),
      async () => {
        const run = await runMapper(input.getClient("mapper"), {
          document: input.document,
          idempotencyKey: deriveStageKey({
            checksumSha256: input.checksumSha256,
            stage: "MAPPING",
            unitId: "whole",
          }),
        });
        return { value: run.result.value, usage: run.result.usage };
      },
    );
    addUsage(usage, mapper.usage);

    // EXTRACTING — bounded chunks, sequential, honest unit progress.
    currentStage = "EXTRACTING"; publish("EXTRACTING");
    const chunks = chunkBlocks(input.document.blocks);
    const rawCandidates: CandidateSignalV1[] = [];
    for (const [index, chunk] of chunks.entries()) {
      if (budgetReached(usage, warnings)) break;
      const chunkKey = deriveStageKey({
        checksumSha256: input.checksumSha256,
        stage: "EXTRACTING",
        unitId: `chunk${index + 1}`,
      });
      const unit = await cachedUnit(
        input.checkpoint,
        chunkKey,
        async () => {
          const run = await runSignalExtractor(input.getClient("signal-extraction"), {
            blocks: chunk,
            idempotencyKey: chunkKey,
          });
          return { value: run.result.value, usage: run.result.usage };
        },
      );
      addUsage(usage, unit.usage);
      for (const signal of unit.value.signals) {
        if (rawCandidates.length >= MAX_CANDIDATE_SIGNALS) {
          if (rawCandidates.length === MAX_CANDIDATE_SIGNALS) {
            warnings.push(
              `Candidate signal cap (${MAX_CANDIDATE_SIGNALS}) reached; remaining sections skipped and disclosed.`,
            );
          }
          break;
        }
        rawCandidates.push(signal);
      }
      publish("EXTRACTING", { unitsDone: index + 1, unitsTotal: chunks.length });
    }
    // Ids are re-assigned globally AFTER all chunks, so a signal's identity is
    // unique across the document, not just within one chunk.
    const candidates = assignSignalIds(rawCandidates);

    // VERIFYING — one bounded skeptic unit per candidate, run with a small
    // concurrency limit (§6-C3) so a real document fits the function ceiling.
    // Order is preserved by mapWithConcurrency; addUsage/verifiedCount
    // mutations are safe (JS is single-threaded; each await resumes atomically).
    currentStage = "VERIFYING"; publish("VERIFYING", { unitsTotal: candidates.length });
    let verifiedCount = 0;
    const verifiedOrNull: (VerifiedSignalV1 | null)[] = await mapWithConcurrency(
      candidates,
      VERIFY_CONCURRENCY,
      async (candidate): Promise<VerifiedSignalV1 | null> => {
        const verifyKey = deriveStageKey({
          checksumSha256: input.checksumSha256,
          stage: "VERIFYING",
          unitId: candidate.id,
        });
        // Budget guard: a candidate past the cap is skipped (not verified)
        // rather than silently over-spending; the limitation is disclosed.
        if (budgetReached(usage, warnings)) {
          return null;
        }
        const unit = await cachedUnit(
          input.checkpoint,
          verifyKey,
          async () => {
            const run = await runSkeptic(input.getClient("skeptic"), {
              signal: candidate,
              blocks: input.document.blocks,
              idempotencyKey: verifyKey,
            });
            return { value: run.result.value, usage: run.result.usage };
          },
        );
        addUsage(usage, unit.usage);
        verifiedCount += 1;
        publish("VERIFYING", { unitsDone: verifiedCount, unitsTotal: candidates.length });
        return {
          ...candidate,
          skepticVerdict: unit.value.verdict,
          explanationCode: unit.value.explanationCode,
          explanation: unit.value.explanation,
          repairedClaim: unit.value.repairedClaim,
        };
      },
    );
    const signals: VerifiedSignalV1[] = verifiedOrNull.filter(
      (entry): entry is VerifiedSignalV1 => entry !== null,
    );
    await persist(input.persistArtifact, "signals.v1.json", signals);

    // COMPRESSING — only verified signals, all tiers in one unit.
    currentStage = "COMPRESSING"; publish("COMPRESSING");
    const usable = signals.filter(isUsableSignal);
    const compressorKey = deriveStageKey({
      checksumSha256: input.checksumSha256,
      stage: "COMPRESSING",
      unitId: "whole",
    });
    const compressorUnit = await cachedUnit(
      input.checkpoint,
      compressorKey,
      async () => {
        const run = await runCompressor(input.getClient("compression"), {
          verified: usable.map((signal) => ({
            id: signal.id,
            claim: effectiveClaim(signal),
            epistemicStatus: signal.epistemicStatus,
          })),
          documentMap: mapper.value,
          idempotencyKey: compressorKey,
        });
        return { value: run.result.value, usage: run.result.usage };
      },
    );
    addUsage(usage, compressorUnit.usage);
    const tiers = compressorUnit.value;
    await persist(input.persistArtifact, "tiers.v1.json", tiers);

    // GROUNDING — assemble deterministically, gate, repair by omission once.
    currentStage = "GROUNDING"; publish("GROUNDING");
    const readmap = assembleReadmap({
      jobId: input.jobId,
      document: input.document,
      map: mapper.value,
      signals,
      tiers,
      extraWarnings: warnings,
    });
    let gate = runGroundingGate({
      readmap,
      signals,
      evidence: input.document.blocks,
      tiers,
    });
    let finalReadmap = readmap;
    if (!gate.passed) {
      const repaired = omitGateFailures(readmap, gate.failures);
      if (repaired === null) {
        // thePoint is unrepairable — a wrong core conclusion never ships.
        return failureResult(publish, {
          signals,
          tiers,
          gate,
          usage,
          warnings,
        });
      }
      const recheck = runGroundingGate({
        readmap: repaired,
        signals,
        evidence: input.document.blocks,
        tiers,
      });
      if (!recheck.passed) {
        return failureResult(publish, {
          signals,
          tiers,
          gate: recheck,
          usage,
          warnings,
        });
      }
      finalReadmap = repaired;
      gate = recheck; // §6-L3: reuse the recheck — no third gate run.
      warnings.push("Some entries were omitted for failing grounding checks.");
    }
    await persist(input.persistArtifact, "readmap.v1.json", finalReadmap);

    // `gate` was computed on exactly `finalReadmap` (either the initial run or
    // the post-repair recheck) — a third identical gate pass is redundant
    // (review §6-L3).
    const gated = gate;
    const status: ReadMapTerminalState =
      gated.passed &&
      finalReadmap.coverage.ratio >= 0.95 &&
      finalReadmap.coverage.limitations.length === 0
        ? "READY"
        : "PARTIAL_READY";
    publish(status, { warnings: finalReadmap.coverage.limitations });
    return {
      status,
      readmap: finalReadmap,
      signals,
      tiers,
      gate: gated,
      usage,
      warnings: finalReadmap.coverage.limitations,
    };
  } catch (error) {
    // Any agent/persistence failure ends the job honestly at the stage it
    // reached; the message is shape-only (rule 16) and is never logged here —
    // the route layer owns logging and carries ids/counters only.
    publish("FAILED", { failure: "pipeline failure at an internal stage" });
    return {
      status: "FAILED",
      signals: [],
      gate: null,
      usage,
      warnings,
      failedStage: currentStage,
    };
  }
}
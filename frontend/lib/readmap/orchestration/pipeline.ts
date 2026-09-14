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
/** Hard cap on candidate signals per job, with a visible warning when hit. */
export const MAX_CANDIDATE_SIGNALS = 100;
/** Default depth tier the result renders first (slider never calls a model). */
export const DEFAULT_PRESET = "READMAP" as const;

export interface ReadmapPipelineInput {
  jobId: string;
  checksumSha256: string;
  document: ConvertedDocumentV1;
  getClient: (task: AgentTask) => StructuredModelClient;
  onStage?: (status: ReadMapStatusV1) => void;
  /** ADR-004 artifact writer (Blob in production; injectable for tests). */
  persistArtifact?: (name: string, value: unknown) => Promise<void>;
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

  const oneThing = readTier[0];
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
    const mapperRun = await runMapper(input.getClient("mapper"), {
      document: input.document,
      idempotencyKey: deriveStageKey({
        checksumSha256: input.checksumSha256,
        stage: "MAPPING",
        unitId: "whole",
      }),
    });
    addUsage(usage, mapperRun.result.usage);

    // EXTRACTING — bounded chunks, sequential, honest unit progress.
    currentStage = "EXTRACTING"; publish("EXTRACTING");
    const chunks = chunkBlocks(input.document.blocks);
    const rawCandidates: CandidateSignalV1[] = [];
    for (const [index, chunk] of chunks.entries()) {
      const run = await runSignalExtractor(input.getClient("signal-extraction"), {
        blocks: chunk,
        idempotencyKey: deriveStageKey({
          checksumSha256: input.checksumSha256,
          stage: "EXTRACTING",
          unitId: `chunk${index + 1}`,
        }),
      });
      addUsage(usage, run.result.usage);
      for (const signal of run.result.value.signals) {
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

    // VERIFYING — one bounded skeptic unit per candidate.
    currentStage = "VERIFYING"; publish("VERIFYING", { unitsTotal: candidates.length });
    const signals: VerifiedSignalV1[] = [];
    for (const [index, candidate] of candidates.entries()) {
      const run = await runSkeptic(input.getClient("skeptic"), {
        signal: candidate,
        blocks: input.document.blocks,
        idempotencyKey: deriveStageKey({
          checksumSha256: input.checksumSha256,
          stage: "VERIFYING",
          unitId: candidate.id,
        }),
      });
      addUsage(usage, run.result.usage);
      signals.push({
        ...candidate,
        skepticVerdict: run.result.value.verdict,
        explanationCode: run.result.value.explanationCode,
        explanation: run.result.value.explanation,
        repairedClaim: run.result.value.repairedClaim,
      });
      currentStage = "VERIFYING"; publish("VERIFYING", { unitsDone: index + 1, unitsTotal: candidates.length });
    }
    await persist(input.persistArtifact, "signals.v1.json", signals);

    // COMPRESSING — only verified signals, all tiers in one unit.
    currentStage = "COMPRESSING"; publish("COMPRESSING");
    const usable = signals.filter(isUsableSignal);
    const compressorRun = await runCompressor(input.getClient("compression"), {
      verified: usable.map((signal) => ({
        id: signal.id,
        claim: effectiveClaim(signal),
        epistemicStatus: signal.epistemicStatus,
      })),
      documentMap: mapperRun.result.value,
      idempotencyKey: deriveStageKey({
        checksumSha256: input.checksumSha256,
        stage: "COMPRESSING",
        unitId: "whole",
      }),
    });
    addUsage(usage, compressorRun.result.usage);
    const tiers = compressorRun.result.value;

    // GROUNDING — assemble deterministically, gate, repair by omission once.
    currentStage = "GROUNDING"; publish("GROUNDING");
    const readmap = assembleReadmap({
      jobId: input.jobId,
      document: input.document,
      map: mapperRun.result.value,
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
      warnings.push("Some entries were omitted for failing grounding checks.");
    }
    await persist(input.persistArtifact, "readmap.v1.json", finalReadmap);

    const gated = runGroundingGate({
      readmap: finalReadmap,
      signals,
      evidence: input.document.blocks,
      tiers,
    });
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
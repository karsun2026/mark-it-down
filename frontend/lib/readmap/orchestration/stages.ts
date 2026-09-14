/**
 * Stage plumbing for the READMAP pipeline (plan §4; spec §14).
 *
 * Every stage accepts an idempotency key derived from (document checksum,
 * pipeline version, stage, unit id) — spec §14: retrying one failed unit must
 * never re-bill the whole document. The key is derived BEFORE any model call
 * so the pipeline can checkpoint.
 */

import { createHash } from "node:crypto";

/** Bumped whenever prompt/schema versions move, invalidating old checkpoints. */
export const PIPELINE_VERSION = "readmap-pipeline.v1";

export interface StageKeyInput {
  checksumSha256: string;
  stage: ReadmapStageLike;
  unitId: string;
}

type ReadmapStageLike = "SEGMENTING" | "MAPPING" | "EXTRACTING" | "VERIFYING" | "COMPRESSING" | "GROUNDING" | string;

/** `<checksum>:<pipeline-version>:<stage>:<unit-id>` — stable across retries. */
export function deriveStageKey(input: StageKeyInput): string {
  return `${input.checksumSha256}:${PIPELINE_VERSION}:${input.stage}:${input.unitId}`;
}

/** Document checksum over the converted Markdown (the immutable input). */
export function checksumOfMarkdown(markdown: string): string {
  return createHash("sha256").update(markdown, "utf8").digest("hex");
}

/** Word count used for honest compression statistics. */
export function countWords(text: string): number {
  return text.trim().length === 0 ? 0 : text.trim().split(/\s+/).length;
}
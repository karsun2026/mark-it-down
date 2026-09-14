/**
 * READMAP stage status (plan §4; follows the converter's D-002 status-object
 * pattern: honest, fixed stage markers, never a fake progress ramp — spec §52).
 *
 * Status objects are versioned JSON written per job; terminal states are
 * READY | PARTIAL_READY | FAILED. Publishing is best-effort and must never
 * fail the job itself.
 */

import { z } from "zod";

/** Non-terminal stages in pipeline order. */
export const READMAP_STAGES = [
  "SEGMENTING",
  "MAPPING",
  "EXTRACTING",
  "VERIFYING",
  "COMPRESSING",
  "GROUNDING",
] as const;
export type ReadmapStage = (typeof READMAP_STAGES)[number];

/** Terminal states (plan §4). PARTIAL_READY = gated output with limitations. */
export const READMAP_TERMINAL_STATES = ["READY", "PARTIAL_READY", "FAILED"] as const;
export type ReadMapTerminalState = (typeof READMAP_TERMINAL_STATES)[number];

/**
 * Fixed, honest progress per stage (spec §52: never fake a ramp). Values are
 * published as-is; partial progress within EXTRACTING/VERIFYING is
 * units-based and monotonic.
 */
export const STAGE_PROGRESS: Record<(typeof READMAP_STAGES)[number], number> = {
  SEGMENTING: 0.1,
  MAPPING: 0.2,
  EXTRACTING: 0.35,
  VERIFYING: 0.6,
  COMPRESSING: 0.8,
  GROUNDING: 0.9,
};

/** All stages plus terminal states, for the status schema's stage field. */
export const READMAP_ALL_STATUSES = [...READMAP_STAGES, ...READMAP_TERMINAL_STATES] as const;

export const ReadMapStatusV1Schema = z.object({
  schemaVersion: z.literal("1.0"),
  jobId: z.string().min(1),
  stage: z.enum(READMAP_ALL_STATUSES),
  /** Monotonic 0..1; terminal READY/PARTIAL_READY = 1. */
  progress: z.number().min(0).max(1),
  /** Units done/total within the current stage (extraction chunks, verdicts). */
  unitsDone: z.number().int().nonnegative().default(0),
  unitsTotal: z.number().int().nonnegative().default(0),
  updatedAt: z.string(),
  warnings: z.array(z.string()),
  failure: z.string().optional(),
});
export type ReadMapStatusV1 = z.infer<typeof ReadMapStatusV1Schema>;
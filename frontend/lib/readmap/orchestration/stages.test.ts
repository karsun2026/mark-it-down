/**
 * Stage-key tests (spec §14; review C-1). The checkpoint key embeds the single
 * global PIPELINE_VERSION, so bumping that version invalidates every stage's
 * checkpoint — which is the ONLY mechanism that makes a prompt/schema change
 * (e.g. compressor.v2) actually take effect instead of reusing a stale cached
 * result. These tests pin that contract.
 */

import { describe, expect, it } from "vitest";

import { PIPELINE_VERSION, deriveStageKey } from "./stages";

const CHECKSUM = "a".repeat(64);

describe("deriveStageKey", () => {
  it("embeds the global pipeline version, so a version bump changes every key", () => {
    const key = deriveStageKey({ checksumSha256: CHECKSUM, stage: "COMPRESSING", unitId: "whole" });
    expect(key).toBe(`${CHECKSUM}:${PIPELINE_VERSION}:COMPRESSING:whole`);
    expect(key).toContain(PIPELINE_VERSION);
  });

  it("is stable for identical inputs but distinct per stage and unit", () => {
    const a = deriveStageKey({ checksumSha256: CHECKSUM, stage: "MAPPING", unitId: "whole" });
    const b = deriveStageKey({ checksumSha256: CHECKSUM, stage: "MAPPING", unitId: "whole" });
    const otherStage = deriveStageKey({ checksumSha256: CHECKSUM, stage: "COMPRESSING", unitId: "whole" });
    const otherUnit = deriveStageKey({ checksumSha256: CHECKSUM, stage: "MAPPING", unitId: "chunk-2" });
    expect(a).toBe(b);
    expect(a).not.toBe(otherStage);
    expect(a).not.toBe(otherUnit);
  });
});

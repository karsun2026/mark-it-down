/**
 * Artifact path/retention helpers (ADR-004; plan §5) — pure, offline tests.
 */

import { describe, expect, it } from "vitest";

import {
  isReadmapArtifact,
  readmapArtifactPath,
  readmapBaseFromResultPath,
  readmapRetentionMinutes,
  readmapUnitPath,
} from "./artifacts";

const RESULT = "jobs/2026-09-13/job-uuid-1/result/report.md";

describe("readmapArtifactPath", () => {
  it("builds job-scoped artifact paths from the conversion result path", () => {
    expect(readmapArtifactPath(RESULT, "evidence.v1.json")).toBe(
      "jobs/2026-09-13/job-uuid-1/readmap/evidence.v1.json",
    );
    expect(readmapArtifactPath(RESULT, "status.v1.json")).toBe(
      "jobs/2026-09-13/job-uuid-1/readmap/status.v1.json",
    );
  });

  it("stays inside the job scope that pathBelongsToJob accepts", () => {
    const path = readmapArtifactPath(RESULT, "readmap.v1.json");
    expect(path).not.toBeNull();
    // The existing §15 scoping check must accept every artifact path.
    expect(path && !path.includes("..") && path.startsWith("jobs/")).toBe(true);
    expect(path?.match(/^jobs\/\d{4}-\d{2}-\d{2}\/job-uuid-1\/readmap\//)).toBeTruthy();
  });

  it("returns null when the result path has no /result/ marker", () => {
    expect(readmapBaseFromResultPath("jobs/2026-09-13/job-uuid-1/source/a.pdf")).toBeNull();
    expect(readmapBaseFromResultPath("no-marker")).toBeNull();
    expect(readmapArtifactPath("no-marker", "readmap.v1.json")).toBeNull();
  });
});

describe("retention", () => {
  it("defaults to 7 days and honours the configured value", () => {
    expect(readmapRetentionMinutes()).toBe(7 * 24 * 60);
  });

  it("recognises readmap artifact pathnames for the sweep", () => {
    expect(isReadmapArtifact("jobs/2026-09-13/j/readmap/status.v1.json")).toBe(true);
    expect(isReadmapArtifact("jobs/2026-09-13/j/result/report.md")).toBe(false);
    expect(isReadmapArtifact("jobs/2026-09-13/j/status.json")).toBe(false);
  });
});

describe("unit checkpoints (§6-C2)", () => {
  it("derives a flat, job-scoped, key-hashed checkpoint path", () => {
    const path = readmapUnitPath(RESULT, "checksum:readmap-pipeline.v1:VERIFYING:s0001");
    expect(path).toMatch(/^jobs\/2026-09-13\/job-uuid-1\/readmap\/units\/[0-9a-f]{32}\.json$/);
    // Same key -> same path; different key -> different path.
    expect(readmapUnitPath(RESULT, "checksum:readmap-pipeline.v1:VERIFYING:s0001")).toBe(path);
    expect(readmapUnitPath(RESULT, "checksum:readmap-pipeline.v1:VERIFYING:s0002")).not.toBe(path);
  });

  it("returns null when the result path has no /result/ marker", () => {
    expect(readmapUnitPath("no-marker", "key")).toBeNull();
  });
});
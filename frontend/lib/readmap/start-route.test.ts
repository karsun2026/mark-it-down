/**
 * Route-level test for /api/readmap/start (review §6-C1): a POST for a job
 * whose readmap.v1.json already exists must return the stored result with
 * `reused: true` and must NOT run the pipeline. All collaborators are
 * mocked; nothing here touches the network or spends tokens.
 */

import { describe, expect, it, vi } from "vitest";

import type { ReadMapV1 } from "@/lib/readmap/schemas/readmap";
import type { CompressedTiersV1 } from "@/lib/readmap/schemas/signal";
import { POST } from "@/app/api/readmap/start/route";

const RESULT_PATH = vi.hoisted(() => "jobs/2026-09-13/job-uuid-1/result/report.md");

const READMAP: ReadMapV1 = {
  schemaVersion: "1.0",
  jobId: "job-uuid-1",
  coverage: { readablePages: 2, totalPages: 2, ratio: 1, limitations: [] },
  compression: {
    originalWords: 25,
    originalReadingMinutes: 1,
    selectedPreset: "READMAP",
    outputWords: 12,
  },
  thePoint: { text: "Revenue grew 12% year over year.", signalIds: ["s0001"], kind: "VERIFIED" },
  rememberThese: [],
  numbersWorthRemembering: [],
  caution: [],
  actuallyRead: [],
  safelySkip: [],
  documentShape: [],
};

const TIERS: CompressedTiersV1 = {
  tiers: {
    ONE_THING: [{ signalId: "s0001", text: "Revenue grew 12% year over year." }],
    BRUTAL: [],
    QUICK_SCAN: [],
    BRIEF: [],
    READMAP: [{ signalId: "s0001", text: "Revenue grew 12% year over year." }],
    DEEP_DIVE: [],
  },
};

vi.mock("@/lib/guard", () => ({
  requireSession: vi.fn().mockResolvedValue(null),
}));

vi.mock("@/lib/rate-limit", () => ({
  checkConversionRateLimit: vi.fn().mockResolvedValue({ limited: false }),
  warnIfDegraded: vi.fn(),
}));

vi.mock("@/lib/readmap/route-access", () => ({
  verifyReadmapAccess: vi.fn().mockResolvedValue({
    access: { jobId: "job-uuid-1", resultPathname: RESULT_PATH },
  }),
  modelConfigured: vi.fn().mockReturnValue(true),
}));

vi.mock("@/lib/readmap/artifacts", () => ({
  // The pipeline persists the ReadMapV1 object ITSELF at readmap.v1.json
  // (§6-C1): its presence is the completion signal.
  getReadmapArtifact: vi.fn().mockImplementation(async (pathname: string) => {
    if (pathname.endsWith("readmap.v1.json")) return READMAP;
    if (pathname.endsWith("tiers.v1.json")) return TIERS;
    if (pathname.endsWith("status.v1.json")) return { stage: "READY" };
    return null;
  }),
  putReadmapArtifact: vi.fn(),
  getReadmapUnit: vi.fn().mockResolvedValue(null),
  putReadmapUnit: vi.fn(),
  readmapArtifactPath: vi.fn(
    (_resultPathname: string, name: string) => `jobs/2026-09-13/job-uuid-1/readmap/${name}`,
  ),
  readmapUnitPath: vi.fn().mockReturnValue("jobs/2026-09-13/job-uuid-1/readmap/units/x.json"),
}));

vi.mock("@/lib/readmap/models/model-router", () => ({
  getClientForTask: vi.fn(),
}));

vi.mock("@/lib/readmap/orchestration/pipeline", () => ({
  // If the reuse branch works, the pipeline is never reached.
  runReadmapPipeline: vi.fn().mockRejectedValue(new Error("pipeline must not run on a reuse hit")),
}));

vi.mock("@/lib/blob", () => ({
  signResultDownload: vi.fn().mockRejectedValue(new Error("result download must not happen on a reuse hit")),
}));

vi.mock("@/lib/readmap/ingestion/segment", () => ({
  segmentDocument: vi.fn().mockRejectedValue(new Error("segmentation must not happen on a reuse hit")),
}));

function startRequest(): Request {
  return new Request("http://localhost/api/readmap/start", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jobToken: "signed-token",
      resultPathname: RESULT_PATH,
      originalFilename: "report.pdf",
    }),
  });
}

describe("POST /api/readmap/start (§6-C1 idempotent reuse)", () => {
  it("returns the stored readmap with reused:true and never runs the pipeline", async () => {
    const response = await POST(startRequest());
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      status: string;
      reused: boolean;
      readmap: ReadMapV1;
      tiers: CompressedTiersV1 | null;
    };
    expect(body.reused).toBe(true);
    expect(body.status).toBe("READY");
    expect(body.readmap.thePoint.signalIds).toEqual(["s0001"]);
    expect(body.tiers?.tiers.ONE_THING).toHaveLength(1);
  });

  it("reports PARTIAL_READY when the stored status says so", async () => {
    const artifacts = await import("@/lib/readmap/artifacts");
    vi.mocked(artifacts.getReadmapArtifact).mockImplementation(async (pathname: string) => {
      if (pathname.endsWith("readmap.v1.json")) return READMAP;
      if (pathname.endsWith("status.v1.json")) return { stage: "PARTIAL_READY" };
      return null;
    });
    const response = await POST(startRequest());
    const body = (await response.json()) as { status: string; reused: boolean };
    expect(body.status).toBe("PARTIAL_READY");
    expect(body.reused).toBe(true);
  });

  it("short-circuits a duplicate start while a fresh run is still in flight (MEDIUM-2)", async () => {
    const artifacts = await import("@/lib/readmap/artifacts");
    vi.mocked(artifacts.getReadmapArtifact).mockImplementation(async (pathname: string) => {
      if (pathname.endsWith("readmap.v1.json")) return null; // no completed run yet
      if (pathname.endsWith("status.v1.json")) {
        return { stage: "MAPPING", updatedAt: new Date().toISOString() }; // fresh, non-terminal
      }
      return null;
    });
    const response = await POST(startRequest());
    // 429 RATE_LIMITED, and the pipeline (mocked to reject) is never reached.
    expect(response.status).toBe(429);
  });
});
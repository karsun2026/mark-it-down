/**
 * Route-level test for /api/readmap/evidence/[signalId] (review BLOCKER-1).
 *
 * The pipeline persists signals.v1.json as a BARE ARRAY. This test feeds the
 * route exactly that shape and asserts it resolves the signal and returns its
 * cited evidence blocks — instead of dereferencing `.signals` on an array and
 * 500ing every "source" click. All collaborators mocked; no network/tokens.
 */

import { describe, expect, it, vi } from "vitest";

import { POST } from "@/app/api/readmap/evidence/[signalId]/route";

const RESULT_PATH = vi.hoisted(() => "jobs/2026-09-13/job-uuid-1/result/report.md");

// signals.v1.json is a BARE ARRAY on disk — the crux of BLOCKER-1.
const SIGNALS = [
  {
    id: "s0001",
    claim: "Revenue grew 12% year over year.",
    type: "QUANTITATIVE",
    skepticVerdict: "SUPPORTED",
    explanation: "stated directly in the cited span",
    epistemicStatus: "STATED_FACT",
    warnings: [],
    evidenceBlockIds: ["b0001"],
  },
];

// evidence.v1.json is the ConvertedDocumentV1 (it has `.blocks`) — read as-is.
const EVIDENCE = {
  schemaVersion: "1.0",
  document: { filename: "report.pdf", sourceType: "pdf", pagesOrSlides: 1, wordCount: 6 },
  blocks: [
    {
      id: "b0001",
      pageNumber: 1,
      sectionPath: ["Page 1"],
      blockType: "PARAGRAPH",
      normalizedText: "Revenue grew 12% year over year.",
      sourceText: "Revenue grew 12% year over year.",
      extractionMethods: ["MARKDOWN"],
      contentHash: "abc",
    },
  ],
  warnings: [],
};

vi.mock("@/lib/guard", () => ({ requireSession: vi.fn().mockResolvedValue(null) }));

vi.mock("@/lib/readmap/route-access", () => ({
  verifyReadmapAccess: vi.fn().mockResolvedValue({
    access: { jobId: "job-uuid-1", resultPathname: RESULT_PATH },
  }),
}));

vi.mock("@/lib/readmap/artifacts", () => ({
  getReadmapArtifact: vi.fn().mockImplementation(async (pathname: string) => {
    if (pathname.endsWith("signals.v1.json")) return SIGNALS; // BARE ARRAY
    if (pathname.endsWith("evidence.v1.json")) return EVIDENCE;
    return null;
  }),
  readmapArtifactPath: vi.fn(
    (_resultPathname: string, name: string) => `jobs/2026-09-13/job-uuid-1/readmap/${name}`,
  ),
}));

function evidenceRequest(): Request {
  return new Request("http://localhost/api/readmap/evidence/s0001", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jobToken: "signed-token", resultPathname: RESULT_PATH }),
  });
}

describe("POST /api/readmap/evidence/[signalId] (BLOCKER-1)", () => {
  it("resolves a signal from the bare-array artifact and returns its cited blocks", async () => {
    const response = await POST(evidenceRequest(), {
      params: Promise.resolve({ signalId: "s0001" }),
    });
    expect(response.status).toBe(200); // not 500 — the old bug threw a TypeError
    const body = (await response.json()) as {
      signal: { id: string; claim: string };
      evidence: { id: string }[];
    };
    expect(body.signal.id).toBe("s0001");
    expect(body.evidence.map((b) => b.id)).toEqual(["b0001"]);
  });

  it("returns a clean not-found (not a 500) for an unknown signal id", async () => {
    const response = await POST(evidenceRequest(), {
      params: Promise.resolve({ signalId: "s9999" }),
    });
    expect(response.status).toBe(404);
  });
});

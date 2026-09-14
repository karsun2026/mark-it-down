/**
 * Grounding-gate tests (spec §11; plan acceptance checks 6–8 groundwork).
 *
 * Every deterministic check is driven to both outcomes where reachable.
 * §11.4 (independent numeric validation) is asserted to be DEFERRED, never
 * silently passed.
 */

import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import type { EvidenceBlockInput } from "../schemas/evidence";
import type { ReadMapV1 } from "../schemas/readmap";
import type { CompressedTiersV1, VerifiedSignalV1 } from "../schemas/signal";
import { runGroundingGate } from "./grounding-gate";
import { numbersPreserved } from "./numeric-guard";

function block(id: string, body: string, sectionPath: string[], page: number): EvidenceBlockInput {
  return {
    id,
    pageNumber: page,
    sectionPath,
    blockType: "PARAGRAPH",
    normalizedText: body,
    sourceText: body,
    extractionMethods: ["MARKDOWN"],
    contentHash: createHash("sha256").update(body).digest("hex"),
  };
}

const EVIDENCE = [
  block("b0001", "Revenue grew 12% year over year.", ["Findings"], 1),
  block("b0002", "Supply concentration is a key risk.", ["Risks"], 2),
];

const SIGNALS: VerifiedSignalV1[] = [
  {
    id: "s0001",
    claim: "Revenue grew 12% year over year.",
    type: "QUANTITATIVE",
    evidenceBlockIds: ["b0001"],
    evidenceQuotes: [{ blockId: "b0001", quote: "Revenue grew 12%" }],
    epistemicStatus: "STATED_FACT",
    warnings: [],
    skepticVerdict: "SUPPORTED",
    explanationCode: "OK",
    explanation: "stated directly",
  },
  {
    id: "s0002",
    claim: "Supply concentration is a key risk.",
    type: "RISK",
    evidenceBlockIds: ["b0002"],
    evidenceQuotes: [{ blockId: "b0002", quote: "Supply concentration" }],
    epistemicStatus: "SOURCE_OPINION",
    warnings: [],
    skepticVerdict: "SUPPORTED",
    explanationCode: "OK",
    explanation: "stated directly",
  },
];

function tiersFor(
  ladder: Record<string, string[]>,
  text: (id: string) => string = () => "ok",
): CompressedTiersV1 {
  const entry = (id: string) => ({ signalId: id, text: text(id) });
  return {
    tiers: {
      ONE_THING: (ladder.ONE_THING ?? []).map(entry),
      BRUTAL: (ladder.BRUTAL ?? []).map(entry),
      QUICK_SCAN: (ladder.QUICK_SCAN ?? []).map(entry),
      BRIEF: (ladder.BRIEF ?? []).map(entry),
      READMAP: (ladder.READMAP ?? []).map(entry),
      DEEP_DIVE: (ladder.DEEP_DIVE ?? []).map(entry),
    },
  };
}

/** Renderings keep the claim's numbers for s0001; s0002 carries none. */
const tierText = (id: string): string =>
  id === "s0001" ? "Revenue grew 12% year over year." : "Supply concentration is a key risk.";

const GOOD_TIERS = tiersFor(
  {
    ONE_THING: ["s0001"],
    BRUTAL: ["s0001", "s0002"],
    QUICK_SCAN: ["s0001", "s0002"],
    BRIEF: ["s0001", "s0002"],
    READMAP: ["s0001", "s0002"],
    DEEP_DIVE: ["s0001", "s0002"],
  },
  tierText,
);

function readmapFixture(): ReadMapV1 {
  return {
    schemaVersion: "1.0",
    jobId: "job1",
    coverage: { readablePages: 2, totalPages: 2, ratio: 1, limitations: [] },
    compression: {
      originalWords: 20,
      originalReadingMinutes: 1,
      selectedPreset: "READMAP",
      outputWords: 10,
    },
    thePoint: {
      text: "Revenue grew 12% year over year.",
      signalIds: ["s0001"],
      kind: "VERIFIED",
    },
    rememberThese: [
      { text: "Supply concentration is a key risk.", signalIds: ["s0002"], kind: "VERIFIED" },
    ],
    numbersWorthRemembering: [],
    caution: [],
    actuallyRead: [{ pages: { from: 1, to: 2 }, reason: "high signal density" }],
    safelySkip: [],
    documentShape: [{ sectionPath: ["Findings"], shape: "reports growth" }],
  };
}

describe("runGroundingGate", () => {
  it("passes a well-grounded READMAP and reports the deferred numeric check", () => {
    const report = runGroundingGate({
      readmap: readmapFixture(),
      signals: SIGNALS,
      evidence: EVIDENCE,
      tiers: GOOD_TIERS,
    });
    expect(report.passed).toBe(true);
    expect(report.failures).toEqual([]);
    expect(report.deferredChecks).toContain(
      "NUMERIC_INDEPENDENT_VALIDATION_DEFERRED_TO_PHASE_3",
    );
  });

  it("rejects a claim citing an unknown signal (§11.2)", () => {
    const readmap = readmapFixture();
    readmap.caution = [{ text: "x", signalIds: ["s9999"], kind: "VERIFIED" }];
    const report = runGroundingGate({ readmap, signals: SIGNALS, evidence: EVIDENCE });
    expect(report.passed).toBe(false);
    expect(report.failures.map((f) => f.code)).toContain("UNKNOWN_SIGNAL");
  });

  it("rejects a claim resting on an unsupported signal (§11.5)", () => {
    const readmap = readmapFixture();
    readmap.caution = [{ text: "x", signalIds: ["s0003"], kind: "VERIFIED" }];
    const report = runGroundingGate({
      readmap,
      signals: [...SIGNALS, { ...SIGNALS[1]!, id: "s0003", skepticVerdict: "UNSUPPORTED" }],
      evidence: EVIDENCE,
    });
    expect(report.failures.map((f) => f.code)).toContain("SIGNAL_NOT_USABLE");
  });

  it("rejects signals whose evidence blocks are not in this snapshot (§11.3)", () => {
    const report = runGroundingGate({
      readmap: readmapFixture(),
      signals: [{ ...SIGNALS[0]!, evidenceBlockIds: ["b0001", "b0999"] }, SIGNALS[1]!],
      evidence: EVIDENCE,
    });
    expect(report.failures.map((f) => f.code)).toContain("UNKNOWN_EVIDENCE_BLOCK");
  });

  it("rejects interpretation in a factual field (§11.6)", () => {
    const readmap = readmapFixture();
    readmap.caution = [{ text: "x", signalIds: ["s0001"], kind: "INTERPRETATION" }];
    const report = runGroundingGate({ readmap, signals: SIGNALS, evidence: EVIDENCE });
    expect(report.failures.map((f) => f.code)).toContain("INTERPRETATION_IN_FACTUAL_FIELD");
  });

  it("rejects dishonest coverage (§11.8)", () => {
    const readmap = readmapFixture();
    readmap.coverage = { readablePages: 3, totalPages: 2, ratio: 0.5, limitations: [] };
    const report = runGroundingGate({ readmap, signals: SIGNALS, evidence: EVIDENCE });
    expect(report.failures.filter((f) => f.code === "COVERAGE_HONESTY")).toHaveLength(2);
  });

  it("rejects recommendations pointing at pages that do not exist (§11.9)", () => {
    const readmap = readmapFixture();
    readmap.actuallyRead = [{ pages: { from: 5, to: 6 }, reason: "x" }];
    const report = runGroundingGate({ readmap, signals: SIGNALS, evidence: EVIDENCE });
    expect(report.failures.map((f) => f.code)).toContain("RECOMMENDATION_TARGET");
  });

  it("rejects renderings that drop a claim's numbers (§11.10 approximation)", () => {
    expect(
      numbersPreserved("Revenue grew 12% year over year.", "Revenue grew substantially."),
    ).toBe(false);
    const report = runGroundingGate({
      readmap: readmapFixture(),
      signals: SIGNALS,
      evidence: EVIDENCE,
      tiers: tiersFor({
        ONE_THING: ["s0001"],
        BRUTAL: ["s0001", "s0002"],
        QUICK_SCAN: ["s0001", "s0002"],
        BRIEF: ["s0001", "s0002"],
        READMAP: ["s0001", "s0002"],
        DEEP_DIVE: ["s0001", "s0002"],
      }, () => "ok"),
    });
    expect(report.passed).toBe(false);
    expect(report.failures.map((f) => f.code)).toContain("NUMBER_DROPPED");
  });
});
/**
 * Skeptic agent tests (spec §10.3).
 *
 * The load-bearing property under test: the Skeptic sees ONLY the cited
 * evidence plus bounded nearby context — the message payload is asserted, not
 * just the outcome. Also pins the verdict-schema rule: repairedClaim exists
 * exactly when the verdict is PARTIAL.
 */

import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import type { EvidenceBlockInput } from "../schemas/evidence";
import type { CandidateSignalV1 } from "../schemas/signal";
import { SKEPTIC_PROMPT_VERSION } from "../prompts/skeptic";
import {
  NEARBY_CONTEXT_LIMIT,
  runSkeptic,
  skepticEvidenceFor,
} from "./skeptic";
import { scriptedClient } from "./agent-test-support";

function block(
  id: string,
  body: string,
  sectionPath: string[],
  pageNumber: number,
): EvidenceBlockInput {
  return {
    id,
    pageNumber,
    sectionPath,
    blockType: "PARAGRAPH",
    normalizedText: body,
    sourceText: body,
    extractionMethods: ["MARKDOWN"],
    contentHash: createHash("sha256").update(body).digest("hex"),
  };
}

const FINDINGS1 = block("b0001", "Revenue grew 12% year over year.", ["Findings"], 1);
const FINDINGS2 = block("b0002", "Management expects moderate growth.", ["Findings"], 1);
const RISKS = block("b0003", "Supply concentration is a key risk.", ["Risks"], 2);
const BLOCKS = [FINDINGS1, FINDINGS2, RISKS];

const SIGNAL: CandidateSignalV1 = {
  id: "s0001",
  claim: "Revenue grew 12% year over year.",
  type: "QUANTITATIVE",
  evidenceBlockIds: ["b0001"],
  evidenceQuotes: [{ blockId: "b0001", quote: "Revenue grew 12%" }],
  epistemicStatus: "STATED_FACT",
  warnings: [],
};

describe("skepticEvidenceFor — the input boundary", () => {
  it("includes the cited block and nearby same-section blocks", () => {
    const evidence = skepticEvidenceFor(SIGNAL, [FINDINGS1, FINDINGS2, RISKS]);
    expect(evidence.map((b) => b.id)).toEqual(["b0001", "b0002"]);
  });

  it("excludes blocks from other sections and pages", () => {
    const evidence = skepticEvidenceFor(SIGNAL, [FINDINGS1, RISKS]);
    expect(evidence.map((b) => b.id)).toEqual(["b0001"]);
  });

  it("caps nearby context at the bounded limit", () => {
    const many = Array.from({ length: 20 }, (_, i) =>
      block(`b9${String(i).padStart(3, "0")}`, `context ${i}`, ["Findings"], 1),
    );
    const evidence = skepticEvidenceFor(SIGNAL, [FINDINGS1, ...many]);
    // cited + at most NEARBY_CONTEXT_LIMIT nearby blocks
    expect(evidence).toHaveLength(1 + NEARBY_CONTEXT_LIMIT);
  });

  it("refuses to run when a cited block cannot be resolved", () => {
    const broken = { ...SIGNAL, evidenceBlockIds: ["b9999"] };
    expect(() => skepticEvidenceFor(broken, [FINDINGS1])).toThrowError(
      /not available to the skeptic/,
    );
  });
});

describe("runSkeptic", () => {
  it("returns the verdict with the versioned prompt", async () => {
    const { client, calls } = scriptedClient({
      verdict: "SUPPORTED",
      explanationCode: "OK",
      explanation: "The cited span states the 12% growth directly.",
    });
    const run = await runSkeptic(client, {
      signal: SIGNAL,
      blocks: [FINDINGS1, FINDINGS2, RISKS],
      idempotencyKey: "doc1:verify:s0001",
    });

    expect(run.promptVersion).toBe(SKEPTIC_PROMPT_VERSION);
    expect(run.result.value.verdict).toBe("SUPPORTED");
    expect(run.result.task).toBe("skeptic");

    // The payload carries exactly one signal + cited evidence + nearby context.
    const payload = JSON.parse(calls[0]?.messageText ?? "{}") as {
      candidateSignal: { id: string };
      citedEvidence: { id: string }[];
      nearbyContext: { id: string }[];
    };
    expect(payload.candidateSignal.id).toBe("s0001");
    expect(payload.citedEvidence.map((e) => e.id)).toEqual(["b0001"]);
    expect(payload.nearbyContext.map((e) => e.id)).toEqual(["b0002"]);
    expect(calls[0]?.system).toContain("Do not use external knowledge");
  });

  it("requires repairedClaim exactly when the verdict is PARTIAL", async () => {
    const { client } = scriptedClient({
      verdict: "PARTIAL",
      explanationCode: "OVERREACH",
      explanation: "the 12% is management-attributed expectation",
    });
    // PARTIAL without repairedClaim violates the schema -> schema failure.
    await expect(
      runSkeptic(client, { signal: SIGNAL, blocks: [FINDINGS1], idempotencyKey: "k" }),
    ).rejects.toThrowError(/schema validation|repairedClaim/);
  });

  it("accepts PARTIAL with a repaired claim", async () => {
    const { client } = scriptedClient({
      verdict: "PARTIAL",
      explanationCode: "OVERREACH",
      explanation: "the growth figure is stated; the cause is not",
      repairedClaim: "Revenue grew 12% year over year.",
    });
    const run = await runSkeptic(client, {
      signal: SIGNAL,
      blocks: [FINDINGS1],
      idempotencyKey: "k",
    });
    expect(run.result.value.repairedClaim).toBe("Revenue grew 12% year over year.");
  });

  it("rejects a repair smuggled onto a SUPPORTED verdict", async () => {
    const { client } = scriptedClient({
      verdict: "SUPPORTED",
      explanationCode: "OK",
      explanation: "supported as stated",
      repairedClaim: "Revenue grew 12% year over year.",
    });
    await expect(
      runSkeptic(client, { signal: SIGNAL, blocks: [FINDINGS1], idempotencyKey: "k" }),
    ).rejects.toThrowError();
  });
});
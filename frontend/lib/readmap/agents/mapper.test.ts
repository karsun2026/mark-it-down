/**
 * Mapper agent tests (spec §10.1): structure output validated against the
 * supplied evidence — invented section paths fail the unit.
 */

import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { ConvertedDocumentV1Schema, type EvidenceBlockInput } from "../schemas/evidence";
import { MAPPER_PROMPT_VERSION } from "../prompts/mapper";
import { AgentContractError } from "./contract";
import { runMapper } from "./mapper";
import { scriptedClient } from "./agent-test-support";

function block(id: string, body: string, sectionPath: string[]): EvidenceBlockInput {
  return {
    id,
    pageNumber: 1,
    sectionPath,
    blockType: "PARAGRAPH",
    normalizedText: body,
    sourceText: body,
    extractionMethods: ["MARKDOWN"],
    contentHash: createHash("sha256").update(body).digest("hex"),
  };
}

const BLOCKS = [
  block("b0001", "Quarterly review of 2025 results.", ["Overview"]),
  block("b0002", "Revenue grew 12% year over year.", ["Findings"]),
];

const DOCUMENT = ConvertedDocumentV1Schema.parse({
  schemaVersion: "1.0",
  document: { filename: "report.pdf", sourceType: "pdf", pagesOrSlides: 1, wordCount: 12 },
  blocks: BLOCKS,
  warnings: [],
});

const GOOD_MAP = {
  documentType: "Quarterly business report",
  mainThesisCandidates: ["2025 revenue grew 12% year over year"],
  sections: [
    { sectionPath: ["Overview"], purpose: "introduces the review", signalDensity: "LOW", value: "LOW_VALUE" },
    { sectionPath: ["Findings"], purpose: "reports growth results", signalDensity: "HIGH", value: "HIGH_VALUE" },
  ],
  warnings: [],
};

describe("runMapper", () => {
  it("returns the mapped structure with the versioned prompt", async () => {
    const { client, calls } = scriptedClient(GOOD_MAP);
    const run = await runMapper(client, { document: DOCUMENT, idempotencyKey: "doc1:map" });

    expect(run.promptVersion).toBe(MAPPER_PROMPT_VERSION);
    expect(run.result.value.documentType).toBe("Quarterly business report");
    expect(run.result.value.sections).toHaveLength(2);
    expect(run.result.task).toBe("mapper");

    const payload = JSON.parse(calls[0]?.messageText ?? "{}") as {
      blocks: { id: string; text: string }[];
    };
    expect(payload.blocks.map((b) => b.id)).toEqual(["b0001", "b0002"]);
    expect(calls[0]?.system).toContain("Preserve dissenting or contradictory sections");
  });

  it("fails the unit when the mapper invents a section path", async () => {
    const { client } = scriptedClient({
      ...GOOD_MAP,
      sections: [
        ...GOOD_MAP.sections,
        { sectionPath: ["Invented Appendix"], purpose: "x", signalDensity: "LOW", value: "LOW_VALUE" },
      ],
    });
    await expect(
      runMapper(client, { document: DOCUMENT, idempotencyKey: "doc1:map" }),
    ).rejects.toThrowError(AgentContractError);
  });

  it("fails the unit when the model output violates the schema", async () => {
    const { client } = scriptedClient({ documentType: "only one field" });
    await expect(
      runMapper(client, { document: DOCUMENT, idempotencyKey: "doc1:map" }),
    ).rejects.toThrowError(/schema validation/);
  });
});
/**
 * Signal Extractor agent tests (spec §10.2).
 *
 * Offline: the scripted client validates the agent's schema, then the agent's
 * deterministic citation/verbatim checks decide pass or fail. Pins the
 * acceptance-check 8 groundwork: citations must resolve, quotes must be
 * verbatim, ids are pipeline facts.
 */

import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import type { EvidenceBlockInput } from "../schemas/evidence";
import { SIGNAL_EXTRACTOR_PROMPT_VERSION } from "../prompts/signal-extractor";
import { runSignalExtractor } from "./signal-extractor";
import { scriptedClient } from "./agent-test-support";

const PAGE1 = "Revenue grew 12% year over year.";
const PAGE1B = "Management expects moderate growth.";
const BLOCKS: EvidenceBlockInput[] = [
  {
    id: "b0001",
    pageNumber: 1,
    sectionPath: ["Findings"],
    blockType: "PARAGRAPH",
    normalizedText: PAGE1,
    sourceText: PAGE1,
    extractionMethods: ["MARKDOWN"],
    contentHash: createHash("sha256").update(PAGE1).digest("hex"),
  },
  {
    id: "b0002",
    pageNumber: 1,
    sectionPath: ["Findings"],
    blockType: "PARAGRAPH",
    normalizedText: PAGE1B,
    sourceText: PAGE1B,
    extractionMethods: ["MARKDOWN"],
    contentHash: createHash("sha256").update(PAGE1B).digest("hex"),
  },
];

const GROWTH_SIGNAL = {
  claim: "Revenue grew 12% year over year.",
  type: "QUANTITATIVE",
  evidenceBlockIds: ["b0001"],
  evidenceQuotes: [{ blockId: "b0001", quote: "Revenue grew 12% year over year." }],
  epistemicStatus: "STATED_FACT",
  warnings: [],
};

const EXPECT_SIGNAL = {
  claim: "Management expects moderate growth.",
  type: "FORECAST",
  evidenceBlockIds: ["b0002"],
  evidenceQuotes: [{ blockId: "b0002", quote: "Management expects moderate growth." }],
  speakerOrAttribution: "management",
  epistemicStatus: "FORECAST",
  warnings: ["period qualifier is relative (year over year), not absolute"],
};

describe("runSignalExtractor", () => {
  it("passes schema-validated signals through with deterministic ids", async () => {
    const { client, calls } = scriptedClient({ signals: [GROWTH_SIGNAL, EXPECT_SIGNAL] });
    const run = await runSignalExtractor(client, {
      blocks: BLOCKS,
      idempotencyKey: "doc1:extract:findings",
    });

    expect(run.promptVersion).toBe(SIGNAL_EXTRACTOR_PROMPT_VERSION);
    expect(run.result.value.signals.map((s) => s.id)).toEqual(["s0001", "s0002"]);
    expect(run.result.value.signals[0]?.evidenceBlockIds).toEqual(["b0001"]);
    expect(run.result.value.signals[1]?.speakerOrAttribution).toBe("management");
    expect(run.result.task).toBe("signal-extraction");
    expect(run.result.idempotencyKey).toBe("doc1:extract:findings");

    // The model got exactly the supplied blocks, labelled as untrusted data.
    const payload = JSON.parse(calls[0]?.messageText ?? "{}") as {
      context: string;
      blocks: { id: string }[];
    };
    expect(payload.context).toContain("untrusted");
    expect(payload.blocks.map((b) => b.id)).toEqual(["b0001", "b0002"]);
    expect(calls[0]?.system).toContain("minimal supporting quote");
  });

  it("assigns the same ids for identical model output (determinism)", async () => {
    const first = await runSignalExtractor(scriptedClient({ signals: [GROWTH_SIGNAL] }).client, {
      blocks: BLOCKS,
      idempotencyKey: "k",
    });
    const second = await runSignalExtractor(scriptedClient({ signals: [GROWTH_SIGNAL] }).client, {
      blocks: BLOCKS,
      idempotencyKey: "k",
    });
    expect(second.result.value.signals).toEqual(first.result.value.signals);
    expect(second.result.value.signals[0]?.id).toBe("s0001");
  });

  it("fails the unit when a quote is not a verbatim span (paraphrase)", async () => {
    const { client } = scriptedClient({
      signals: [
        {
          ...GROWTH_SIGNAL,
          evidenceQuotes: [{ blockId: "b0001", quote: "Revenue grew 20% last year." }],
        },
      ],
    });
    await expect(
      runSignalExtractor(client, { blocks: BLOCKS, idempotencyKey: "k" }),
    ).rejects.toThrowError(/not a verbatim span/);
  });

  it("fails the unit when a signal cites a block it never saw", async () => {
    const { client } = scriptedClient({
      signals: [
        {
          ...GROWTH_SIGNAL,
          evidenceBlockIds: ["b0999"],
          evidenceQuotes: [{ blockId: "b0999", quote: PAGE1 }],
        },
      ],
    });
    await expect(
      runSignalExtractor(client, { blocks: BLOCKS, idempotencyKey: "k" }),
    ).rejects.toThrowError(/was not in the supplied evidence/);
  });

  it("accepts quotes that differ only in whitespace", async () => {
    const { client } = scriptedClient({
      signals: [
        {
          ...GROWTH_SIGNAL,
          evidenceQuotes: [{ blockId: "b0001", quote: "Revenue  grew\n12%" }],
        },
      ],
    });
    await expect(
      runSignalExtractor(client, { blocks: BLOCKS, idempotencyKey: "k" }),
    ).resolves.toBeDefined();
  });
});
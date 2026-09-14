/**
 * Pipeline integration tests (plan §4): the real mapper → extractor →
 * skeptic → compressor → grounding-gate sequence, offline, with a scripted
 * client routed per agent task. Asserts the honesty properties: evidence
 * persisted before any model call, honest stage sequence, unique global
 * signal ids, budget accumulation, and truthful terminal states.
 */

import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { ConvertedDocumentV1Schema, type EvidenceBlockInput } from "../schemas/evidence";
import {
  ModelCallError,
  type AgentTask,
  type ModelGenerateInput,
  type ModelResult,
  type StructuredModelClient,
} from "../models/client";
import { runReadmapPipeline, chunkBlocks } from "./pipeline";

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

const DOCUMENT = ConvertedDocumentV1Schema.parse({
  schemaVersion: "1.0",
  document: { filename: "report.pdf", sourceType: "pdf", pagesOrSlides: 2, wordCount: 25 },
  blocks: [
    block("b0001", "Revenue grew 12% year over year.", ["Findings"], 1),
    block("b0002", "Management expects moderate growth.", ["Findings"], 1),
    block("b0003", "Supply concentration is a key risk.", ["Risks"], 2),
  ],
  warnings: [],
});

const MAP = {
  documentType: "Quarterly business report",
  mainThesisCandidates: ["2025 revenue grew 12% year over year"],
  sections: [
    { sectionPath: ["Findings"], purpose: "reports growth", signalDensity: "HIGH", value: "HIGH_VALUE" },
    { sectionPath: ["Risks"], purpose: "lists risks", signalDensity: "LOW", value: "LOW_VALUE" },
  ],
  warnings: [],
};

const GROWTH = {
  claim: "Revenue grew 12% year over year.",
  type: "QUANTITATIVE",
  evidenceBlockIds: ["b0001"],
  evidenceQuotes: [{ blockId: "b0001", quote: "Revenue grew 12% year over year." }],
  epistemicStatus: "STATED_FACT",
  warnings: [],
};

const RISK = {
  claim: "Supply concentration is a key risk.",
  type: "RISK",
  evidenceBlockIds: ["b0003"],
  evidenceQuotes: [{ blockId: "b0003", quote: "Supply concentration is a key risk." }],
  speakerOrAttribution: "authors",
  epistemicStatus: "SOURCE_OPINION",
  warnings: [],
};

const SUPPORTED = {
  verdict: "SUPPORTED",
  explanationCode: "OK",
  explanation: "stated directly in the cited span",
};

const TIERS = {
  tiers: {
    ONE_THING: [{ signalId: "s0001", text: "Revenue grew 12% year over year." }],
    BRUTAL: [
      { signalId: "s0001", text: "Revenue grew 12% year over year." },
      { signalId: "s0002", text: "Supply concentration is a key risk." },
    ],
    QUICK_SCAN: [
      { signalId: "s0001", text: "Revenue grew 12% year over year." },
      { signalId: "s0002", text: "Supply concentration is a key risk." },
    ],
    BRIEF: [
      { signalId: "s0001", text: "Revenue grew 12% year over year." },
      { signalId: "s0002", text: "Supply concentration is a key risk." },
    ],
    READMAP: [
      { signalId: "s0001", text: "Revenue grew 12% year over year." },
      { signalId: "s0002", text: "Supply concentration is a key risk." },
    ],
    DEEP_DIVE: [
      { signalId: "s0001", text: "Revenue grew 12% year over year." },
      { signalId: "s0002", text: "Supply concentration is a key risk." },
    ],
  },
};

/** Client that serves a per-task queue, validating each response's schema. */
interface RoutedCall {
  task: string;
  idempotencyKey: string;
}

function routedClient(queuesParam: Partial<Record<string, unknown[]>>): {
  client: StructuredModelClient;
  events: string[];
  calls: RoutedCall[];
} {
  // Deep-copy: a pipeline run consumes its own queues and must never mutate
  // the module-level fixtures other tests start from.
  const queues = Object.fromEntries(
    Object.entries(queuesParam).map(([task, list]) => [task, [...(list ?? [])]]),
  );
  const lastServed: Partial<Record<string, unknown>> = {};
  const events: string[] = [];
  const calls: RoutedCall[] = [];
  const client: StructuredModelClient = {
    async generate<T>(input: ModelGenerateInput<T>): Promise<ModelResult<T>> {
      const response = queues[input.task]?.shift() ?? lastServed[input.task];
      if (response === undefined) {
        throw new ModelCallError("config", `no scripted response for task=${input.task}`);
      }
      lastServed[input.task] = response;
      events.push(`call:${input.task}:${input.idempotencyKey}`);
      calls.push({ task: input.task, idempotencyKey: input.idempotencyKey });
      const parsed = input.schema.safeParse(response);
      if (!parsed.success) {
        throw new ModelCallError(
          "schema",
          `scripted response failed schema (task=${input.task})`,
        );
      }
      return {
        task: input.task,
        provider: "dev",
        model: "dev-fixture",
        idempotencyKey: input.idempotencyKey,
        value: parsed.data,
        usage: { inputTokens: 10, outputTokens: 5 },
        repairAttempts: 0,
      };
    },
  };
  return { client, events, calls };
}

const CHECKSUM = "a".repeat(64);

const QUEUES = {
  mapper: [MAP],
  "signal-extraction": [ { signals: [GROWTH] }, { signals: [RISK] } ],
  skeptic: [SUPPORTED],
  compression: [TIERS],
};

describe("runReadmapPipeline", () => {
  it("runs the full sequence and returns READY with a gated READMAP", async () => {
    const { client, events, calls } = routedClient(QUEUES);
    const persisted: string[] = [];
    const stages: string[] = [];

    const result = await runReadmapPipeline({
      jobId: "job1",
      checksumSha256: CHECKSUM,
      document: DOCUMENT,
      getClient: () => client,
      onStage: (status) => stages.push(status.stage),
      persistArtifact: async (name) => {
        persisted.push(name);
        events.push(`persist:${name}`);
      },
    });

    expect(result.status).toBe("READY");
    expect(result.gate?.passed).toBe(true);
    expect(result.readmap?.thePoint.signalIds).toEqual(["s0001"]);
    expect(result.readmap?.rememberThese).toHaveLength(1);
    // RISK-type verified signal lands in caution, citing its signal.
    expect(result.readmap?.caution[0]?.signalIds).toEqual(["s0002"]);
    expect(result.readmap?.numbersWorthRemembering[0]?.numericStatus).toBe("UNVERIFIED_PHASE_1");

    // Evidence persisted BEFORE any model call; readmap persisted last.
    expect(persisted[0]).toBe("evidence.v1.json");
    expect(persisted).toContain("signals.v1.json");
    expect(persisted[persisted.length - 1]).toBe("readmap.v1.json");
    expect(events.filter((e) => e.startsWith("call")).length).toBeGreaterThan(0);
    expect(events.indexOf("persist:evidence.v1.json")).toBeLessThan(
      events.findIndex((e) => e.startsWith("call:")),
    );

    // Honest stage sequence with fixed markers.
    const stageNames = stages.filter((s) => s !== undefined).map((s) => s as string);
    expect(stageNames[0]).toBe("SEGMENTING");
    expect(stageNames).toContain("MAPPING");
    expect(stageNames.at(-1)).toBe("READY");

    // Signal ids are globally unique across chunks (s0001, s0002).
    expect(result.signals.map((s) => s.id)).toEqual(["s0001", "s0002"]);
    // Verdicts are carried; idempotency keys derive from checksum+stage+unit.
    expect(result.signals.every((s) => s.skepticVerdict === "SUPPORTED")).toBe(true);
    expect(calls.some((c) => c.idempotencyKey.endsWith(":VERIFYING:s0001"))).toBe(true);
    expect(calls.some((c) => c.idempotencyKey.endsWith(":COMPRESSING:whole"))).toBe(true);

    // Budget accumulated across every model unit (1 mapper + 2 extraction
    // chunks + 2 verdicts + 1 compression = 6 calls).
    expect(result.usage).toEqual({ inputTokens: 60, outputTokens: 30 });
  });

  it("is PARTIAL_READY when converter warnings must surface", async () => {
    const document = ConvertedDocumentV1Schema.parse({
      schemaVersion: "1.0",
      document: { filename: "report.pdf", sourceType: "pdf", pagesOrSlides: 2, wordCount: 25 },
      blocks: DOCUMENT.blocks,
      warnings: ["Page 2 tables could not be extracted."],
    });
    const { client } = routedClient(QUEUES);
    const result = await runReadmapPipeline({
      jobId: "job1",
      checksumSha256: CHECKSUM,
      document,
      getClient: () => client,
    });
    expect(result.status).toBe("PARTIAL_READY");
    expect(result.warnings).toContain("Page 2 tables could not be extracted.");
  });

  it("fails honestly when an agent unit throws", async () => {
    const base = routedClient(QUEUES).client;
    const throwing: StructuredModelClient = {
      async generate() {
        throw new ModelCallError("provider", "scripted skeptic failure");
      },
    };
    const stages: string[] = [];
    const result = await runReadmapPipeline({
      jobId: "job1",
      checksumSha256: CHECKSUM,
      document: DOCUMENT,
      getClient: (task) => (task === "skeptic" ? throwing : base),
      onStage: (status) => stages.push(status.stage),
    });
    expect(result.status).toBe("FAILED");
    expect(result.failedStage).toBe("VERIFYING");
    expect(stages.at(-1)).toBe("FAILED");
  });
});

describe("chunkBlocks", () => {
  it("splits on section change and size ceiling", () => {
    const chunks = chunkBlocks(DOCUMENT.blocks, 2);
    expect(chunks.map((c) => c.map((b) => b.id))).toEqual([["b0001", "b0002"], ["b0003"]]);
  });
});
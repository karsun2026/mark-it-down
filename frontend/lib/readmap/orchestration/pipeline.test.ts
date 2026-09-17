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
import type { CandidateSignalOutput, DocumentMapV1, VerifiedSignalV1 } from "../schemas/signal";
import {
  ModelCallError,
  type ModelGenerateInput,
  type ModelResult,
  type StructuredModelClient,
} from "../models/client";
import { runReadmapPipeline, chunkBlocks, mapWithConcurrency, assembleReadmap } from "./pipeline";

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

const MAP: DocumentMapV1 = {
  documentType: "Quarterly business report",
  mainThesisCandidates: ["2025 revenue grew 12% year over year"],
  sections: [
    { sectionPath: ["Findings"], purpose: "reports growth", signalDensity: "HIGH", value: "HIGH_VALUE" },
    { sectionPath: ["Risks"], purpose: "lists risks", signalDensity: "LOW", value: "LOW_VALUE" },
  ],
  warnings: [],
};

const GROWTH: CandidateSignalOutput = {
  claim: "Revenue grew 12% year over year.",
  type: "QUANTITATIVE",
  evidenceBlockIds: ["b0001"],
  evidenceQuotes: [{ blockId: "b0001", quote: "Revenue grew 12% year over year." }],
  epistemicStatus: "STATED_FACT",
  warnings: [],
};

const RISK: CandidateSignalOutput = {
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

// The compressor MODEL now returns a single ranked list (compressor.v2); the
// code builds the nested tiers from it. This fixture is served to the scripted
// client for the `compression` task.
const RANKING = {
  ranked: [
    { signalId: "s0001", text: "Revenue grew 12% year over year." },
    { signalId: "s0002", text: "Supply concentration is a key risk." },
  ],
};

// The BUILT tiers shape (CompressedTiersV1), still what assembly consumes —
// used directly by the thePoint-usability test below.
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
  compression: [RANKING],
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
    // §C-4: thePoint and the ONE_THING tier resolve to the same signal by
    // construction (both are rank[0] of the usable-signal ranking); pin it so
    // a future refactor cannot desync the headline from the top tier.
    expect(result.readmap?.thePoint.signalIds[0]).toBe(
      result.tiers?.tiers.ONE_THING[0]?.signalId,
    );
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

describe("mapWithConcurrency (§6-C3)", () => {
  it("preserves order regardless of completion order", async () => {
    const items = Array.from({ length: 20 }, (_, i) => i);
    const result = await mapWithConcurrency(items, 6, async (item) => {
      // Later items resolve first — order must still be input order.
      await new Promise((resolve) => setTimeout(resolve, (20 - item) * 5));
      return item * 2;
    });
    expect(result).toEqual(items.map((i) => i * 2));
  });

  it("never exceeds the concurrency limit", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const items = Array.from({ length: 20 }, (_, i) => i);
    await mapWithConcurrency(items, 4, async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 10));
      inFlight -= 1;
    });
    expect(maxInFlight).toBeLessThanOrEqual(4);
  });
});

describe("per-unit checkpoints (§6-C2: a retry never re-bills)", () => {
  it("makes zero model calls on a fully checkpointed re-run", async () => {
    const store = new Map<string, unknown>();
    const checkpoint = {
      get: async <T,>(key: string): Promise<T | null> =>
        (store.get(key) as T | undefined) ?? null,
      put: async (key: string, value: unknown) => {
        store.set(key, value);
      },
    };

    const first = routedClient(QUEUES);
    const firstResult = await runReadmapPipeline({
      jobId: "job1",
      checksumSha256: CHECKSUM,
      document: DOCUMENT,
      getClient: () => first.client,
      checkpoint,
    });
    expect(firstResult.status).toBe("READY");
    expect(first.calls.length).toBeGreaterThan(0);

    // Second run: every unit is a checkpoint hit, so no model call may happen.
    const second = routedClient(QUEUES);
    const secondResult = await runReadmapPipeline({
      jobId: "job1",
      checksumSha256: CHECKSUM,
      document: DOCUMENT,
      getClient: () => second.client,
      checkpoint,
    });
    expect(second.calls).toHaveLength(0);
    expect(secondResult.status).toBe("READY");
    expect(secondResult.readmap?.thePoint.signalIds).toEqual(["s0001"]);
    // No tokens were spent by the retry — the checkpointed units are reused.
    expect(secondResult.usage).toEqual({ inputTokens: 0, outputTokens: 0 });
  });

  it("falls back to a billed call when the checkpoint store is empty", async () => {
    const { client, calls } = routedClient(QUEUES);
    const result = await runReadmapPipeline({
      jobId: "job1",
      checksumSha256: CHECKSUM,
      document: DOCUMENT,
      getClient: () => client,
      checkpoint: {
        get: async () => null,
        put: async () => {},
      },
    });
    expect(result.status).toBe("READY");
    expect(calls.length).toBeGreaterThan(0);
  });
});

describe("thePoint usability (§6-M3)", () => {
  it("falls back to a usable signal when the READMAP tier cites a non-usable one", () => {
    // §6-M3 defence-in-depth, tested at the assembly boundary: thePoint must
    // resolve to a USABLE signal (SIGNAL_NOT_USABLE at thePoint is
    // unrepairable and would fail the whole job). The compressor's own
    // post-checks already reject most such outputs (§3-M2), so this guards
    // the assembly path directly.
    const signals: VerifiedSignalV1[] = [
      {
        ...GROWTH,
        id: "s0001",
        skepticVerdict: "UNSUPPORTED",
        explanationCode: "NOT_IN_DOCUMENT",
        explanation: "no cited span states this",
      },
      {
        ...RISK,
        id: "s0002",
        skepticVerdict: "SUPPORTED",
        explanationCode: "OK",
        explanation: "stated directly in the cited span",
      },
    ];
    const readmap = assembleReadmap({
      jobId: "job1",
      document: DOCUMENT,
      map: MAP,
      signals,
      // READMAP[0] wrongly cites the UNSUPPORTED signal.
      tiers: {
        ...TIERS,
        tiers: {
          ...TIERS.tiers,
          READMAP: [
            { signalId: "s0001", text: "Revenue grew 12% year over year." },
            { signalId: "s0002", text: "Supply concentration is a key risk." },
          ],
        },
      },
      extraWarnings: [],
    });
    // thePoint falls through to the first USABLE tier entry (s0002), or to
    // the honest fallback — never to the non-usable s0001.
    expect(readmap.thePoint.signalIds).not.toContain("s0001");
    expect(readmap.thePoint.signalIds).toEqual(["s0002"]);
  });
});

describe("scanned-document honesty (plan check 12)", () => {
  // The exact warning the converter emits (converter/app/converters/pdf.py,
  // §36 scan heuristic), verbatim — this test fails loudly if the wording
  // drifts and READMAP stops surfacing it.
  const SCAN_WARNING =
    "Page 2 may be scanned or image-based. Text extraction may be incomplete.";

  it("surfaces the converter's scanned-page warning instead of a confident summary", async () => {
    const document = ConvertedDocumentV1Schema.parse({
      schemaVersion: "1.0",
      document: { filename: "scanned-like.pdf", sourceType: "pdf", pagesOrSlides: 2, wordCount: 25 },
      // The scanned page (page 2) produced NO blocks — only page 1 is here.
      blocks: DOCUMENT.blocks.filter((block) => block.pageNumber === 1),
      warnings: [SCAN_WARNING],
    });
    // Fixtures consistent with a page-1-only document: the mapper can only
    // know the Findings section, and only one signal exists.
    const queues = {
      mapper: [
        {
          documentType: "Quarterly business report",
          mainThesisCandidates: ["2025 revenue grew 12% year over year"],
          sections: [
            { sectionPath: ["Findings"], purpose: "reports growth", signalDensity: "HIGH", value: "HIGH_VALUE" },
          ],
          warnings: [],
        },
      ],
      "signal-extraction": [{ signals: [GROWTH] }],
      skeptic: [SUPPORTED],
      compression: [
        { ranked: [{ signalId: "s0001", text: "Revenue grew 12% year over year." }] },
      ],
    };
    const { client } = routedClient(queues);
    const result = await runReadmapPipeline({
      jobId: "job1",
      checksumSha256: CHECKSUM,
      document,
      getClient: () => client,
    });

    expect(result.status).toBe("PARTIAL_READY");
    expect(result.readmap?.coverage.limitations).toContain(SCAN_WARNING);
    // The result must never claim full coverage when a page was unreadable.
    expect(result.readmap?.coverage.ratio).toBeLessThan(1);
  });
});

describe("coverage honesty with a real page count (BLOCKER-2)", () => {
  it("drops ratio below 1 and surfaces the scan warning when interior pages produced no text", () => {
    // The wiring fix (client -> start -> segmentDocument) threads the
    // converter's true page count and warnings. Here we test the assembly
    // invariant they feed: a 4-page PDF whose pages 2-4 are unreadable (only
    // page 1 produced blocks) must NOT be reported as 100% covered.
    const SCAN_WARNING = "Page 3 may be scanned or image-based. Text extraction may be incomplete.";
    const document = ConvertedDocumentV1Schema.parse({
      schemaVersion: "1.0",
      document: { filename: "partly-scanned.pdf", sourceType: "pdf", pagesOrSlides: 4, wordCount: 12 },
      blocks: [
        block("b0001", "Revenue grew 12% year over year.", ["Page 1"], 1),
        block("b0002", "Management expects moderate growth.", ["Page 1"], 1),
      ],
      warnings: [SCAN_WARNING], // converter warnings, threaded through segmentation
    });
    const signals: VerifiedSignalV1[] = [
      { ...GROWTH, id: "s0001", skepticVerdict: "SUPPORTED", explanationCode: "OK", explanation: "stated directly" },
    ];
    const readmap = assembleReadmap({
      jobId: "job1",
      document,
      map: MAP,
      signals,
      tiers: TIERS,
      extraWarnings: [],
    });
    expect(readmap.coverage.totalPages).toBe(4);
    expect(readmap.coverage.readablePages).toBe(1);
    expect(readmap.coverage.ratio).toBeCloseTo(0.25, 5);
    expect(readmap.coverage.limitations).toContain(SCAN_WARNING);
  });
});
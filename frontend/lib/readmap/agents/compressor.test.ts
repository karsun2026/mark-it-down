/**
 * Compressor agent tests (spec §10.5): the model returns one importance-ranked
 * list; the code builds the six nested tiers from prefixes of it. Nesting and
 * id-resolution are guaranteed by construction (M2 fix), so the old failure
 * modes (dropped/merged selections) can no longer fail the unit.
 */

import { describe, expect, it } from "vitest";

import { COMPRESSOR_PROMPT_VERSION } from "../prompts/compressor";
import { buildTiers, runCompressor, assertSelectionsResolve, type VerifiedSignalRef } from "./compressor";
import { scriptedClient } from "./agent-test-support";
import type { DocumentMapV1 } from "../schemas/signal";

const MAP: DocumentMapV1 = {
  documentType: "Quarterly business report",
  mainThesisCandidates: ["2025 revenue grew 12% year over year"],
  sections: [
    { sectionPath: ["Findings"], purpose: "reports growth", signalDensity: "HIGH", value: "HIGH_VALUE" },
  ],
  warnings: [],
};

const VERIFIED: VerifiedSignalRef[] = [
  { id: "s0001", claim: "Revenue grew 12% year over year.", epistemicStatus: "STATED_FACT" },
  { id: "s0002", claim: "Management expects moderate growth.", epistemicStatus: "FORECAST" },
  { id: "s0003", claim: "Supply concentration is a key risk.", epistemicStatus: "SOURCE_OPINION" },
];

const ranking = (entries: { signalId: string; text: string }[]) => ({ ranked: entries });

describe("buildTiers", () => {
  it("builds nested tiers from prefixes of the ranked list", () => {
    const { tiers, rankingDegraded } = buildTiers(
      [
        { signalId: "s0002", text: "growth outlook" },
        { signalId: "s0001", text: "revenue up 12%" },
        { signalId: "s0003", text: "supply risk" },
      ],
      VERIFIED,
    );
    expect(rankingDegraded).toBe(false);
    // Order follows the model's ranking, not the verified order.
    expect(tiers.tiers.ONE_THING.map((e) => e.signalId)).toEqual(["s0002"]);
    expect(tiers.tiers.DEEP_DIVE.map((e) => e.signalId)).toEqual(["s0002", "s0001", "s0003"]);
    // Every shorter tier is a prefix of every longer one.
    for (const tier of ["ONE_THING", "BRUTAL", "QUICK_SCAN", "BRIEF", "READMAP"] as const) {
      const shorter = tiers.tiers[tier].map((e) => e.signalId);
      const longer = tiers.tiers.DEEP_DIVE.map((e) => e.signalId);
      expect(longer.slice(0, shorter.length)).toEqual(shorter);
    }
  });

  it("drops unknown or merged ids and still yields a valid nested result", () => {
    // "s0001,s0002" is the exact M2 merge failure — it is not a known id.
    const { tiers } = buildTiers(
      [
        { signalId: "s0001,s0002", text: "two facts merged" },
        { signalId: "s0001", text: "revenue" },
        { signalId: "s9999", text: "hallucinated" },
        { signalId: "s0002", text: "growth" },
      ],
      VERIFIED,
    );
    expect(tiers.tiers.ONE_THING.map((e) => e.signalId)).toEqual(["s0001"]);
    // s0003 was omitted by the model; completeness appends it to DEEP_DIVE.
    expect(new Set(tiers.tiers.DEEP_DIVE.map((e) => e.signalId))).toEqual(
      new Set(["s0001", "s0002", "s0003"]),
    );
  });

  it("dedupes repeated ids, keeping first occurrence", () => {
    const { tiers } = buildTiers(
      [
        { signalId: "s0001", text: "a" },
        { signalId: "s0001", text: "dup" },
        { signalId: "s0002", text: "b" },
      ],
      VERIFIED,
    );
    expect(tiers.tiers.DEEP_DIVE.map((e) => e.signalId)).toEqual(["s0001", "s0002", "s0003"]);
    expect(tiers.tiers.ONE_THING).toHaveLength(1);
  });

  it("falls back to document order and flags degradation when the model ranks nothing usable", () => {
    const { tiers, rankingDegraded } = buildTiers(
      [{ signalId: "s0001,s0002", text: "x" }, { signalId: "s9999", text: "y" }],
      VERIFIED,
    );
    expect(rankingDegraded).toBe(true);
    // Every verified signal still appears, in the pipeline's own order.
    expect(tiers.tiers.DEEP_DIVE.map((e) => e.signalId)).toEqual(["s0001", "s0002", "s0003"]);
    expect(tiers.tiers.ONE_THING.map((e) => e.signalId)).toEqual(["s0001"]);
  });

  it("clamps tier sizes when there are fewer signals than the targets", () => {
    const { tiers } = buildTiers([{ signalId: "s0001", text: "only one" }], [VERIFIED[0]!]);
    expect(tiers.tiers.ONE_THING).toHaveLength(1);
    expect(tiers.tiers.DEEP_DIVE).toHaveLength(1);
    expect(tiers.tiers.READMAP).toHaveLength(1);
  });
});

describe("runCompressor", () => {
  it("returns nested tiers built from the model ranking, with the versioned prompt", async () => {
    const { client, calls } = scriptedClient(
      ranking([
        { signalId: "s0001", text: "Revenue grew 12% year over year." },
        { signalId: "s0002", text: "Management expects moderate growth." },
        { signalId: "s0003", text: "Supply concentration is a key risk." },
      ]),
    );
    const run = await runCompressor(client, {
      verified: VERIFIED,
      documentMap: MAP,
      idempotencyKey: "doc1:compress",
    });

    expect(run.promptVersion).toBe(COMPRESSOR_PROMPT_VERSION);
    expect(run.rankingDegraded).toBe(false);
    expect(run.result.value.tiers.ONE_THING.map((e) => e.signalId)).toEqual(["s0001"]);
    expect(run.result.value.tiers.DEEP_DIVE).toHaveLength(3);

    // Input carries only verified signals + the map; no raw evidence.
    const payload = JSON.parse(calls[0]?.messageText ?? "{}") as {
      verifiedSignals: unknown[];
      documentMap: unknown;
    };
    expect(payload.verifiedSignals).toHaveLength(3);
    expect(calls[0]?.system).toContain("may not introduce a new factual proposition");
  });

  it("recovers from a merged-id ranking that would have failed the old design", async () => {
    const { client } = scriptedClient(
      ranking([
        { signalId: "s0001,s0002", text: "two facts jammed into one id" },
        { signalId: "s0001", text: "Revenue grew 12% year over year." },
        { signalId: "s0002", text: "Management expects moderate growth." },
        { signalId: "s0003", text: "Supply concentration is a key risk." },
      ]),
    );
    // Previously this threw AgentContractError and failed the whole job.
    const run = await runCompressor(client, { verified: VERIFIED, documentMap: MAP, idempotencyKey: "k" });
    expect(run.result.value.tiers.ONE_THING.map((e) => e.signalId)).toEqual(["s0001"]);
    expect(run.result.value.tiers.DEEP_DIVE).toHaveLength(3);
  });
});

describe("assertSelectionsResolve (defence-in-depth)", () => {
  it("still throws if built tiers ever cite an unknown signal id", () => {
    const bad = {
      tiers: {
        ONE_THING: [{ signalId: "s9999", text: "x" }],
        BRUTAL: [{ signalId: "s9999", text: "x" }],
        QUICK_SCAN: [{ signalId: "s9999", text: "x" }],
        BRIEF: [{ signalId: "s9999", text: "x" }],
        READMAP: [{ signalId: "s9999", text: "x" }],
        DEEP_DIVE: [{ signalId: "s9999", text: "x" }],
      },
    };
    expect(() => assertSelectionsResolve(bad, VERIFIED)).toThrowError(/not a verified signal/);
  });
});

/**
 * Compressor agent tests (spec §10.5): selections must resolve to verified
 * signals and tiers must nest; this is the mechanism that later lets the UI
 * depth slider change tiers with zero model calls.
 */

import { describe, expect, it } from "vitest";

import { COMPRESSOR_PROMPT_VERSION } from "../prompts/compressor";
import { runCompressor } from "./compressor";
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

const VERIFIED = [
  { id: "s0001", claim: "Revenue grew 12% year over year.", epistemicStatus: "STATED_FACT" },
  { id: "s0002", claim: "Management expects moderate growth.", epistemicStatus: "FORECAST" },
  { id: "s0003", claim: "Supply concentration is a key risk.", epistemicStatus: "SOURCE_OPINION" },
];

function tiersFor(idsPerTier: Record<string, string[]>) {
  return {
    tiers: {
      ONE_THING: (idsPerTier.ONE_THING ?? []).map((id) => ({ signalId: id, text: `t-${id}` })),
      BRUTAL: (idsPerTier.BRUTAL ?? []).map((id) => ({ signalId: id, text: `t-${id}` })),
      QUICK_SCAN: (idsPerTier.QUICK_SCAN ?? []).map((id) => ({ signalId: id, text: `t-${id}` })),
      BRIEF: (idsPerTier.BRIEF ?? []).map((id) => ({ signalId: id, text: `t-${id}` })),
      READMAP: (idsPerTier.READMAP ?? []).map((id) => ({ signalId: id, text: `t-${id}` })),
      DEEP_DIVE: (idsPerTier.DEEP_DIVE ?? []).map((id) => ({ signalId: id, text: `t-${id}` })),
    },
  };
}

const GOOD_TIERS = tiersFor({
  ONE_THING: ["s0001"],
  BRUTAL: ["s0001", "s0002"],
  QUICK_SCAN: ["s0001", "s0002", "s0003"],
  BRIEF: ["s0001", "s0002", "s0003"],
  READMAP: ["s0001", "s0002", "s0003"],
  DEEP_DIVE: ["s0001", "s0002", "s0003"],
});

describe("runCompressor", () => {
  it("returns nested tiers with the versioned prompt", async () => {
    const { client, calls } = scriptedClient(GOOD_TIERS);
    const run = await runCompressor(client, {
      verified: VERIFIED,
      documentMap: MAP,
      idempotencyKey: "doc1:compress",
    });

    expect(run.promptVersion).toBe(COMPRESSOR_PROMPT_VERSION);
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

  it("fails the unit when a selected id is not a verified signal", async () => {
    const { client } = scriptedClient(
      tiersFor({
        ONE_THING: ["s9999"],
        BRUTAL: ["s0001", "s9999"],
        QUICK_SCAN: ["s0001", "s0002", "s9999"],
        BRIEF: ["s0001", "s0002", "s0003", "s9999"],
        READMAP: ["s0001", "s0002", "s0003", "s9999"],
        DEEP_DIVE: ["s0001", "s0002", "s0003", "s9999"],
      }),
    );
    await expect(
      runCompressor(client, { verified: VERIFIED, documentMap: MAP, idempotencyKey: "k" }),
    ).rejects.toThrowError(/not a verified signal/);
  });

  it("fails the unit when nesting is violated", async () => {
    const { client } = scriptedClient(
      tiersFor({
        ONE_THING: ["s0001"],
        BRUTAL: ["s0002"], // s0001 dropped
        QUICK_SCAN: ["s0001", "s0002", "s0003"],
        BRIEF: ["s0001", "s0002", "s0003"],
        READMAP: ["s0001", "s0002", "s0003"],
        DEEP_DIVE: ["s0001", "s0002", "s0003"],
      }),
    );
    await expect(
      runCompressor(client, { verified: VERIFIED, documentMap: MAP, idempotencyKey: "k" }),
    ).rejects.toThrowError(/nesting invariant/);
  });

  it("fails the unit when ONE_THING holds more than one signal", async () => {
    const { client } = scriptedClient(
      tiersFor({
        ONE_THING: ["s0001", "s0002"],
        BRUTAL: ["s0001", "s0002"],
        QUICK_SCAN: ["s0001", "s0002", "s0003"],
        BRIEF: ["s0001", "s0002", "s0003"],
        READMAP: ["s0001", "s0002", "s0003"],
        DEEP_DIVE: ["s0001", "s0002", "s0003"],
      }),
    );
    await expect(
      runCompressor(client, { verified: VERIFIED, documentMap: MAP, idempotencyKey: "k" }),
    ).rejects.toThrowError(/exactly one/);
  });
});
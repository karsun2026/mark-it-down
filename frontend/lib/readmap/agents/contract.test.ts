/**
 * Deterministic contract-check tests (spec §10; plan acceptance checks 7–8
 * groundwork). These functions are also what the grounding gate will reuse,
 * so they are tested independently of any model call.
 */

import { describe, expect, it } from "vitest";

import type { EvidenceBlockInput } from "../schemas/evidence";
import { COMPRESSION_TIERS, type CompressedTiersV1 } from "../schemas/signal";
import {
  AgentContractError,
  assertTierNesting,
  quoteIsVerbatim,
  validateSignalCitations,
} from "./contract";

const text = "Revenue grew 12% year over year. Management expects moderate growth.";

function block(id: string, body: string): EvidenceBlockInput {
  return {
    id,
    pageNumber: 1,
    sectionPath: ["Findings"],
    blockType: "PARAGRAPH",
    normalizedText: body,
    sourceText: body,
    extractionMethods: ["MARKDOWN"],
    contentHash: "0".repeat(64),
  };
}

describe("quoteIsVerbatim", () => {
  it("accepts an exact span of the block text", () => {
    expect(
      quoteIsVerbatim("Revenue grew 12% year over year.", {
        normalizedText: text,
        sourceText: text,
      }),
    ).toBe(true);
  });

  it("accepts a span that differs only in whitespace", () => {
    expect(
      quoteIsVerbatim("Revenue  grew\n12% year over year.", {
        normalizedText: text,
        sourceText: text,
      }),
    ).toBe(true);
  });

  it("rejects paraphrase and mixed-span fabrication", () => {
    expect(
      quoteIsVerbatim("Revenue grew 20% year over year.", {
        normalizedText: text,
        sourceText: text,
      }),
    ).toBe(false);
    expect(
      quoteIsVerbatim("revenue grew 12% year over year", {
        normalizedText: text,
        sourceText: text,
      }),
    ).toBe(false);
  });
});

describe("validateSignalCitations", () => {
  const blocks = [block("b0001", text), block("b0002", "Churn is stable.")];

  it("accepts citations that resolve and quotes that are verbatim", () => {
    expect(() =>
      validateSignalCitations(
        [
          {
            evidenceBlockIds: ["b0001"],
            evidenceQuotes: [{ blockId: "b0001", quote: "Revenue grew 12%" }],
          },
        ],
        blocks,
      ),
    ).not.toThrow();
  });

  it("fails when a cited block was never supplied", () => {
    expect(() =>
      validateSignalCitations(
        [
          {
            evidenceBlockIds: ["b9999"],
            evidenceQuotes: [{ blockId: "b9999", quote: "anything" }],
          },
        ],
        blocks,
      ),
    ).toThrowError(AgentContractError);
  });

  it("fails when a quote is not a verbatim span of its block", () => {
    expect(() =>
      validateSignalCitations(
        [
          {
            evidenceBlockIds: ["b0002"],
            evidenceQuotes: [{ blockId: "b0002", quote: "Churn doubled." }],
          },
        ],
        blocks,
      ),
    ).toThrowError(/not a verbatim span/);
  });

  it("fails when a quoted block is not listed in evidenceBlockIds", () => {
    expect(() =>
      validateSignalCitations(
        [
          {
            evidenceBlockIds: ["b0001"],
            evidenceQuotes: [{ blockId: "b0002", quote: "Churn is stable." }],
          },
        ],
        blocks,
      ),
    ).toThrowError(/without listing it/);
  });
});

describe("assertTierNesting", () => {
  const tier = (ids: string[]) => ids.map((signalId) => ({ signalId, text: `text ${signalId}` }));

  function tiersFor(idsPerTier: Record<string, string[]>): CompressedTiersV1 {
    return {
      tiers: {
        ONE_THING: tier(idsPerTier.ONE_THING ?? []),
        BRUTAL: tier(idsPerTier.BRUTAL ?? []),
        QUICK_SCAN: tier(idsPerTier.QUICK_SCAN ?? []),
        BRIEF: tier(idsPerTier.BRIEF ?? []),
        READMAP: tier(idsPerTier.READMAP ?? []),
        DEEP_DIVE: tier(idsPerTier.DEEP_DIVE ?? []),
      },
    };
  }

  it("accepts a fully nested tier ladder", () => {
    const tiers = tiersFor({
      ONE_THING: ["s0001"],
      BRUTAL: ["s0001", "s0002"],
      QUICK_SCAN: ["s0001", "s0002", "s0003"],
      BRIEF: ["s0001", "s0002", "s0003", "s0004"],
      READMAP: ["s0001", "s0002", "s0003", "s0004", "s0005"],
      DEEP_DIVE: ["s0001", "s0002", "s0003", "s0004", "s0005", "s0006"],
    });
    expect(() => assertTierNesting(tiers)).not.toThrow();
  });

  it("requires exactly one ONE_THING signal", () => {
    const tiers = tiersFor({ ONE_THING: ["s0001", "s0002"], DEEP_DIVE: ["s0001", "s0002"] });
    expect(() => assertTierNesting(tiers)).toThrowError(/exactly one/);
  });

  it("rejects a shorter tier that is not a subset of the longer one", () => {
    const tiers = tiersFor({
      ONE_THING: ["s0001"],
      BRUTAL: ["s0002"],
      QUICK_SCAN: ["s0001", "s0002"],
      BRIEF: ["s0001", "s0002"],
      READMAP: ["s0001", "s0002"],
      DEEP_DIVE: ["s0001", "s0002"],
    });
    expect(() => assertTierNesting(tiers)).toThrowError(/nesting invariant/);
  });

  it("rejects duplicate ids inside a tier", () => {
    const tiers = tiersFor({
      ONE_THING: ["s0001"],
      BRUTAL: ["s0001"],
      QUICK_SCAN: ["s0001"],
      BRIEF: ["s0001"],
      READMAP: ["s0001"],
      DEEP_DIVE: ["s0001", "s0001"],
    });
    expect(() => assertTierNesting(tiers)).toThrowError(/duplicate/);
  });

  it("walks the tiers in the spec's nesting order", () => {
    expect(COMPRESSION_TIERS).toEqual([
      "ONE_THING",
      "BRUTAL",
      "QUICK_SCAN",
      "BRIEF",
      "READMAP",
      "DEEP_DIVE",
    ]);
  });
});
/**
 * Numeric guard tests (review §6-M1): value-based comparison. Reworded units
 * and separators must preserve (`$1.5bn` ≡ `1.5 billion`, `12%` ≡
 * `12 percent`, `1,000` ≡ `1000`); a genuinely dropped number must fail.
 */

import { describe, expect, it } from "vitest";

import { canonicalNumbers, numbersPreserved } from "./numeric-guard";

describe("numbersPreserved (§6-M1 value-based comparison)", () => {
  it("preserves unit rewordings: $1.5bn ≡ 1.5 billion", () => {
    expect(
      numbersPreserved("The acquisition cost $1.5bn.", "The acquisition cost 1.5 billion dollars."),
    ).toBe(true);
  });

  it("preserves percentage rewordings: 12% ≡ 12 percent", () => {
    expect(
      numbersPreserved("Revenue grew 12% year over year.", "Revenue grew 12 percent year over year."),
    ).toBe(true);
  });

  it("preserves thousands separators: 1,000 ≡ 1000", () => {
    expect(numbersPreserved("About 1,000 units shipped.", "About 1000 units shipped.")).toBe(true);
  });

  it("fails when a number is genuinely dropped", () => {
    expect(numbersPreserved("Revenue grew 12% year over year.", "Revenue grew substantially.")).toBe(
      false,
    );
  });

  it("fails when the value is changed, not just respelled", () => {
    expect(numbersPreserved("Margin was 12%.", "Margin was 21 percent.")).toBe(false);
  });

  it("trivially preserves text with no numbers", () => {
    expect(numbersPreserved("Growth continued.", "Growth continued.")).toBe(true);
  });
});

describe("canonicalNumbers", () => {
  it("canonicalizes percent and magnitude spellings to stable keys", () => {
    expect(canonicalNumbers("12% and 12 percent")).toEqual(new Set(["pct:12"]));
    expect(canonicalNumbers("$1.5bn or 1.5 billion")).toEqual(new Set(["num:1500000000"]));
    expect(canonicalNumbers("1,000")).toEqual(new Set(["num:1000"]));
  });
});
/**
 * Numeric guard for the grounding gate (spec §11 items 4 and 10; plan §8).
 *
 * Phase 1 scope is honest and narrow:
 *
 * - §11.10 (deterministic approximation): a rendering that drops a number
 *   present in its verified claim fails the gate — compression may remove
 *   detail but not numeric meaning (rule 11).
 * - §11.4 (independent numeric validation) is DEFERRED to Phase 3 and is
 *   reported as such by the gate; it can never silently pass. Phase 1 numbers
 *   are preserved verbatim in quotes and visibly labelled UNVERIFIED.
 *
 * Comparison is VALUE-based, not token-based: the same numeric value must
 * survive in any spelling (`$1.5bn` ≡ `1.5 billion`, `12%` ≡ `12 percent`,
 * `1,000` ≡ `1000`). Requiring identical token spellings produced
 * false-positive gate failures on legitimate rewordings (review §3-M1).
 */

export const NUMERIC_CHECK_DEFERRED =
  "NUMERIC_INDEPENDENT_VALIDATION_DEFERRED_TO_PHASE_3" as const;

const MULTIPLIER: Record<string, number> = {
  k: 1e3, thousand: 1e3, m: 1e6, million: 1e6, bn: 1e9, billion: 1e9,
};

/** Canonical numeric values in a text: percentages and magnitudes, unit-normalized. */
export function canonicalNumbers(text: string): Set<string> {
  const set = new Set<string>();
  const re =
    /(\d[\d,]*(?:\.\d+)?)\s*(%|percent|per cent|bn|billion|m|million|k|thousand)?/gi;
  for (const match of text.matchAll(re)) {
    const value = Number.parseFloat((match[1] ?? "").replace(/,/g, ""));
    if (!Number.isFinite(value)) continue;
    const unit = match[2]?.toLowerCase();
    if (unit === "%" || unit === "percent" || unit === "per cent") {
      set.add(`pct:${value}`);
    } else if (unit && unit in MULTIPLIER) {
      set.add(`num:${value * MULTIPLIER[unit]!}`);
    } else {
      set.add(`num:${value}`);
    }
  }
  return set;
}

/** True when every numeric value in `claim` survives (in any spelling) in `rendering`. */
export function numbersPreserved(claimText: string, rendering: string): boolean {
  const available = canonicalNumbers(rendering);
  for (const token of canonicalNumbers(claimText)) {
    if (!available.has(token)) return false;
  }
  return true;
}
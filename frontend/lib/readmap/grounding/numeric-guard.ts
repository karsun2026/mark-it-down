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
 * Comparison is exact-token based: the same numeric token, extracted
 * deterministically, must appear in the rendering.
 */

export const NUMERIC_CHECK_DEFERRED =
  "NUMERIC_INDEPENDENT_VALIDATION_DEFERRED_TO_PHASE_3" as const;

/**
 * Number tokens in a text: percentages, currency, magnitudes, years, and
 * plain integers/decimals. Deliberately conservative — this decides whether a
 * claim's numbers survive compression, so a false negative (requiring a
 * number that is not there) is worse than a false positive.
 */
export function extractNumberTokens(text: string): string[] {
  const matches = text.match(
    /\d+(?:[.,]\d+)*(?:\s?%|\s?(?:bn|billion|m|million|k|thousand))?/gi,
  );
  return matches ?? [];
}

/** Normalized form used for comparison (collapse whitespace/case). */
function normalized(token: string): string {
  return token.replace(/\s+/g, "").toLowerCase();
}

/**
 * True when every number in `claim` survives in `rendering`. Empty numeric
 * content trivially preserves.
 */
export function numbersPreserved(claimText: string, rendering: string): boolean {
  const required = extractNumberTokens(claimText);
  const available = extractNumberTokens(rendering).map(normalized);
  return required.every((token) => available.includes(normalized(token)));
}
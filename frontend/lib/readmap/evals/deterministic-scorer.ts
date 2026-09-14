/**
 * Deterministic scorer, ported verbatim from
 * readmap-eval-harness/src/deterministic-scorer.ts (plan §2). Pure functions
 * over a ReadMapEvalOutput — no model, no network, fully offline.
 */

import type {
  CheckResult,
  CompressionTier,
  EvalFixture,
  FixtureScore,
  NumericAtom,
  ReadMapEvalOutput,
} from "./types";

const ORDER: CompressionTier[] = [
  "ONE_THING",
  "BRUTAL",
  "QUICK_SCAN",
  "BRIEF",
  "READMAP",
  "DEEP_DIVE",
];

function result(
  fixtureId: string,
  check: string,
  passed: boolean,
  severity: CheckResult["severity"],
  details?: string,
  claimId?: string,
): CheckResult {
  return { fixtureId, check, passed, severity, details, claimId };
}

function normalized(value?: string): string {
  return (value ?? "").trim().toUpperCase();
}

function numericAtomMatches(actual: NumericAtom, expected: NumericAtom): boolean {
  const tolerance = Math.max(Math.abs(expected.value) * 0.0001, 1e-9);
  return (
    Math.abs(actual.value - expected.value) <= tolerance &&
    normalized(actual.unit) === normalized(expected.unit) &&
    normalized(actual.scale) === normalized(expected.scale) &&
    normalized(actual.currency) === normalized(expected.currency) &&
    normalized(actual.period) === normalized(expected.period) &&
    normalized(actual.direction) === normalized(expected.direction) &&
    normalized(actual.status) === normalized(expected.status)
  );
}

export function scoreDeterministic(
  fixture: EvalFixture,
  output: ReadMapEvalOutput,
): FixtureScore {
  const checks: CheckResult[] = [];
  const evidenceIds = new Set(output.evidenceBlocks.map((block) => block.id));
  const supportedSignals = new Set(output.supportedSignalIds);

  let totalCitations = 0;
  let validCitations = 0;
  let unsupportedClaimCount = 0;
  let numericIssueCount = 0;

  for (const claim of output.claims) {
    for (const blockId of claim.evidenceBlockIds) {
      totalCitations += 1;
      const valid = evidenceIds.has(blockId);
      if (valid) validCitations += 1;
      checks.push(
        result(
          fixture.id,
          "citation_resolves",
          valid,
          "CRITICAL",
          valid ? undefined : `Unknown evidence block: ${blockId}`,
          claim.id,
        ),
      );
    }

    if (claim.epistemicStatus !== "INTERPRETATION") {
      const supported =
        claim.signalIds.length > 0 &&
        claim.signalIds.every((id) => supportedSignals.has(id));
      if (!supported) unsupportedClaimCount += 1;
      checks.push(
        result(
          fixture.id,
          "claim_uses_supported_signals",
          supported,
          "CRITICAL",
          supported ? undefined : "Factual claim contains an unsupported or missing signal ID.",
          claim.id,
        ),
      );
    }

    for (const pattern of fixture.expected.forbiddenClaimPatterns) {
      const forbidden = new RegExp(pattern, "i").test(claim.text);
      if (forbidden) unsupportedClaimCount += 1;
      checks.push(
        result(
          fixture.id,
          "forbidden_claim_absent",
          !forbidden,
          "CRITICAL",
          forbidden ? `Matched forbidden pattern: ${pattern}` : undefined,
          claim.id,
        ),
      );
    }
  }

  let nestedPairs = 0;
  let passingPairs = 0;
  for (let index = 0; index < ORDER.length - 1; index += 1) {
    // Indexing guards for strict noUncheckedIndexedAccess; unreachable by
    // construction (index < ORDER.length - 1). Purely type-level adaptation,
    // logic identical to the harness.
    const shorterTier: CompressionTier | undefined = ORDER[index];
    const longerTier: CompressionTier | undefined = ORDER[index + 1];
    if (!shorterTier || !longerTier) continue;
    const shorter = output.tiers[shorterTier];
    const longer = new Set(output.tiers[longerTier]);
    const nested = shorter.every((signalId: string) => longer.has(signalId));
    nestedPairs += 1;
    if (nested) passingPairs += 1;
    checks.push(
      result(
        fixture.id,
        `tier_nested_${shorterTier}_in_${longerTier}`,
        nested,
        "CRITICAL",
      ),
    );
  }

  const coverage =
    output.totalPages === 0 ? 0 : output.recoveredPages / output.totalPages;
  if (fixture.expected.requiresCoverageWarning) {
    checks.push(
      result(
        fixture.id,
        "coverage_warning_shown",
        output.coverageWarningShown,
        "CRITICAL",
        output.coverageWarningShown
          ? undefined
          : `Coverage was ${(coverage * 100).toFixed(1)}%.`,
      ),
    );
  }

  for (const expectedNumber of fixture.expected.expectedNumbers ?? []) {
    const actualNumbers = output.claims.flatMap((claim) => claim.numbers ?? []);
    const found = actualNumbers.some((actual) => numericAtomMatches(actual, expectedNumber));
    if (!found) numericIssueCount += 1;
    checks.push(
      result(
        fixture.id,
        "expected_number_preserved_with_context",
        found,
        "CRITICAL",
        found
          ? undefined
          : `Missing or contextually altered numeric atom: ${JSON.stringify(expectedNumber)}`,
      ),
    );
  }

  return {
    fixtureId: fixture.id,
    checks,
    citationValidity: totalCitations === 0 ? 0 : validCitations / totalCitations,
    compressionNesting: nestedPairs === 0 ? 0 : passingPairs / nestedPairs,
    unsupportedClaimCount,
    numericIssueCount,
  };
}
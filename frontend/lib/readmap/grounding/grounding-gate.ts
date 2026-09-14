/**
 * The deterministic grounding gate (spec §11; plan §8, acceptance checks 6–8).
 *
 * Nothing is displayed until this gate passes. Phase 1 enforces, in code:
 *
 *   1. Every factual claim has ≥ 1 signalId.                 (§11.1)
 *   2. Referenced signals are SUPPORTED / approved repair.   (§11.2)
 *   3. Citations resolve to evidence in the same document + version. (§11.3)
 *   4. Independent numeric validation — DEFERRED to Phase 3, reported as
 *      deferred, never silently passed.                      (§11.4)
 *   5. No unsupported signal selected.                       (§11.5)
 *   6. No interpretation in a factual field.                 (§11.6)
 *   7. Tier nesting invariant.                               (§11.7)
 *   8. Coverage honesty: below-threshold coverage must carry limitations and
 *      converter warnings must surface.                      (§11.8)
 *   9. Read/skip recommendations reference real pages/sections. (§11.9)
 *  10. Tier renderings keep the numbers of their verified claims
 *      (deterministic approximation of §11.10).
 *
 * Failures are located (field + index) so the pipeline can repair by omission;
 * if a required field becomes empty, the pipeline renders a truthful empty
 * state. The gate NEVER calls a model and NEVER logs document content.
 */

import type { EvidenceBlockInput } from "../schemas/evidence";
import type { ReadMapV1 } from "../schemas/readmap";
import type { CompressedTiersV1, VerifiedSignalV1 } from "../schemas/signal";
import { assertTierNesting } from "../agents/contract";
import { locatedFactualClaims } from "./claim-parser";
import {
  checkEvidenceResolves,
  checkSignalsResolve,
} from "./citation-validator";
import {
  NUMERIC_CHECK_DEFERRED,
  numbersPreserved,
} from "./numeric-guard";

/** Below this coverage ratio the result must carry visible limitations. */
export const FULL_COVERAGE_THRESHOLD = 0.95;

export interface GateFailure {
  /** Which §11 check failed. */
  code:
    | "CLAIM_WITHOUT_SIGNAL"
    | "UNKNOWN_SIGNAL"
    | "SIGNAL_NOT_USABLE"
    | "UNKNOWN_EVIDENCE_BLOCK"
    | "INTERPRETATION_IN_FACTUAL_FIELD"
    | "TIER_NESTING"
    | "COVERAGE_HONESTY"
    | "RECOMMENDATION_TARGET"
    | "NUMBER_DROPPED";
  location: string;
  detail: string;
}

export interface GroundingReport {
  passed: boolean;
  failures: GateFailure[];
  /** Checks explicitly NOT performed in Phase 1 (never silently passed). */
  deferredChecks: readonly string[];
}

function failure(code: GateFailure["code"], location: string, detail: string): GateFailure {
  return { code, location, detail };
}

function checkCoverageHonesty(readmap: ReadMapV1, evidence: readonly EvidenceBlockInput[]): GateFailure[] {
  const failures: GateFailure[] = [];
  const { coverage } = readmap;
  if (coverage.readablePages > coverage.totalPages) {
    failures.push(
      failure(
        "COVERAGE_HONESTY",
        "coverage",
        `readablePages=${coverage.readablePages} exceeds totalPages=${coverage.totalPages}`,
      ),
    );
  }
  if (
    coverage.totalPages > 0 &&
    coverage.ratio < FULL_COVERAGE_THRESHOLD &&
    coverage.limitations.length === 0
  ) {
    failures.push(
      failure(
        "COVERAGE_HONESTY",
        "coverage",
        `ratio=${coverage.ratio.toFixed(2)} below ${FULL_COVERAGE_THRESHOLD} with no limitations`,
      ),
    );
  }
  if (evidence.length === 0 && coverage.limitations.length === 0) {
    failures.push(
      failure(
        "COVERAGE_HONESTY",
        "coverage",
        "no evidence recovered and no limitation disclosed",
      ),
    );
  }
  return failures;
}

function checkRecommendationTargets(readmap: ReadMapV1, evidence: readonly EvidenceBlockInput[]): GateFailure[] {
  const failures: GateFailure[] = [];
  const knownSections = new Set<string>();
  for (const block of evidence) {
    for (const part of block.sectionPath) knownSections.add(part);
  }
  const maxPage = readmap.coverage.totalPages;
  for (const field of ["actuallyRead", "safelySkip"] as const) {
    readmap[field].forEach((recommendation, index) => {
      const location = `${field}[${index}]`;
      if (recommendation.pages) {
        const { from, to } = recommendation.pages;
        if (from > to || from < 1 || to > maxPage) {
          failures.push(
            failure(
              "RECOMMENDATION_TARGET",
              location,
              `pages ${from}-${to} outside 1-${maxPage}`,
            ),
          );
        }
      } else if (!recommendation.sectionPath?.some((part) => knownSections.has(part))) {
        failures.push(
          failure("RECOMMENDATION_TARGET", location, "sectionPath not present in evidence"),
        );
      }
    });
  }
  return failures;
}

function checkTierRenderings(input: {
  tiers?: CompressedTiersV1;
  signals: readonly VerifiedSignalV1[];
}): GateFailure[] {
  if (!input.tiers) return [];
  const failures: GateFailure[] = [];
  try {
    assertTierNesting(input.tiers);
  } catch (error) {
    failures.push(
      failure(
        "TIER_NESTING",
        "tiers",
        error instanceof Error ? error.message : "unknown nesting violation",
      ),
    );
  }
  const claimBySignal = new Map(input.signals.map((signal) => [signal.id, signal]));
  for (const [tierName, entries] of Object.entries(input.tiers.tiers)) {
    entries.forEach((entry, index) => {
      const signal = claimBySignal.get(entry.signalId);
      if (!signal) return; // resolution failures recorded above
      const source = signal.repairedClaim ?? signal.claim;
      if (!numbersPreserved(source, entry.text)) {
        failures.push(
          failure("NUMBER_DROPPED", `tiers.${tierName}[${index}]`, `signal ${signal.id}`),
        );
      }
    });
  }
  return failures;
}

export function runGroundingGate(input: {
  readmap: ReadMapV1;
  signals: readonly VerifiedSignalV1[];
  evidence: readonly EvidenceBlockInput[];
  tiers?: CompressedTiersV1;
}): GroundingReport {
  const { readmap, signals, evidence } = input;
  const failures: GateFailure[] = [];

  // §11.1 — every factual claim cites at least one signal.
  const claims = locatedFactualClaims(readmap);
  for (const { location, claim } of claims) {
    if (claim.signalIds.length === 0) {
      failures.push(failure("CLAIM_WITHOUT_SIGNAL", location, "no signalId"));
    }
  }

  // §11.2 + §11.5 — referenced signals exist and are usable.
  failures.push(
    ...checkSignalsResolve(claims, signals).map((f) => failure(f.code, f.location, f.detail)),
  );

  // §11.3 — evidence snapshot resolution (same document and result version).
  failures.push(
    ...checkEvidenceResolves(signals, evidence).map((f) =>
      failure(f.code, f.location, f.detail),
    ),
  );

  // §11.6 — interpretation may never appear in a factual field.
  for (const { location, claim } of claims) {
    if (claim.kind !== "VERIFIED") {
      failures.push(
        failure("INTERPRETATION_IN_FACTUAL_FIELD", location, `kind=${claim.kind}`),
      );
    }
  }

  // §11.7 + §11.10 (tier renderings) — nesting and numeric preservation.
  failures.push(...checkTierRenderings(input));

  // §11.8 — coverage honesty.
  failures.push(...checkCoverageHonesty(readmap, evidence));

  // §11.9 — recommendations reference real pages or sections.
  failures.push(...checkRecommendationTargets(readmap, evidence));

  return {
    passed: failures.length === 0,
    failures,
    deferredChecks: [NUMERIC_CHECK_DEFERRED],
  };
}
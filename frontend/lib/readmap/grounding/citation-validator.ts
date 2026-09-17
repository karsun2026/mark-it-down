/**
 * Citation resolution for the grounding gate (spec §11 items 1–3 and 5;
 * plan acceptance check 8).
 *
 * A citation resolves only to immutable evidence from the SAME document and
 * result version: a signal id must exist in this run's verified-signal store
 * and be usable (SUPPORTED, or PARTIAL whose approved repaired claim is what
 * is rendered), and every cited signal's evidence blocks must exist in this
 * job's evidence snapshot (rule 9: no source, no signal).
 *
 * Failure messages carry ids and locations only (rule 16) — never claim text
 * or quotes.
 */

import type { EvidenceBlockInput } from "../schemas/evidence";
import { isUsableSignal, type VerifiedSignalV1 } from "../schemas/signal";
import type { LocatedClaim } from "./claim-parser";

export type CitationFailureCode =
  | "UNKNOWN_SIGNAL"
  | "SIGNAL_NOT_USABLE"
  | "UNKNOWN_EVIDENCE_BLOCK";

export interface CitationFailure {
  code: CitationFailureCode;
  location: string;
  /** Ids only — never document content. */
  detail: string;
}

/**
 * Every referenced signal must exist in this run's store and be usable
 * (spec §11.2: SUPPORTED, or the approved repaired claim; §11.5: no
 * unsupported signal selected).
 */
export function checkSignalsResolve(
  claims: readonly LocatedClaim[],
  signals: readonly VerifiedSignalV1[],
): { code: CitationFailureCode; location: string; detail: string }[] {
  const byId = new Map(signals.map((signal) => [signal.id, signal]));
  const failures: { code: CitationFailureCode; location: string; detail: string }[] = [];
  for (const { location, claim } of claims) {
    for (const signalId of claim.signalIds) {
      const signal = byId.get(signalId);
      if (!signal) {
        failures.push({ code: "UNKNOWN_SIGNAL", location, detail: signalId });
        continue;
      }
      if (!isUsableSignal(signal)) {
        failures.push({
          code: "SIGNAL_NOT_USABLE",
          location,
          detail: `${signalId} verdict=${signal.skepticVerdict}`,
        });
      }
    }
  }
  return failures;
}

/**
 * Every cited signal's evidence blocks must exist in this job's evidence
 * snapshot — same document, same version (spec §11.3).
 */
export function checkEvidenceResolves(
  signals: readonly VerifiedSignalV1[],
  evidence: readonly EvidenceBlockInput[],
): { code: CitationFailureCode; location: string; detail: string }[] {
  const blockIds = new Set(evidence.map((block) => block.id));
  const failures: { code: CitationFailureCode; location: string; detail: string }[] = [];
  for (const signal of signals) {
    for (const blockId of signal.evidenceBlockIds) {
      if (!blockIds.has(blockId)) {
        failures.push({ code: "UNKNOWN_EVIDENCE_BLOCK", location: signal.id, detail: blockId });
      }
    }
  }
  return failures;
}
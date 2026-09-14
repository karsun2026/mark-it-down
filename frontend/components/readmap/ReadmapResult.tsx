"use client";

/**
 * The READMAP result (spec §12): the point, the list, numbers, caution —
 * every entry rendering its tier text and opening the evidence behind its
 * signalId. Numbers are labelled per Phase 1 honesty: traceable to the
 * document, NOT independently verified.
 */

import { useState } from "react";

import { EvidenceDrawer } from "@/components/readmap/EvidenceDrawer";
import type { ReadmapOutcome } from "@/lib/readmap/readmap-client";
import { fetchEvidence } from "@/lib/readmap/readmap-client";
import type { CompressionPreset } from "@/lib/readmap/schemas/signal";

interface ReadmapResultProps {
  outcome: ReadmapOutcome;
  preset: CompressionPreset;
}

export function ReadmapResult({ outcome, preset }: ReadmapResultProps) {
  const [openSignal, setOpenSignal] = useState<string | null>(null);
  const tier = outcome.tiers?.tiers[preset] ?? null;

  return (
    <>
      {outcome.status === "PARTIAL_READY" && outcome.warnings.length > 0 && (
        <div className="notice" role="note">
          <p className="notice-title">Part of the document was not readable</p>
          <ul>
            {outcome.warnings.map((warning) => (
              <li key={warning}>{warning}</li>
            ))}
          </ul>
        </div>
      )}

      {tier ? (
        <section className="readmap-tier">
          <h2 className="tier-title">
            {preset === "ONE_THING" ? "The point" : "Worth your time"}
          </h2>
          <ul className="claim-list">
            {tier.map((entry) => (
              <li key={entry.signalId} className="claim">
                <span>{entry.text}</span>
                <button
                  type="button"
                  className="cite"
                  onClick={() => setOpenSignal(entry.signalId)}
                >
                  source
                </button>
              </li>
            ))}
          </ul>
        </section>
      ) : (
        <p className="muted">No verified signals at this depth.</p>
      )}

      {outcome.readmap.numbersWorthRemembering.length > 0 && (
        <section>
          <h2 className="tier-title">Numbers worth remembering</h2>
          <ul className="claim-list">
            {outcome.readmap.numbersWorthRemembering.map((number) => (
              <li key={number.signalIds.join(",")} className="claim">
                <span>
                  {number.text}
                  <span className="muted"> (not independently verified)</span>
                </span>
                <button
                  type="button"
                  className="cite"
                  onClick={() => setOpenSignal(number.signalIds[0] ?? null)}
                >
                  source
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      {outcome.readmap.caution.length > 0 && (
        <section>
          <h2 className="tier-title">Treat with caution</h2>
          <ul className="claim-list">
            {outcome.readmap.caution.map((claim) => (
              <li key={claim.signalIds.join(",")} className="claim">
                <span>{claim.text}</span>
                <button
                  type="button"
                  className="cite"
                  onClick={() => setOpenSignal(claim.signalIds[0] ?? null)}
                >
                  source
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      <EvidenceDrawer
        signalId={openSignal}
        onClose={() => setOpenSignal(null)}
        resolve={(id, signal) =>
          fetchEvidence(
            outcome.jobToken,
            outcome.resultPathname,
            id,
            signal,
          )
        }
      />
    </>
  );
}
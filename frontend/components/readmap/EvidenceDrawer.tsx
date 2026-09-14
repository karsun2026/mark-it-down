"use client";

/**
 * Evidence drawer (spec §2 step 10): the exact document text behind a claim.
 *
 * The blocks are resolved SERVER-SIDE by /api/readmap/evidence/[signalId]
 * from the same job's immutable evidence snapshot; the client only names the
 * signalId and presents what the server returns. Attribution and forecast
 * status stay visible; the wording is the document's, not a paraphrase.
 */

import { useEffect, useState } from "react";

import type { EvidenceResponse } from "@/lib/readmap/readmap-client";

interface EvidenceDrawerProps {
  /** The open signal id, or null when closed. */
  signalId: string | null;
  onClose: () => void;
  resolve: (signalId: string, signal: AbortSignal) => Promise<EvidenceResponse>;
}

export function EvidenceDrawer({ signalId, onClose, resolve }: EvidenceDrawerProps) {
  const [state, setState] = useState<
    { kind: "closed" } | { kind: "loading" } | { kind: "error"; message: string } | { kind: "open"; data: EvidenceResponse }
  >({ kind: "closed" });

  useEffect(() => {
    if (!signalId) {
      setState({ kind: "closed" });
      return;
    }
    const controller = new AbortController();
    setState({ kind: "loading" });
    resolve(signalId, controller.signal)
      .then((data) => setState({ kind: "open", data } as { kind: "open"; data: EvidenceResponse }))
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === "AbortError") return;
        setState({
          kind: "error",
          message: error instanceof Error ? error.message : "Could not load the evidence.",
        });
      });
    return () => controller.abort();
  }, [signalId, resolve]);

  if (state.kind === "closed" || state.kind === "loading") {
    return state.kind === "loading" ? (
      <div className="drawer-backdrop" role="dialog" aria-label="Evidence">
        <div className="drawer">
          <p className="muted">Loading the cited text…</p>
        </div>
      </div>
    ) : null;
  }

  if (state.kind === "error") {
    return (
      <div className="drawer-backdrop" role="dialog" aria-label="Evidence">
        <div className="drawer">
          <p className="muted">{state.message}</p>
          <button type="button" className="secondary" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    );
  }

  const { signal, evidence } = state.data;
  return (
    <div className="drawer-backdrop" role="dialog" aria-label="Evidence">
      <div className="drawer">
        <div className="drawer-head">
          <h3>Why this is here</h3>
          <button type="button" className="secondary" onClick={onClose}>
            Close
          </button>
        </div>
        <p className="claim-text">{signal.claim}</p>
        <p className="muted">
          Status: {signal.epistemicStatus.replace("_", " ").toLowerCase()} ·
          check: {signal.verdict.toLowerCase()}
        </p>
        <p className="muted">{signal.explanation}</p>
        <h4>Cited document text</h4>
        <ul className="evidence-list">
          {evidence.map((block) => (
            <li key={block.id} className="evidence-block">
              <span className="muted">
                {block.slideNumber !== undefined
                  ? `Slide ${block.slideNumber}`
                  : block.pageNumber !== undefined
                    ? `Page ${block.pageNumber}`
                    : "Document"}
                {block.sectionPath.length > 0 ? ` · ${block.sectionPath.join(" › ")}` : ""}
              </span>
              <blockquote>{block.normalizedText}</blockquote>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
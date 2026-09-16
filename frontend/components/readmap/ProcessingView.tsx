"use client";

/**
 * Honest processing view (spec §52): reader-facing stage labels from real
 * stage objects, no fake progress ramps. A cancel button stops the browser's
 * requests; the note says what that does and does not do (mirrors the
 * converter's D-002 semantics).
 */

interface ProcessingViewProps {
  filename: string;
  stageLabel: string;
  /** Determinate percentage (§6-H3), or null for the indeterminate bar. */
  percent: number | null;
  onCancel: () => void;
}

export function ProcessingView({ filename, stageLabel, percent, onCancel }: ProcessingViewProps) {
  return (
    <section className="processing" aria-live="polite">
      <p className="muted">{filename}</p>
      <p className="stage">{stageLabel}…</p>
      <div className="progress-track" aria-hidden="true">
        <div
          className="progress-fill"
          {...(percent === null
            ? { "data-indeterminate": "true" }
            : { style: { width: `${percent}%` } })}
        />
      </div>
      {percent !== null && <p className="visually-hidden">{percent}% complete</p>}
      <p className="muted">
        This can take a few minutes for long documents. You can keep this tab
        open in the background.
      </p>
      <button type="button" className="secondary" onClick={onCancel}>
        Cancel
      </button>
      <p className="muted">
        Cancelling stops waiting here; the analysis may still finish in the
        background and is cleaned up on schedule either way.
      </p>
    </section>
  );
}
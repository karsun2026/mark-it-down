"use client";

/**
 * Completion panel with the download link (§2, §19).
 *
 * The link points straight at the signed Blob URL, so the ZIP never passes
 * back through a Function. Warnings are surfaced here rather than buried in
 * the report, because they tell the user what the conversion could not do.
 */

import { formatBytes } from "@/lib/filename";

/**
 * A deck with a chart on every slide can produce hundreds of warnings. Showing
 * them all buries the download button under a wall of text; the complete list
 * ships in the conversion report either way.
 */
const MAX_SHOWN_WARNINGS = 8;

interface ConversionResultProps {
  downloadUrl: string;
  filename: string;
  sizeBytes: number;
  warnings: string[];
  onReset: () => void;
}

export function ConversionResult({
  downloadUrl,
  filename,
  sizeBytes,
  warnings,
  onReset,
}: ConversionResultProps) {
  return (
    <div className="card">
      <h2 style={{ marginTop: 0, fontSize: "1.15rem" }}>Conversion complete</h2>

      <div className="file-name">{filename}</div>
      <div className="muted">{formatBytes(sizeBytes)}</div>

      <div className="actions">
        {/* download attribute keeps the original name rather than the blob path */}
        <a href={downloadUrl} download={filename}>
          <button type="button" className="primary">
            Download ZIP
          </button>
        </a>
        <button type="button" onClick={onReset}>
          Convert another file
        </button>
      </div>

      <p className="muted" style={{ marginTop: "0.9rem" }}>
        This download link is temporary and expires shortly.
      </p>

      {warnings.length > 0 && (
        <div className="warnings">
          <strong>
            {warnings.length === 1
              ? "1 note about this conversion"
              : `${warnings.length} notes about this conversion`}
          </strong>
          <ul>
            {warnings.slice(0, MAX_SHOWN_WARNINGS).map((warning) => (
              <li key={warning} className="muted">
                {warning}
              </li>
            ))}
          </ul>
          {warnings.length > MAX_SHOWN_WARNINGS && (
            <p className="muted" style={{ marginTop: "0.5rem" }}>
              …and {warnings.length - MAX_SHOWN_WARNINGS} more. The full list is
              in <code>conversion-report.json</code> inside the ZIP.
            </p>
          )}
        </div>
      )}
    </div>
  );
}

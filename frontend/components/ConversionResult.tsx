"use client";

/**
 * Completion panel with the download link (§2, §19).
 *
 * The link points straight at the signed Blob URL, so the ZIP never passes
 * back through a Function.
 *
 * Signed download URLs live for 10 minutes (§19). Leaving the tab open while
 * you make a coffee should not cost you a 95 MB conversion, so the panel can
 * mint a fresh link on demand rather than sending you back to a re-upload.
 */

import { useState } from "react";

import { refreshDownloadUrl } from "@/lib/convert-client";
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
  jobToken: string;
  resultPathname: string;
  onReset: () => void;
}

export function ConversionResult({
  downloadUrl,
  filename,
  sizeBytes,
  warnings,
  jobToken,
  resultPathname,
  onReset,
}: ConversionResultProps) {
  const [href, setHref] = useState(downloadUrl);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState("");

  async function refresh() {
    if (refreshing) return;
    setRefreshing(true);
    setRefreshError("");
    try {
      setHref(await refreshDownloadUrl(jobToken, resultPathname));
    } catch {
      setRefreshError(
        "Could not get a new link. The file is kept for about two hours after conversion.",
      );
    } finally {
      setRefreshing(false);
    }
  }

  return (
    <div className="card">
      <h2 style={{ marginTop: 0, fontSize: "1.15rem" }}>Conversion complete</h2>

      <div className="file-name">{filename}</div>
      <div className="muted">{formatBytes(sizeBytes)}</div>

      <div className="actions">
        {/* download attribute keeps the original name rather than the blob path */}
        <a href={href} download={filename}>
          <button type="button" className="primary">
            Download ZIP
          </button>
        </a>
        <button type="button" onClick={refresh} disabled={refreshing}>
          {refreshing ? "Getting a new link…" : "Get a new link"}
        </button>
        <button type="button" onClick={onReset}>
          Convert another file
        </button>
      </div>

      {refreshError ? (
        <p className="muted" role="alert" style={{ marginTop: "0.9rem" }}>
          {refreshError}
        </p>
      ) : (
        <p className="muted" style={{ marginTop: "0.9rem" }}>
          The download link expires after about 10 minutes. If it stops working,
          use <strong>Get a new link</strong> — you do not need to convert again.
        </p>
      )}

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

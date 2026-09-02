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
  filename: string;
  sizeBytes: number;
  warnings: string[];
  jobToken: string;
  resultPathname: string;
  onReset: () => void;
}

export function ConversionResult({
  filename,
  sizeBytes,
  warnings,
  jobToken,
  resultPathname,
  onReset,
}: ConversionResultProps) {
  const [busy, setBusy] = useState(false);
  const [downloadError, setDownloadError] = useState("");

  /**
   * Fetch a FRESH link, then navigate to it.
   *
   * Signed links live 10 minutes (§19). Handing the browser one minted
   * earlier means a slow reader downloads an expired link's error body — the
   * blob host answers 403 with the 10-byte text "Forbidden" and no content
   * type, which the browser saves under the .zip name. The user then gets
   * "the archive is corrupt" for a file that was never the archive.
   *
   * Minting on click means the link is always seconds old.
   */
  async function download() {
    if (busy) return;
    setBusy(true);
    setDownloadError("");
    try {
      const fresh = await refreshDownloadUrl(jobToken, resultPathname);
      window.location.href = fresh;
    } catch {
      setDownloadError(
        "Could not prepare the download. Converted files are kept for about two hours — please try again.",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card">
      <h2 style={{ marginTop: 0, fontSize: "1.15rem" }}>Conversion complete</h2>

      <div className="file-name">{filename}</div>
      <div className="muted">{formatBytes(sizeBytes)}</div>

      <div className="actions">
        {/*
          A button, not an <a href>. The href would be a link that starts
          ageing the moment it is rendered; this mints one per click.
        */}
        <button
          type="button"
          className="primary"
          onClick={download}
          disabled={busy}
        >
          {busy ? "Preparing…" : "Download"}
        </button>
        <button type="button" onClick={onReset}>
          Convert another file
        </button>
      </div>

      {downloadError ? (
        <p className="muted" role="alert" style={{ marginTop: "0.9rem" }}>
          {downloadError}
        </p>
      ) : (
        <p className="muted" style={{ marginTop: "0.9rem" }}>
          You can download this for about two hours. Each click gets a fresh
          link, so it will not expire on you.
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

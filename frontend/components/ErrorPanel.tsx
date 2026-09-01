"use client";

/**
 * Error display (§54).
 *
 * The failure is signalled by a heading, an icon-free text label and a border
 * — never by colour alone. The stable §46 code is shown so a user can quote it
 * when reporting a problem.
 */

import type { ErrorCode } from "@/lib/types";

interface ErrorPanelProps {
  code: ErrorCode;
  message: string;
  onRetry: () => void;
  /**
   * Heading for the failure. A file rejected before anything ran was not a
   * failed conversion, and saying so is misleading, so the caller supplies
   * wording that matches what actually happened.
   */
  title?: string;
}

export function ErrorPanel({
  code,
  message,
  onRetry,
  title = "Conversion failed",
}: ErrorPanelProps) {
  return (
    <div className="error-panel" role="alert">
      <div className="error-title">{title}</div>
      <p>{message}</p>
      <p className="muted">Reference: {code}</p>
      <div className="actions">
        <button type="button" className="primary" onClick={onRetry}>
          Try another file
        </button>
      </div>
    </div>
  );
}

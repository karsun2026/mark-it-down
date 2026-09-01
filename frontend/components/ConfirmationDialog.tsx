"use client";

/**
 * Confirmation before conversion (§2, §64).
 *
 * §54 requires a focus trap and ESC to close. Both are implemented here rather
 * than pulled from a UI framework, since §50 asks us to avoid a large
 * dependency for a single-page utility.
 */

import { useCallback, useEffect, useRef } from "react";

import { formatBytes, sourceTypeFor } from "@/lib/filename";
import { HUMAN_TYPE_LABEL } from "@/lib/types";

interface ConfirmationDialogProps {
  file: File;
  onConfirm: () => void;
  onCancel: () => void;
}

const FOCUSABLE =
  'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';

export function ConfirmationDialog({
  file,
  onConfirm,
  onCancel,
}: ConfirmationDialogProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const previouslyFocused = useRef<HTMLElement | null>(null);

  const trapFocus = useCallback((event: KeyboardEvent) => {
    if (event.key !== "Tab") return;
    const root = dialogRef.current;
    if (!root) return;

    const focusable = Array.from(
      root.querySelectorAll<HTMLElement>(FOCUSABLE),
    ).filter((element) => !element.hasAttribute("disabled"));
    if (focusable.length === 0) return;

    const first = focusable[0]!;
    const last = focusable[focusable.length - 1]!;

    // Wrap in both directions so focus cannot escape behind the overlay.
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }, []);

  useEffect(() => {
    previouslyFocused.current = document.activeElement as HTMLElement | null;

    // Move focus into the dialog so a screen reader announces it.
    const focusable = dialogRef.current?.querySelector<HTMLElement>(FOCUSABLE);
    focusable?.focus();

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        onCancel();
        return;
      }
      trapFocus(event);
    }

    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      // Return focus where it came from, so the page does not lose its place.
      previouslyFocused.current?.focus();
    };
  }, [onCancel, trapFocus]);

  const sourceType = sourceTypeFor(file.name);

  return (
    <div
      className="overlay"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onCancel();
      }}
    >
      <div
        ref={dialogRef}
        className="dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="confirm-title"
      >
        <h2 id="confirm-title">Convert this file?</h2>

        <div className="file-name">{file.name}</div>
        <div className="muted">
          {sourceType ? HUMAN_TYPE_LABEL[sourceType] : "Unsupported file"}
          {" · "}
          {formatBytes(file.size)}
        </div>

        <p style={{ marginTop: "1rem", marginBottom: 0 }}>
          <strong>You will get:</strong>
        </p>
        <ul>
          <li>Markdown</li>
          <li>Extracted media</li>
          <li>A conversion report</li>
        </ul>

        <div className="actions">
          <button type="button" className="primary" onClick={onConfirm}>
            Convert
          </button>
          <button type="button" onClick={onCancel}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

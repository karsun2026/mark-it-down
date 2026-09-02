"use client";

/**
 * The single page (§2, §52, §53, §54).
 *
 * State machine, simplified from §52 on owner feedback (DEVIATIONS D-015):
 *
 *   idle -> selected -> uploading -> converting -> complete
 *   (any) -> error
 *
 * §52 had a separate `confirming` step behind a second button. In practice
 * choosing a file IS the intent, and a modal that only says "are you sure"
 * costs a click and tells the user nothing. The choice that actually matters -
 * Markdown only, or Markdown plus images - is now asked once, in place, and
 * answering it starts the job.
 *
 * §53: an in-flight job is cancellable via AbortController. If the browser
 * disappears mid-job, the §41 cleanup cron is the backstop — nothing is left
 * stranded in storage.
 */

import { useCallback, useEffect, useRef, useState } from "react";

import { ConversionResult } from "@/components/ConversionResult";
import { ErrorPanel } from "@/components/ErrorPanel";
import { FileDropzone } from "@/components/FileDropzone";
import { FileSummary } from "@/components/FileSummary";
import { UploadProgress } from "@/components/UploadProgress";
import {
  ConversionError,
  convertDocument,
  type ConversionOutcome,
} from "@/lib/convert-client";
import { validateSelection } from "@/lib/filename";
import { messageForCode } from "@/lib/messages";
import type { ErrorCode, JobStage, UiState } from "@/lib/types";

/** Report a failure so a browser-only stall is visible server-side (§47: code only). */
function reportFailure(code: string): void {
  void fetch("/api/trace", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ step: "flow-error", detail: code }),
    keepalive: true,
  }).catch(() => {
    /* diagnostics must never break the flow */
  });
}

/** "1m 20s elapsed", or "" for the first few seconds. */
function formatElapsed(seconds: number): string {
  if (seconds < 3) return "";
  if (seconds < 60) return `${seconds}s elapsed.`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${seconds % 60}s elapsed.`;
}

/** Reader-facing text per stage. Deliberately plain, never technical. */
const STAGE_LABEL: Record<JobStage, string> = {
  accepted: "Preparing",
  downloading: "Reading your document",
  validating: "Checking the document",
  converting: "Converting to Markdown",
  packaging: "Building your ZIP",
  uploading: "Saving the result",
  complete: "Preparing your download",
  failed: "Failed",
};

export default function ConverterApp() {
  const [state, setState] = useState<UiState>("idle");
  const [file, setFile] = useState<File | null>(null);
  const [uploadPercent, setUploadPercent] = useState(0);
  const [stage, setStage] = useState<JobStage | null>(null);
  const [outcome, setOutcome] = useState<ConversionOutcome | null>(null);
  const [error, setError] = useState<
    { code: ErrorCode; message: string; preflight: boolean } | null
  >(null);

  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [elapsed, setElapsed] = useState(0);

  const abortRef = useRef<AbortController | null>(null);
  // Latched once the job finishes. A late progress update must never be able
  // to move a completed job back to a spinner - that is exactly what left one
  // user staring at "Preparing your download" on top of a ready file.
  const settledRef = useRef(false);

  // A visible clock. Without it "a few minutes" is a guess, and a stalled job
  // is indistinguishable from a slow one.
  useEffect(() => {
    if (startedAt === null) return;
    const timer = setInterval(
      () => setElapsed(Math.floor((Date.now() - startedAt) / 1000)),
      1000,
    );
    return () => clearInterval(timer);
  }, [startedAt]);

  const reset = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setState("idle");
    setFile(null);
    setUploadPercent(0);
    setStartedAt(null);
    setElapsed(0);
    settledRef.current = false;
    setStage(null);
    setOutcome(null);
    setError(null);
  }, []);

  const fail = useCallback(
    (code: ErrorCode, message: string, preflight = false) => {
      settledRef.current = true;
      setError({ code, message, preflight });
      setState("error");
    },
    [],
  );

  const handleSelect = useCallback(
    (selected: File) => {
      // §10 - client-side checks are UX only; the server revalidates.
      const validation = validateSelection(selected.name, selected.size);
      if (!validation.ok && validation.code) {
        setFile(null);
        // Rejected before anything ran, so it is not a failed conversion.
        fail(validation.code, messageForCode(validation.code), true);
        return;
      }
      setError(null);
      setFile(selected);
      setState("selected");
    },
    [fail],
  );

  const start = useCallback(
    async (includeMedia: boolean) => {
      if (!file) return;

    const controller = new AbortController();
    abortRef.current = controller;

    setState("uploading");
    setUploadPercent(0);
    setStage(null);
    setStartedAt(Date.now());
    setElapsed(0);
    settledRef.current = false;

    try {
      const result = await convertDocument(file, includeMedia, controller.signal, {
        onUploadProgress: (percentage) => {
          setUploadPercent(percentage);
          if (percentage >= 100) setState("converting");
        },
        onStage: (status) => {
          if (settledRef.current) return;
          setState("converting");
          setStage(status.stage);
        },
      });

      settledRef.current = true;
      setState("preparing-download");
      setOutcome(result);
      setState("complete");
    } catch (caught) {
      if (caught instanceof DOMException && caught.name === "AbortError") {
        // A user-initiated cancel is not an error state.
        reset();
        return;
      }
      if (caught instanceof ConversionError) {
        reportFailure(caught.code);
        fail(caught.code, caught.message);
        return;
      }
      reportFailure(
        caught instanceof Error ? caught.name : "unknown",
      );
      fail("CONVERSION_FAILED", messageForCode("CONVERSION_FAILED"));
    } finally {
      abortRef.current = null;
    }
    },
    [fail, file, reset],
  );

  const busy = state === "uploading" || state === "converting";

  return (
    <main>
      <h1>Mark it Down</h1>
      <p className="muted">
        Convert Word, PowerPoint and PDF documents into Markdown.
      </p>

      {/* §54 - status changes are announced without stealing focus. */}
      <div aria-live="polite" className="visually-hidden">
        {state === "uploading" && `Uploading, ${uploadPercent} percent`}
        {state === "converting" &&
          (stage ? STAGE_LABEL[stage] : "Converting your document")}
        {state === "complete" && "Conversion complete. Your download is ready."}
        {state === "error" &&
          error &&
          `${error.preflight ? "This file cannot be converted" : "Conversion failed"}. ${error.message}`}
      </div>

      <div style={{ marginTop: "1.5rem" }}>
        {(state === "idle" || state === "error") && (
          <FileDropzone onSelect={handleSelect} />
        )}

        {state === "error" && error && (
          <div style={{ marginTop: "1.25rem" }}>
            <ErrorPanel
              code={error.code}
              message={error.message}
              title={
                error.preflight
                  ? "This file cannot be converted"
                  : "Conversion failed"
              }
              onRetry={reset}
            />
          </div>
        )}

        {file && state === "selected" && (
          <div className="card">
            <FileSummary file={file} />

            <p style={{ marginTop: "1.1rem", marginBottom: "0.35rem" }}>
              <strong>What would you like?</strong>
            </p>
            <p className="muted" style={{ marginBottom: "0.9rem" }}>
              Choosing Markdown only is faster and gives you a single file.
            </p>

            <div className="actions">
              <button
                type="button"
                className="primary"
                onClick={() => start(false)}
              >
                Markdown only
              </button>
              <button type="button" onClick={() => start(true)}>
                Markdown + images (ZIP)
              </button>
              <button type="button" onClick={reset}>
                Change file
              </button>
            </div>

            {/* Set expectations before the wait, not after it. */}
            <div className="warnings" style={{ marginTop: "1.25rem" }}>
              <strong>Before you convert</strong>
              <p className="muted" style={{ margin: "0.35rem 0 0" }}>
                Text, headings, lists and tables usually convert well. Charts,
                SmartArt, diagrams and complex layouts do not — they are left
                out, and multi-column pages may come through in an odd order.
                Check the result before relying on it.
              </p>
            </div>
          </div>
        )}

        {busy && file && (
          <div className="card">
            <FileSummary file={file} />
            <div style={{ marginTop: "1rem" }}>
              {state === "uploading" ? (
                <UploadProgress
                  label="Uploading"
                  percentage={uploadPercent}
                  detail={`Your file is uploading directly to secure storage. ${formatElapsed(elapsed)}`}
                />
              ) : (
                <UploadProgress
                  // §52 - no invented percentage for the conversion itself.
                  label={stage ? STAGE_LABEL[stage] : "Converting"}
                  detail={
                    stage === "complete"
                      ? `Converted successfully — fetching your download link. ${formatElapsed(elapsed)}`
                      : `Large documents can take a few minutes. You can leave this tab open. ${formatElapsed(elapsed)}`
                  }
                />
              )}
            </div>
            <div className="actions">
              <button type="button" onClick={reset}>
                Cancel
              </button>
            </div>
          </div>
        )}

        {state === "complete" && outcome && (
          <ConversionResult
            filename={outcome.filename}
            sizeBytes={outcome.sizeBytes}
            warnings={outcome.warnings}
            jobToken={outcome.jobToken}
            resultPathname={outcome.resultPathname}
            onReset={reset}
          />
        )}
      </div>

      <div className="footnote">
        <p>
          Files are processed temporarily and deleted automatically. No AI model
          is used — <strong>0 AI tokens</strong> are consumed per conversion.
        </p>
      </div>
    </main>
  );
}

"use client";

/**
 * The single page (§2, §52, §53, §54).
 *
 * State machine, exactly as §52 defines it:
 *
 *   idle -> selected -> confirming -> uploading -> converting
 *        -> preparing-download -> complete
 *   (any) -> error
 *
 * §53: an in-flight job is cancellable via AbortController. If the browser
 * disappears mid-job, the §41 cleanup cron is the backstop — nothing is left
 * stranded in storage.
 */

import { useCallback, useRef, useState } from "react";

import { ConfirmationDialog } from "@/components/ConfirmationDialog";
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

/** Reader-facing text per stage. Deliberately plain, never technical. */
const STAGE_LABEL: Record<JobStage, string> = {
  accepted: "Preparing",
  downloading: "Reading your document",
  validating: "Checking the document",
  converting: "Converting to Markdown",
  packaging: "Building your ZIP",
  uploading: "Saving the result",
  complete: "Finishing up",
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

  const abortRef = useRef<AbortController | null>(null);

  const reset = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setState("idle");
    setFile(null);
    setUploadPercent(0);
    setStage(null);
    setOutcome(null);
    setError(null);
  }, []);

  const fail = useCallback(
    (code: ErrorCode, message: string, preflight = false) => {
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

  const start = useCallback(async () => {
    if (!file) return;

    const controller = new AbortController();
    abortRef.current = controller;

    setState("uploading");
    setUploadPercent(0);
    setStage(null);

    try {
      const result = await convertDocument(file, controller.signal, {
        onUploadProgress: (percentage) => {
          setUploadPercent(percentage);
          if (percentage >= 100) setState("converting");
        },
        onStage: (status) => {
          setState("converting");
          setStage(status.stage);
        },
      });

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
        fail(caught.code, caught.message);
        return;
      }
      fail("CONVERSION_FAILED", messageForCode("CONVERSION_FAILED"));
    } finally {
      abortRef.current = null;
    }
  }, [fail, file, reset]);

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

        {file && (state === "selected" || state === "confirming") && (
          <div className="card">
            <FileSummary file={file} />
            <div className="actions">
              <button
                type="button"
                className="primary"
                onClick={() => setState("confirming")}
              >
                Convert to Markdown
              </button>
              <button type="button" onClick={reset}>
                Change file
              </button>
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
                  detail="Your file is uploading directly to secure storage."
                />
              ) : (
                <UploadProgress
                  // §52 - no invented percentage for the conversion itself.
                  label={stage ? STAGE_LABEL[stage] : "Converting"}
                  detail="Large documents can take a few minutes. You can leave this tab open."
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
            downloadUrl={outcome.downloadUrl}
            filename={outcome.filename}
            sizeBytes={outcome.sizeBytes}
            warnings={outcome.warnings}
            onReset={reset}
          />
        )}
      </div>

      {state === "confirming" && file && (
        <ConfirmationDialog
          file={file}
          onConfirm={start}
          onCancel={() => setState("selected")}
        />
      )}

      <div className="footnote">
        <p>
          Files are processed temporarily and deleted automatically. No AI model
          is used — <strong>0 AI tokens</strong> are consumed per conversion.
        </p>
      </div>
    </main>
  );
}

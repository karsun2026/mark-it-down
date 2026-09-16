"use client";

/**
 * The READMAP single-page flow (spec §12).
 *
 *   idle -> selected -> converting (Mark It Down stages) -> analysing
 *   (READMAP stages, polled) -> result | error
 *
 * The result view's depth slider moves between PRECOMPUTED tiers in client
 * state only — no fetch, no model call (plan acceptance check 11). The
 * evidence drawer resolves a signal's citations server-side via
 * /api/readmap/evidence/[signalId]; the client never names a blob path.
 */

import { useCallback, useRef, useState } from "react";

import { CompressionControl } from "@/components/readmap/CompressionControl";
import { ProcessingView } from "@/components/readmap/ProcessingView";
import { ReadmapResult } from "@/components/readmap/ReadmapResult";
import { FileDropzone } from "@/components/FileDropzone";
import { validateSelection, formatBytes } from "@/lib/filename";
import {
  runReadmapFlow,
  checkConverterAvailable,
  ReadmapFlowError,
  type ReadmapOutcome,
} from "@/lib/readmap/readmap-client";
import type { CompressionPreset } from "@/lib/readmap/schemas/signal";

type Phase = "idle" | "selected" | "working" | "done" | "error";

export default function ReadmapApp() {
  const [phase, setPhase] = useState<Phase>("idle");
  const [file, setFile] = useState<File | null>(null);
  const [stageLabel, setStageLabel] = useState<string>("");
  const [uploadPercent, setUploadPercent] = useState<number | null>(null);
  const [percent, setPercent] = useState<number | null>(null);
  const [outcome, setOutcome] = useState<ReadmapOutcome | null>(null);
  const [preset, setPreset] = useState<CompressionPreset>("READMAP");
  const [error, setError] = useState<{ code: string; message: string } | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const start = useCallback(async (selected: File) => {
    const validation = validateSelection(selected.name, selected.size);
    if (!validation.ok) {
      setError({
        code: validation.code ?? "INVALID_FILE_FORMAT",
        message:
          validation.code === "UNSUPPORTED_FILE_TYPE"
            ? "Unsupported file type. Please use .pdf, .docx, or .pptx."
            : validation.code === "FILE_TOO_LARGE"
              ? "That file is over the 100 MB limit."
              : "That file could not be read.",
      });
      setPhase("error");
      return;
    }

    setFile(selected);
    setPhase("working");
    setStageLabel("Preparing");
    setUploadPercent(null);
    setPercent(null);
    setError(null);
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      // Fail fast (seconds) when the converter service is not running,
      // instead of a twelve-minute silent wait on the status poll.
      const converterUp = await checkConverterAvailable(controller.signal);
      if (!converterUp) {
        setError({
          code: "SERVICE_UNAVAILABLE",
          message:
            "The document converter service is not running. In another terminal, start it with: powershell -File run-converter-local.ps1 — then restart this dev server (npm run dev) and try again.",
        });
        setPhase("error");
        return;
      }

      const result = await runReadmapFlow(selected, controller.signal, {
        onStage: (label) => {
          setStageLabel(label);
          setPercent(null);
          // The converter's own stages mean the upload has finished.
          if (label !== "Preparing") setUploadPercent(null);
        },
        onUploadProgress: (percentage) => {
          setUploadPercent(percentage);
          setStageLabel(`Uploading your document… ${percentage}%`);
        },
        onProgress: (pct) => {
          setPercent(pct);
        },
      });
      setUploadPercent(null);
      setOutcome(result);
      setPhase("done");
    } catch (e) {
      if (e instanceof DOMException && e.name === "AbortError") {
        setPhase("idle");
        return;
      }
      const code = e instanceof ReadmapFlowError ? e.code : "SERVICE_UNAVAILABLE";
      const message =
        e instanceof Error ? e.message : "Something went wrong. Please try again.";
      setError({ code, message });
      setPhase("error");
    } finally {
      abortRef.current = null;
    }
  }, []);

  const cancel = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  const reset = useCallback(() => {
    setPhase("idle");
    setFile(null);
    setOutcome(null);
    setStageLabel("");
    setUploadPercent(null);
    setPercent(null);
    setError(null);
    setPreset("READMAP");
  }, []);

  return (
    <main>
      <header>
        <h1>READMAP</h1>
        <p className="muted">Drop something long. Get the parts worth your time.</p>
        <p className="muted">
          PDF, Word, and PowerPoint up to 100 MB. Your document is converted to
          text, analysed, and deleted after processing; results are kept for a
          limited period. Every statement below links to the document text it
          comes from — nothing is added from outside the document.
        </p>
      </header>

      {phase === "idle" && (
        <FileDropzone
          onSelect={(selected) => {
            setFile(selected);
            void start(selected);
          }}
          disabled={false}
        />
      )}

      {phase === "working" && (
        <ProcessingView
          filename={file ? `${file.name} · ${formatBytes(file.size)}` : ""}
          stageLabel={stageLabel}
          percent={uploadPercent ?? percent}
          onCancel={cancel}
        />
      )}

      {phase === "done" && outcome && (
        <>
          <CompressionControl preset={preset} onChange={setPreset} />
          <ReadmapResult outcome={outcome} preset={preset} />
          <button type="button" onClick={reset}>
            Analyse another document
          </button>
        </>
      )}

      {phase === "error" && error && (
        <div className="error-panel" role="alert">
          <p className="error-title">Something went wrong</p>
          <p>{error.message}</p>
          <button type="button" onClick={reset}>
            Start over
          </button>
        </div>
      )}
    </main>
  );
}
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
  ReadmapFlowError,
  type ReadmapOutcome,
} from "@/lib/readmap/readmap-client";
import type { CompressionPreset } from "@/lib/readmap/schemas/signal";

type Phase = "idle" | "selected" | "working" | "done" | "error";

export default function ReadmapApp() {
  const [phase, setPhase] = useState<Phase>("idle");
  const [file, setFile] = useState<File | null>(null);
  const [stageLabel, setStageLabel] = useState<string>("");
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
    setError(null);
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const result = await runReadmapFlow(selected, controller.signal, {
        onStage: setStageLabel,
      });
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
    setError(null);
    setPreset("READMAP");
  }, []);

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-3xl flex-col gap-6 px-6 py-10">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">READMAP</h1>
        <p className="text-sm text-gray-600">
          Drop something long. Get the parts worth your time.
        </p>
        <p className="text-xs text-gray-500">
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
          onCancel={cancel}
        />
      )}

      {phase === "done" && outcome && (
        <>
          <CompressionControl preset={preset} onChange={setPreset} />
          <ReadmapResult outcome={outcome} preset={preset} />
          <button
            type="button"
            onClick={reset}
            className="self-start rounded border border-gray-300 px-4 py-2 text-sm hover:bg-gray-50"
          >
            Analyse another document
          </button>
        </>
      )}

      {phase === "error" && error && (
        <div className="rounded border border-red-200 bg-red-50 p-4 text-sm text-red-800">
          <p className="font-medium">{error.message}</p>
          <button
            type="button"
            onClick={reset}
            className="mt-3 rounded border border-red-300 px-3 py-1.5 text-sm hover:bg-red-100"
          >
            Start over
          </button>
        </div>
      )}
    </main>
  );
}
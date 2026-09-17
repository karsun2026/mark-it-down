/**
 * Browser-side READMAP flow: convert (existing Mark It Down path), then
 * analyse. Reuses `convertDocument` unchanged (rule 3) — READMAP is a second
 * consumer of the same conversion, never a second converter.
 *
 * The depth slider runs entirely client-side over precomputed tiers: moving
 * it must never fetch (plan acceptance check 11 asserts no network call on
 * slider move).
 */

import { convertDocument } from "@/lib/convert-client";
import type { ReadMapV1 } from "@/lib/readmap/schemas/readmap";
import type { CompressedTiersV1 } from "@/lib/readmap/schemas/signal";
import type { ReadMapStatusV1 } from "@/lib/readmap/schemas/status";

export type { ReadMapStatusV1 };

export interface ReadmapOutcome {
  status: "READY" | "PARTIAL_READY";
  jobId: string;
  /** Kept so the evidence drawer can resolve citations server-side. */
  jobToken: string;
  resultPathname: string;
  readmap: ReadMapV1;
  tiers: CompressedTiersV1 | null;
  warnings: string[];
}

export interface ReadmapFlowCallbacks {
  onStage?: (label: string) => void;
  onUploadProgress?: (percentage: number) => void;
  /**
   * Determinate progress (0-100) for the analysis wait screen, derived from
   * the polled status object's unit counts (§6-H3). Null when the current
   * stage has no unit counts — the UI falls back to an indeterminate bar.
   */
  onProgress?: (percent: number | null) => void;
}

export class ReadmapFlowError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "ReadmapFlowError";
    this.code = code;
  }
}

/** Reader-facing labels, deliberately plain (spec §12: no agent jargon). */
export const READMAP_STAGE_LABEL: Record<string, string> = {
  STARTING: "Analysis starting",
  SEGMENTING: "Reading the document structure",
  MAPPING: "Mapping the document",
  EXTRACTING: "Extracting candidate signals",
  VERIFYING: "Checking every claim against its evidence",
  COMPRESSING: "Building the reading depths",
  GROUNDING: "Verifying citations",
  READY: "Done",
  PARTIAL_READY: "Done, with limitations",
  FAILED: "Failed",
  // Conversion stages reuse the converter's reader wording.
  accepted: "Preparing",
  downloading: "Reading your document",
  validating: "Checking the document",
  converting: "Converting to Markdown",
  packaging: "Building your Markdown",
  uploading: "Saving the result",
  complete: "Analysis starting",
  failed: "Failed",
};

async function readApiError(response: Response): Promise<ReadmapFlowError> {
  try {
    const body = (await response.json()) as { code?: string; message?: string };
    if (body?.code && body?.message) return new ReadmapFlowError(body.code, body.message);
  } catch {
    // fall through
  }
  return new ReadmapFlowError(
    "SERVICE_UNAVAILABLE",
    "Something went wrong. Please try again.",
  );
}

async function postJson<T>(url: string, body: unknown, signal?: AbortSignal): Promise<T> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
  if (!response.ok) throw await readApiError(response);
  return (await response.json()) as T;
}

export interface EvidenceResponse {
  signal: {
    id: string;
    claim: string;
    type: string;
    verdict: string;
    explanation: string;
    epistemicStatus: string;
    warnings: string[];
  };
  evidence: {
    id: string;
    normalizedText: string;
    pageNumber?: number;
    slideNumber?: number;
    sectionPath: string[];
  }[];
}

/**
 * Convert, then analyse. Stages stream through `onStage` — conversion stages
 * from the converter's status object, READMAP stages polled from Blob while
 * the start request runs. The start request itself is the authority; polling
 * failures are transient and ignored.
 */
export async function runReadmapFlow(
  file: File,
  signal: AbortSignal,
  callbacks: ReadmapFlowCallbacks = {},
): Promise<ReadmapOutcome> {
  const outcome = await convertDocument(file, false, signal, {
    onStage: (status) => callbacks.onStage?.(READMAP_STAGE_LABEL[status.stage] ?? "Working"),
    onUploadProgress: (percentage) =>
      callbacks.onUploadProgress?.(percentage),
  });

  const { jobToken, resultPathname } = outcome;
  const pollTimer = window.setInterval(() => {
    void postJson<ReadMapStatusV1>("/api/readmap/status", { jobToken, resultPathname }, signal)
      .then((status) => {
        callbacks.onStage?.(labelFor(status));
        // §6-H3: a real percentage from the stage's unit counts, falling back
        // to the stage's fixed progress, falling back to indeterminate.
        const pct =
          status.unitsTotal > 0
            ? Math.round((status.unitsDone / status.unitsTotal) * 100)
            : typeof status.progress === "number"
              ? Math.round(status.progress * 100)
              : null;
        callbacks.onProgress?.(pct);
      })
      .catch(() => {
        /* transient poll failures are normal; the start request decides */
      });
  }, 2500);

  try {
    const response = await postJson<StartResponse>("/api/readmap/start", {
      jobToken,
      resultPathname,
      originalFilename: file.name,
      // Thread the converter's warnings and true page count so coverage is
      // honest (a partially-unreadable document is not shown as 100%) — BLOCKER-2.
      converterWarnings: outcome.warnings,
      pagesOrSlides: outcome.pagesOrSlides,
    }, signal);
    return {
      status: response.status,
      jobId: response.jobId,
      jobToken,
      resultPathname,
      readmap: response.readmap,
      tiers: response.tiers,
      warnings: response.warnings,
    };
  } finally {
    window.clearInterval(pollTimer);
  }
}

/** Fetch the evidence behind one signal id (server resolves the blocks). */
export function fetchEvidence(
  jobToken: string,
  resultPathname: string,
  signalId: string,
  signal: AbortSignal,
): Promise<EvidenceResponse> {
  return postJson<EvidenceResponse>(
    `/api/readmap/evidence/${encodeURIComponent(signalId)}`,
    { jobToken, resultPathname },
    signal,
  );
}

function labelFor(status: ReadMapStatusV1): string {
  const base = READMAP_STAGE_LABEL[status.stage] ?? "Working";
  if (status.unitsTotal > 0 && (status.stage === "EXTRACTING" || status.stage === "VERIFYING")) {
    return `${base} (${status.unitsDone}/${status.unitsTotal})`;
  }
  return base;
}

/**
 * Fail fast when the converter service is not reachable (local development).
 *
 * The conversion POST races a status poll that tolerates a missing status
 * object for up to twelve minutes — correct in production, where the
 * /converter/* route always exists, but locally a missing converter meant
 * twelve silent minutes. /converter/health answers in milliseconds when the
 * service is up, so a failed check here is an immediate, actionable error
 * instead of a long silence.
 */
export async function checkConverterAvailable(signal: AbortSignal): Promise<boolean> {
  try {
    const response = await fetch("/converter/health", {
      signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]),
      cache: "no-store",
    });
    return response.ok;
  } catch {
    return false;
  }
}

interface StartResponse {
  status: "READY" | "PARTIAL_READY";
  jobId: string;
  readmap: ReadMapV1;
  tiers: CompressedTiersV1 | null;
  warnings: string[];
}
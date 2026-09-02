/**
 * The browser-side conversion flow (§66 steps 1-21).
 *
 * Sequence:
 *   upload directly to Private Blob -> prepare job -> POST to the converter
 *   -> get a signed download URL
 *
 * D-002 is what makes this survivable: the converter can run for up to 690
 * seconds, and a browser will not reliably hold one request open that long.
 * The POST is therefore raced against a poll of the status object, and
 * whichever resolves first wins. A dropped connection degrades to polling
 * rather than failing the job.
 */

import { upload } from "@vercel/blob/client";

import { buildJobPaths, type JobPaths } from "./filename";
import {
  MIME_BY_EXTENSION,
  type ApiError,
  type ConvertResponse,
  type ErrorCode,
  type JobStatus,
  type PrepareJobResponse,
  type SupportedExtension,
} from "./types";
import { safeExtension } from "./filename";

/**
 * Report which step the client reached, so a browser-only stall is visible in
 * the server log. Fire-and-forget: a failed trace must never affect the job.
 *
 * §47: step name and duration only - no filenames, URLs or document content.
 */
const traceStart = Date.now();
function trace(step: string, detail = ""): void {
  void fetch("/api/trace", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ step, detail, elapsedMs: Date.now() - traceStart }),
    keepalive: true,
  }).catch(() => {
    /* diagnostics must never break the flow */
  });
}

export class ConversionError extends Error {
  readonly code: ErrorCode;

  constructor(code: ErrorCode, message: string) {
    super(message);
    this.name = "ConversionError";
    this.code = code;
  }
}

/** Poll cadence for the D-002 status object. */
const POLL_INTERVAL_MS = 2000;
/** Slightly beyond the converter's own 690s deadline (§26). */
const POLL_TIMEOUT_MS = 720_000;

/** The download-url call is normally ~1s; never let it hang the finished job. */
const DOWNLOAD_URL_TIMEOUT_MS = 15_000;
const DOWNLOAD_URL_ATTEMPTS = 3;

/**
 * Consecutive status reads that may fail before we say so. Transient blips are
 * normal; a persistent failure previously looped in silence until the 12-minute
 * deadline, which reads to a user as "stuck forever".
 */
const MAX_SILENT_POLL_FAILURES = 8;

export interface ConversionCallbacks {
  onUploadProgress?: (percentage: number) => void;
  onStage?: (status: JobStatus) => void;
}

export interface ConversionOutcome {
  downloadUrl: string;
  filename: string;
  sizeBytes: number;
  warnings: string[];
  /** Kept so a new signed link can be minted when the first one expires. */
  jobToken: string;
  resultPathname: string;
}

async function readApiError(
  response: Response,
  fallback: ErrorCode,
): Promise<ConversionError> {
  try {
    const body = (await response.json()) as ApiError;
    if (body?.code && body?.message) {
      return new ConversionError(body.code, body.message);
    }
  } catch {
    // Fall through to the generic error below.
  }
  return new ConversionError(
    fallback,
    "Something went wrong. Please try again.",
  );
}

/**
 * Step 5: upload the source straight to Private Blob.
 *
 * The 100 MB file never touches a Function — §3's whole reason for existing.
 */
async function uploadSource(
  file: File,
  paths: JobPaths,
  signal: AbortSignal,
  onProgress?: (percentage: number) => void,
): Promise<void> {
  const extension = safeExtension(file.name) as SupportedExtension;

  await upload(paths.sourcePathname, file, {
    access: "private",
    handleUploadUrl: "/api/blob/upload",
    contentType: MIME_BY_EXTENSION[extension],
    // §12 - multipart for larger files, and real progress rather than a fake
    // ramp (§52).
    multipart: file.size >= 25 * 1024 * 1024,
    abortSignal: signal,
    onUploadProgress: (progress) => {
      onProgress?.(Math.round(progress.percentage));
    },
  });
}

/** Steps 6-7: verify the upload and mint the signed URLs plus job token. */
async function prepareJob(
  paths: JobPaths,
  originalFilename: string,
  signal: AbortSignal,
): Promise<PrepareJobResponse> {
  const response = await fetch("/api/blob/prepare-job", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jobId: paths.jobId,
      sourcePathname: paths.sourcePathname,
      resultPathname: paths.resultPathname,
      statusPathname: paths.statusPathname,
      originalFilename,
      includeMedia: paths.includeMedia,
    }),
    signal,
  });

  if (!response.ok) {
    throw await readApiError(response, "SERVICE_UNAVAILABLE");
  }
  return (await response.json()) as PrepareJobResponse;
}

/**
 * D-002: poll the status object until the job reports done.
 *
 * Reads are presigned with `useCache: false` (D-005), without which an
 * overwritten status blob can serve a stale stage for up to 60 seconds and a
 * finished job would look stuck.
 */
async function pollStatus(
  statusGetUrl: string,
  signal: AbortSignal,
  onStage?: (status: JobStatus) => void,
): Promise<JobStatus> {
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  let lastStage = "";
  let consecutiveFailures = 0;

  while (Date.now() < deadline) {
    if (signal.aborted) throw new DOMException("aborted", "AbortError");

    try {
      const response = await fetch(statusGetUrl, { cache: "no-store", signal });
      if (response.ok) {
        consecutiveFailures = 0;
        const status = (await response.json()) as JobStatus;
        if (status.stage !== lastStage) {
          lastStage = status.stage;
          onStage?.(status);
        }
        if (status.done) return status;
      } else if (response.status !== 404) {
        // A 404 simply means the converter has not written a status yet.
        consecutiveFailures += 1;
      }
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") throw error;
      consecutiveFailures += 1;
    }

    // Say something rather than looping in silence for twelve minutes.
    if (consecutiveFailures >= MAX_SILENT_POLL_FAILURES) {
      throw new ConversionError(
        "SERVICE_UNAVAILABLE",
        "Lost contact while checking on your conversion. Please try again.",
      );
    }

    await sleep(POLL_INTERVAL_MS, signal);
  }

  throw new ConversionError(
    "CONVERSION_TIMEOUT",
    "The conversion took too long to complete.",
  );
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(new DOMException("aborted", "AbortError"));
      },
      { once: true },
    );
  });
}

/**
 * Step 8: ask the converter to run, and race the response against the poll.
 *
 * Whichever settles first decides the outcome. If the long POST is dropped by
 * a proxy or a network handoff, the poll still observes the job finishing.
 */
async function runConversion(
  job: PrepareJobResponse,
  signal: AbortSignal,
  onStage?: (status: JobStatus) => void,
): Promise<string[]> {
  const convertRequest = fetch("/converter/v1/convert", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jobToken: job.jobToken,
      sourceGetUrl: job.sourceGetUrl,
      resultPutUrl: job.resultPutUrl,
      sourceDeleteUrl: job.sourceDeleteUrl,
      statusPutUrl: job.statusPutUrl,
    }),
    signal,
  })
    .then(async (response) => {
      if (!response.ok) {
        throw await readApiError(response, "CONVERSION_FAILED");
      }
      const body = (await response.json()) as ConvertResponse;
      return body.warnings ?? [];
    });

  // Its own controller so the race can cancel it without cancelling the job.
  const pollAbort = new AbortController();
  if (signal.aborted) pollAbort.abort();
  else signal.addEventListener("abort", () => pollAbort.abort(), { once: true });

  const polling = pollStatus(job.statusGetUrl, pollAbort.signal, onStage).then((status) => {
    if (!status.ok) {
      throw new ConversionError(
        status.code ?? "CONVERSION_FAILED",
        "The document could not be converted. Please try again.",
      );
    }
    return status.warnings ?? [];
  });

  // Late rejections from the branch that loses the race are expected and must
  // not surface as unhandled.
  convertRequest.catch(() => {});
  polling.catch(() => {});

  // Promise.any resolves on the first SUCCESS, so a dropped POST does not
  // fail the job while the poll is still watching it succeed.
  try {
    return await Promise.any([convertRequest, polling]);
  } catch (error) {
    if (error instanceof AggregateError) {
      // Both failed. Prefer a real ConversionError over a network error.
      const known = error.errors.find((e) => e instanceof ConversionError);
      throw known ?? error.errors[0];
    }
    throw error;
  } finally {
    // STOP THE LOSER. This is the bug that made a finished job look stuck:
    // when the convert POST won, the poll kept running and fired one more
    // `onStage("complete")` AFTER the flow had already completed and rendered
    // the download button. The handler set the UI back to "converting", and
    // nothing ever moved it forward again - a spinner on top of a finished
    // download. Cancelling the losing branch is what makes the race safe.
    pollAbort.abort();
  }
}

/**
 * Step 20: exchange the job token for a short-lived signed download URL.
 *
 * Bounded and retried. This call normally takes about a second, but when it
 * stalled the UI sat on "Finishing up" indefinitely with no error and no way
 * forward - the conversion had already succeeded and the user could not tell.
 * An unbounded await on the last step of a long job is the worst place to have
 * one.
 */
async function requestDownloadUrl(
  job: PrepareJobResponse,
  signal: AbortSignal,
): Promise<{ downloadUrl: string; sizeBytes: number }> {
  let lastError: unknown = null;

  for (let attempt = 1; attempt <= DOWNLOAD_URL_ATTEMPTS; attempt += 1) {
    try {
      return await requestDownloadUrlOnce(job, signal);
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") throw error;
      // A refusal is final; retrying it just delays the error the user needs.
      if (error instanceof ConversionError) throw error;
      lastError = error;
      if (attempt < DOWNLOAD_URL_ATTEMPTS) await sleep(1000 * attempt, signal);
    }
  }

  throw new ConversionError(
    "SERVICE_UNAVAILABLE",
    "Your file converted successfully, but preparing the download link timed out. Please try again.",
  );
}

async function requestDownloadUrlOnce(
  job: PrepareJobResponse,
  signal: AbortSignal,
): Promise<{ downloadUrl: string; sizeBytes: number }> {
  // Own timeout, combined with the caller's cancel signal.
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(), DOWNLOAD_URL_TIMEOUT_MS);
  const onAbort = () => timeout.abort();
  signal.addEventListener("abort", onAbort, { once: true });

  let response: Response;
  try {
    response = await fetch("/api/blob/download-url", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jobToken: job.jobToken,
        resultPathname: job.resultPathname,
      }),
      signal: timeout.signal,
    });
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", onAbort);
  }

  if (!response.ok) {
    throw await readApiError(response, "SERVICE_UNAVAILABLE");
  }
  return (await response.json()) as { downloadUrl: string; sizeBytes: number };
}

/**
 * Mint a fresh signed download link for a finished job.
 *
 * §19 gives download URLs a 10-minute life. Without this, stepping away for
 * ten minutes turns a completed conversion into a dead link and a re-upload.
 */
export async function refreshDownloadUrl(
  jobToken: string,
  resultPathname: string,
): Promise<string> {
  const controller = new AbortController();
  const { downloadUrl } = await requestDownloadUrl(
    { jobToken, resultPathname } as PrepareJobResponse,
    controller.signal,
  );
  return downloadUrl;
}

/** Run the whole flow for one file. */
export async function convertDocument(
  file: File,
  includeMedia: boolean,
  signal: AbortSignal,
  callbacks: ConversionCallbacks = {},
): Promise<ConversionOutcome> {
  const paths = buildJobPaths(file.name, includeMedia);

  trace("start", `${Math.round(file.size / 1048576)}MB media=${includeMedia}`);
  trace("upload-begin");
  await uploadSource(file, paths, signal, callbacks.onUploadProgress);
  trace("upload-done");

  const job = await prepareJob(paths, file.name, signal);
  trace("prepare-done");

  const warnings = await runConversion(job, signal, (status) => {
    trace("stage", status.stage);
    callbacks.onStage?.(status);
  });
  trace("race-resolved", `${warnings.length} warnings`);

  trace("download-url-begin");
  const { downloadUrl, sizeBytes } = await requestDownloadUrl(job, signal);
  trace("download-url-done", `${Math.round(sizeBytes / 1048576)}MB`);

  trace("flow-complete");
  return {
    downloadUrl,
    filename: includeMedia
      ? `${paths.displayStem}_markdown.zip`
      : `${paths.displayStem}.md`,
    sizeBytes,
    warnings,
    jobToken: job.jobToken,
    resultPathname: job.resultPathname,
  };
}

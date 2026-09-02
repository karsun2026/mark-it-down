/**
 * Prepare a conversion job (§15).
 *
 * Verifies the uploaded blob really exists and is within the size limit, then
 * mints the signed URLs and the job token the converter needs. This is the
 * only place the source's ACTUAL size is checked (§14) — everything before it
 * is a claim by the client.
 */

import { NextResponse } from "next/server";

import { errorResponse } from "@/lib/api-errors";
import { requireSession } from "@/lib/guard";
import {
  checkConversionRateLimit,
  warnIfDegraded,
} from "@/lib/rate-limit";
import {
  exceedsUploadLimit,
  inspectBlob,
  signResultPut,
  signSourceDelete,
  signSourceGet,
  signStatusGet,
  signStatusPut,
  SIGNED_SOURCE_URL_MINUTES,
} from "@/lib/blob";
import { isSupportedExtension, pathBelongsToJob, safeExtension } from "@/lib/filename";
import { mintJobToken, signingSecret } from "@/lib/job-token";
import type { PrepareJobResponse } from "@/lib/types";

export const runtime = "nodejs";

interface PrepareJobRequest {
  jobId?: unknown;
  sourcePathname?: unknown;
  resultPathname?: unknown;
  statusPathname?: unknown;
  originalFilename?: unknown;
  includeMedia?: unknown;
}

export async function POST(request: Request): Promise<NextResponse> {
  // §43 - the gate. Explicit per route; see lib/guard.ts.
  const denied = await requireSession(request);
  if (denied) return denied;

  // §44 - defence in depth. A caller who skipped the upload route and is
  // reusing an already-uploaded blob still passes through here.
  const rateLimit = await checkConversionRateLimit(request);
  warnIfDegraded(rateLimit, "/api/blob/prepare-job");
  if (rateLimit.limited) {
    return errorResponse("RATE_LIMITED", "conversion rate limit exceeded");
  }

  let body: PrepareJobRequest;
  try {
    body = (await request.json()) as PrepareJobRequest;
  } catch {
    return errorResponse("JOB_TOKEN_INVALID", "prepare-job body was not json");
  }

  const jobId = asString(body.jobId);
  const sourcePathname = asString(body.sourcePathname);
  const resultPathname = asString(body.resultPathname);
  const statusPathname = asString(body.statusPathname);
  const originalFilename = asString(body.originalFilename);

  if (
    !jobId ||
    !sourcePathname ||
    !resultPathname ||
    !statusPathname ||
    !originalFilename
  ) {
    return errorResponse("JOB_TOKEN_INVALID", "prepare-job missing fields");
  }

  // §15 step 2 - the client supplies both the job id and the pathnames, so the
  // relationship between them is verified rather than assumed. Without this a
  // caller could have us sign URLs for someone else's job.
  for (const pathname of [sourcePathname, resultPathname, statusPathname]) {
    if (!pathBelongsToJob(pathname, jobId)) {
      return errorResponse("JOB_TOKEN_INVALID", "pathname outside job scope");
    }
  }
  if (
    !sourcePathname.includes("/source/") ||
    !resultPathname.includes("/result/")
  ) {
    return errorResponse("JOB_TOKEN_INVALID", "pathname shape unexpected");
  }

  // The deliverable shape is carried by the result path's extension, and that
  // path is signed into the job token — so the converter reads the user's
  // choice from something they cannot tamper with. Reject a mismatch between
  // what was asked for and what the path says.
  const includeMedia = body.includeMedia !== false;
  const wantsZip = resultPathname.toLowerCase().endsWith(".zip");
  if (includeMedia !== wantsZip) {
    return errorResponse(
      "JOB_TOKEN_INVALID",
      "result extension does not match the requested output",
    );
  }

  // §15 step 5.
  if (!isSupportedExtension(safeExtension(originalFilename))) {
    return errorResponse("UNSUPPORTED_FILE_TYPE", "extension not supported");
  }

  // §15 steps 3-4 / §14 - does it exist, and how big is it really?
  const facts = await inspectBlob(sourcePathname);
  if (!facts.exists) {
    return errorResponse("BLOB_NOT_FOUND", "source blob missing at prepare");
  }
  if (facts.size <= 0) {
    return errorResponse("INVALID_FILE_FORMAT", "source blob is empty");
  }
  if (exceedsUploadLimit(facts.size)) {
    // §14: reject and delete. Deletion is best effort; the cleanup cron (§41)
    // is the backstop if it fails.
    try {
      const deleteUrl = await signSourceDelete(sourcePathname);
      await fetch(deleteUrl, { method: "DELETE" });
    } catch {
      console.info("oversized source delete failed; cleanup cron will handle it");
    }
    return errorResponse("FILE_TOO_LARGE", "actual blob size over limit");
  }

  try {
    signingSecret();
  } catch {
    return errorResponse("SERVICE_UNAVAILABLE", "job signing secret unusable");
  }

  try {
    const [
      sourceGetUrl,
      sourceDeleteUrl,
      resultPutUrl,
      statusPutUrl,
      statusGetUrl,
    ] = await Promise.all([
      signSourceGet(sourcePathname),
      signSourceDelete(sourcePathname),
      signResultPut(resultPathname),
      signStatusPut(statusPathname),
      signStatusGet(statusPathname),
    ]);

    const token = mintJobToken({
      job_id: jobId,
      source_path: sourcePathname,
      result_path: resultPathname,
      filename: originalFilename,
      source_size: facts.size,
      exp: Math.floor(Date.now() / 1000) + SIGNED_SOURCE_URL_MINUTES * 60,
    });

    const payload: PrepareJobResponse = {
      jobToken: token,
      sourceGetUrl,
      sourceDeleteUrl,
      resultPutUrl,
      statusPutUrl,
      statusGetUrl,
      resultPathname,
    };
    return NextResponse.json(payload);
  } catch {
    return errorResponse("SERVICE_UNAVAILABLE", "failed to sign job urls");
  }
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

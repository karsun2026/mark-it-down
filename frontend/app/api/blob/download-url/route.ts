/**
 * Issue a signed download URL for the finished ZIP (§19).
 *
 * The browser downloads straight from Blob. §19 explicitly forbids proxying
 * the result through this Function, which would breach the 4.5 MB response cap
 * for anything but a trivial document.
 */

import { NextResponse } from "next/server";

import { errorResponse } from "@/lib/api-errors";
import { inspectBlob, signResultDownload } from "@/lib/blob";
import { verifyJobToken } from "@/lib/job-token";

export const runtime = "nodejs";

interface DownloadUrlRequest {
  jobToken?: unknown;
  resultPathname?: unknown;
}

export async function POST(request: Request): Promise<NextResponse> {
  let body: DownloadUrlRequest;
  try {
    body = (await request.json()) as DownloadUrlRequest;
  } catch {
    return errorResponse("JOB_TOKEN_INVALID", "download-url body was not json");
  }

  const jobToken =
    typeof body.jobToken === "string" ? body.jobToken : null;
  const resultPathname =
    typeof body.resultPathname === "string" ? body.resultPathname : null;

  if (!jobToken || !resultPathname) {
    return errorResponse("JOB_TOKEN_INVALID", "download-url missing fields");
  }

  // §19 step 1.
  let verified: ReturnType<typeof verifyJobToken>;
  try {
    verified = verifyJobToken(jobToken);
  } catch {
    return errorResponse("SERVICE_UNAVAILABLE", "job signing secret unusable");
  }
  if (!verified) {
    return errorResponse("JOB_TOKEN_INVALID", "download token failed to verify");
  }
  if (verified.expired) {
    return errorResponse("JOB_TOKEN_EXPIRED", "download token expired");
  }

  // §19 step 2 - the pathname must be the one the token was signed for, not
  // merely a plausible one. Otherwise a valid token would grant read access to
  // any blob in the store.
  if (verified.claims.result_path !== resultPathname) {
    return errorResponse(
      "JOB_TOKEN_INVALID",
      "requested pathname is not the signed result path",
    );
  }

  // §19 step 3.
  const facts = await inspectBlob(resultPathname);
  if (!facts.exists) {
    return errorResponse("BLOB_NOT_FOUND", "result blob not present");
  }

  try {
    const downloadUrl = await signResultDownload(resultPathname);
    return NextResponse.json({ downloadUrl, sizeBytes: facts.size });
  } catch {
    return errorResponse("SERVICE_UNAVAILABLE", "failed to sign download url");
  }
}

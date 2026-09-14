/**
 * Shared request verification for the READMAP routes.
 *
 * Every READMAP route re-uses the conversion job's HMAC token (rule 3: reuse,
 * do not duplicate): the browser already holds it from the conversion flow,
 * and `download-url` established the exact verification pattern — signature,
 * expiry, and the binding between the token and the pathname it names. Without
 * the binding, one valid token would grant read access to any blob.
 *
 * READMAP reads further require the result to be a bare `.md` (the pipeline
 * consumes Markdown, not the ZIP deliverable).
 */

import { errorResponse } from "@/lib/api-errors";
import { pathBelongsToJob } from "@/lib/filename";
import { verifyJobToken } from "@/lib/job-token";
import type { NextResponse } from "next/server";

export interface ReadmapAccess {
  jobId: string;
  resultPathname: string;
}

export async function verifyReadmapAccess(
  body: { jobToken?: unknown; resultPathname?: unknown },
): Promise<{ access: ReadmapAccess } | { error: NextResponse }> {
  const jobToken = typeof body.jobToken === "string" ? body.jobToken : null;
  const resultPathname =
    typeof body.resultPathname === "string" ? body.resultPathname : null;

  if (!jobToken || !resultPathname) {
    return { error: errorResponse("JOB_TOKEN_INVALID", "readmap request missing fields") };
  }

  let verified: ReturnType<typeof verifyJobToken>;
  try {
    verified = verifyJobToken(jobToken);
  } catch {
    return { error: errorResponse("SERVICE_UNAVAILABLE", "job signing secret unusable") };
  }
  if (!verified) {
    return { error: errorResponse("JOB_TOKEN_INVALID", "readmap token failed to verify") };
  }
  if (verified.expired) {
    return { error: errorResponse("JOB_TOKEN_EXPIRED", "readmap token expired") };
  }
  if (verified.claims.result_path !== resultPathname) {
    return {
      error: errorResponse(
        "JOB_TOKEN_INVALID",
        "requested pathname is not the signed result path",
      ),
    };
  }
  if (!pathBelongsToJob(resultPathname, verified.claims.job_id)) {
    return { error: errorResponse("JOB_TOKEN_INVALID", "pathname outside job scope") };
  }
  if (!resultPathname.toLowerCase().endsWith(".md")) {
    return {
      error: errorResponse(
        "INVALID_FILE_FORMAT",
        "READMAP requires a Markdown conversion result",
      ),
    };
  }

  return {
    access: { jobId: verified.claims.job_id, resultPathname },
  };
}
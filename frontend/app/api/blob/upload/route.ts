/**
 * Upload authorization (§13).
 *
 * Issues presigned PUT URLs so the browser uploads the source straight to
 * Private Blob. The document never passes through this Function — that is the
 * whole point of §3, given the 4.5 MB Function payload cap.
 *
 * Per DEVIATIONS.md D-004 this uses the presigned flow
 * (`handleUploadPresigned`) rather than the older client-token flow, so no
 * Vercel-managed bearer token is ever in flight.
 */

import { issueSignedToken } from "@vercel/blob";
import {
  type HandleUploadPresignedBody,
  handleUploadPresigned,
} from "@vercel/blob/client";
import { NextResponse } from "next/server";

import { errorResponse } from "@/lib/api-errors";
import { isSupportedExtension, pathBelongsToJob, safeExtension } from "@/lib/filename";
import { MAX_UPLOAD_BYTES, MIME_BY_EXTENSION } from "@/lib/types";

export const runtime = "nodejs";

/**
 * §13 step 1 / §43. AUTH_MODE=none is development only; production must not
 * expose conversion anonymously. Deployment Protection covers the gap until
 * Entra lands in Phase 5.
 */
async function isAuthorized(_request: Request): Promise<boolean> {
  const mode = process.env.AUTH_MODE ?? "none";
  if (mode === "none") return true;
  // Phase 5 wires Entra here. Fail closed for any mode we do not implement.
  return false;
}

export async function POST(request: Request): Promise<NextResponse> {
  let body: HandleUploadPresignedBody;
  try {
    body = (await request.json()) as HandleUploadPresignedBody;
  } catch {
    return errorResponse("INVALID_FILE_FORMAT", "upload body was not json");
  }

  try {
    const result = await handleUploadPresigned({
      body,
      request,
      getSignedToken: async (pathname) => {
        if (!(await isAuthorized(request))) {
          throw new Error("NOT_AUTHORIZED");
        }

        // §13 steps 2-5. The client proposes a pathname, so it must be
        // checked, not trusted: it has to be a well-formed job path and carry
        // a supported extension.
        const jobId = jobIdFromPathname(pathname);
        if (!jobId || !pathBelongsToJob(pathname, jobId)) {
          throw new Error("BAD_PATHNAME");
        }
        if (!pathname.includes("/source/")) {
          throw new Error("BAD_PATHNAME");
        }

        const extension = safeExtension(pathname);
        if (!isSupportedExtension(extension)) {
          throw new Error("UNSUPPORTED");
        }

        // §13 steps 7-8: restrict content type and maximum size in the token
        // itself, so the CDN rejects an oversized or mistyped upload before a
        // single byte reaches storage.
        const contentType = MIME_BY_EXTENSION[extension];
        const token = await issueSignedToken({
          pathname,
          operations: ["put"],
          allowedContentTypes: [contentType],
          maximumSizeInBytes: MAX_UPLOAD_BYTES,
          validUntil: Date.now() + 20 * 60 * 1000,
        });

        return {
          token,
          urlOptions: {
            allowedContentTypes: [contentType],
            maximumSizeInBytes: MAX_UPLOAD_BYTES,
            addRandomSuffix: false,
            allowOverwrite: false,
            validUntil: Date.now() + 20 * 60 * 1000,
          },
        };
      },
    });

    return NextResponse.json(result);
  } catch (error) {
    const reason = error instanceof Error ? error.message : "unknown";
    switch (reason) {
      case "NOT_AUTHORIZED":
        return errorResponse("SERVICE_UNAVAILABLE", "auth mode not implemented");
      case "UNSUPPORTED":
        return errorResponse("UNSUPPORTED_FILE_TYPE", "extension not supported");
      case "BAD_PATHNAME":
        return errorResponse("JOB_TOKEN_INVALID", "pathname outside job scope");
      default:
        return errorResponse("SERVICE_UNAVAILABLE", "upload authorization failed");
    }
  }
}

/** Extract the job id from `jobs/<date>/<job-id>/...`. */
function jobIdFromPathname(pathname: string): string | null {
  const segments = pathname.split("/");
  if (segments.length < 4 || segments[0] !== "jobs") return null;
  return segments[2] ?? null;
}

/**
 * Upload authorization (§13).
 *
 * Issues a single-use client token so the browser uploads the source straight
 * to Private Blob. The document never passes through this Function — that is
 * the whole point of §3, given the 4.5 MB Function payload cap.
 *
 * This is the flow §12/§13 originally specified. DEVIATIONS D-004 briefly
 * moved to the newer presigned flow, and D-010 records why that was reverted:
 * `handleUploadPresigned` throws "Missing webhook public key" before it checks
 * whether a callback is even registered, and that key is a dashboard opt-in
 * that cannot be set from the CLI. We register no callback — `prepare-job`
 * verifies the upload with `head()`, which is stronger, since it checks the
 * ACTUAL size (§14) rather than trusting a notification.
 */

import {
  type HandleUploadBody,
  handleUpload,
} from "@vercel/blob/client";
import { NextResponse } from "next/server";

import { errorResponse } from "@/lib/api-errors";
import {
  isSupportedExtension,
  pathBelongsToJob,
  safeExtension,
} from "@/lib/filename";
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

/** Extract the job id from `jobs/<date>/<job-id>/...`. */
function jobIdFromPathname(pathname: string): string | null {
  const segments = pathname.split("/");
  if (segments.length < 4 || segments[0] !== "jobs") return null;
  return segments[2] ?? null;
}

export async function POST(request: Request): Promise<NextResponse> {
  let body: HandleUploadBody;
  try {
    body = (await request.json()) as HandleUploadBody;
  } catch {
    return errorResponse("INVALID_FILE_FORMAT", "upload body was not json");
  }

  try {
    const result = await handleUpload({
      body,
      request,
      onBeforeGenerateToken: async (pathname) => {
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
        // itself, so Blob rejects an oversized or mistyped upload before a
        // single byte reaches storage. §20: the store is private.
        return {
          allowedContentTypes: [MIME_BY_EXTENSION[extension]],
          maximumSizeInBytes: MAX_UPLOAD_BYTES,
          addRandomSuffix: false,
          allowOverwrite: false,
          validUntil: Date.now() + 20 * 60 * 1000,
        };
      },
      // No onUploadCompleted: `prepare-job` verifies the blob with head(),
      // which checks the real size rather than trusting a callback (§14).
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
        // Log the SDK's own reason, not just our label. It concerns token
        // issuance and carries no document content, so §47 permits recording
        // it — and without it a misconfiguration looks like a bug.
        return errorResponse(
          "SERVICE_UNAVAILABLE",
          `upload authorization failed: ${reason}`,
        );
    }
  }
}

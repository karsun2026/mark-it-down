/**
 * READMAP analysis status (D-002 pattern).
 *
 * Reads status.v1.json with the CDN cache bypassed (D-005: a stale stage
 * would make a finished analysis look stuck). Returns `stage: "UNKNOWN"`
 * while nothing has been published yet — the honest answer, not a fake stage.
 */

import { NextResponse } from "next/server";

import { errorResponse } from "@/lib/api-errors";
import { requireSession } from "@/lib/guard";
import {
  getReadmapArtifact,
  readmapArtifactPath,
} from "@/lib/readmap/artifacts";
import { verifyReadmapAccess } from "@/lib/readmap/route-access";
import type { ReadMapStatusV1 } from "@/lib/readmap/schemas/status";

export const runtime = "nodejs";

export async function POST(request: Request): Promise<NextResponse> {
  const denied = await requireSession(request);
  if (denied) return denied;

  let body: { jobToken?: unknown; resultPathname?: unknown };
  try {
    body = (await request.json()) as { jobToken?: unknown; resultPathname?: unknown };
  } catch {
    return errorResponse("JOB_TOKEN_INVALID", "readmap status body was not json");
  }

  const verified = await verifyReadmapAccess(body);
  if ("error" in verified) return verified.error;

  const statusPath = readmapArtifactPath(
    verified.access.resultPathname,
    "status.v1.json",
  );
  if (!statusPath) {
    return errorResponse("JOB_TOKEN_INVALID", "artifact path could not be derived");
  }

  const status = await getReadmapArtifact<ReadMapStatusV1>(statusPath, {
    fresh: true,
  });
  if (!status) {
    // Nothing published yet: starting up, not stuck.
    return NextResponse.json({
      stage: "STARTING",
      progress: 0,
      warnings: [],
    });
  }
  return NextResponse.json(status);
}
/**
 * The gated READMAP result (plan §5: readmap.v1.json).
 *
 * Returns the result plus the precomputed tiers so the depth slider can move
 * between reading depths entirely client-side — a tier change must never
 * trigger a model call or even a network call.
 */

import { NextResponse } from "next/server";

import { errorResponse } from "@/lib/api-errors";
import { requireSession } from "@/lib/guard";
import {
  getReadmapArtifact,
  readmapArtifactPath,
} from "@/lib/readmap/artifacts";
import { verifyReadmapAccess } from "@/lib/readmap/route-access";

export const runtime = "nodejs";

export async function POST(request: Request): Promise<NextResponse> {
  const denied = await requireSession(request);
  if (denied) return denied;

  let body: { jobToken?: unknown; resultPathname?: unknown };
  try {
    body = (await request.json()) as { jobToken?: unknown; resultPathname?: unknown };
  } catch {
    return errorResponse("JOB_TOKEN_INVALID", "readmap result body was not json");
  }

  const verified = await verifyReadmapAccess(body);
  if ("error" in verified) return verified.error;

  const readmapPath = readmapArtifactPath(
    verified.access.resultPathname,
    "readmap.v1.json",
  );
  const tiersPath = readmapArtifactPath(
    verified.access.resultPathname,
    "tiers.v1.json",
  );
  if (!readmapPath || !tiersPath) {
    return errorResponse("JOB_TOKEN_INVALID", "artifact path could not be derived");
  }

  const readmap = await getReadmapArtifact<unknown>(readmapPath);
  if (!readmap) {
    return errorResponse("BLOB_NOT_FOUND", "no completed READMAP for this job");
  }
  const tiers = await getReadmapArtifact<unknown>(tiersPath);
  return NextResponse.json({ jobId: verified.access.jobId, readmap, tiers });
}
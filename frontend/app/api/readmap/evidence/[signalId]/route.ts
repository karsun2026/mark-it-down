/**
 * Evidence behind one signal (spec §2 step 10: "User can open the evidence
 * behind any factual claim").
 *
 * Resolves server-side: the client names a signalId, and THIS route looks up
 * the signal in signals.v1.json and returns its cited evidence blocks from
 * the immutable evidence snapshot of the same job (rule 9). The client never
 * supplies a blob path — job scoping plus the artifact allow-list decide what
 * can be read (plan §7).
 */

import { NextResponse } from "next/server";

import { errorResponse } from "@/lib/api-errors";
import { requireSession } from "@/lib/guard";
import {
  getReadmapArtifact,
  readmapArtifactPath,
} from "@/lib/readmap/artifacts";
import { verifyReadmapAccess } from "@/lib/readmap/route-access";
import type { EvidenceBlockInput } from "@/lib/readmap/schemas/evidence";
import type { VerifiedSignalV1 } from "@/lib/readmap/schemas/signal";

export const runtime = "nodejs";

interface Params {
  params: Promise<{ signalId: string }>;
}

export async function POST(request: Request, params: Params): Promise<NextResponse> {
  const denied = await requireSession(request);
  if (denied) return denied;

  const { signalId } = await params.params;
  if (!/^s\d{4}$/.test(signalId)) {
    return errorResponse("JOB_TOKEN_INVALID", "malformed signal id");
  }

  let body: { jobToken?: unknown; resultPathname?: unknown };
  try {
    body = (await request.json()) as { jobToken?: unknown; resultPathname?: unknown };
  } catch {
    return errorResponse("JOB_TOKEN_INVALID", "evidence body was not json");
  }

  const verified = await verifyReadmapAccess(body);
  if ("error" in verified) return verified.error;

  const signalsPath = readmapArtifactPath(
    verified.access.resultPathname,
    "signals.v1.json",
  );
  const evidencePath = readmapArtifactPath(
    verified.access.resultPathname,
    "evidence.v1.json",
  );
  if (!signalsPath || !evidencePath) {
    return errorResponse("JOB_TOKEN_INVALID", "artifact path could not be derived");
  }

  // signals.v1.json is persisted as a bare VerifiedSignalV1[] (pipeline.ts
  // persists the array directly). Reading it as `{ signals }` dereferenced
  // undefined and 500'd every evidence lookup — BLOCKER-1. Read it as an array.
  const signals = (await getReadmapArtifact<VerifiedSignalV1[]>(signalsPath)) ?? [];
  const signal = signals.find((candidate) => candidate.id === signalId);
  if (!signal) {
    return errorResponse("BLOB_NOT_FOUND", "unknown signal for this job");
  }

  const evidence = await getReadmapArtifact<{ blocks: EvidenceBlockInput[] }>(
    evidencePath,
  );
  const blocksById = new Map((evidence?.blocks ?? []).map((b) => [b.id, b]));
  const cited = signal.evidenceBlockIds
    .map((id) => blocksById.get(id))
    .filter((block): block is EvidenceBlockInput => block !== undefined);

  return NextResponse.json({
    signal: {
      id: signal.id,
      claim: signal.skepticVerdict === "PARTIAL" ? signal.repairedClaim ?? signal.claim : signal.claim,
      type: signal.type,
      verdict: signal.skepticVerdict,
      explanation: signal.explanation,
      epistemicStatus: signal.epistemicStatus,
      warnings: signal.warnings,
    },
    evidence: cited,
  });
}
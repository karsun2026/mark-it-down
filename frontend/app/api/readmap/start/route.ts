/**
 * Start a READMAP analysis (plan §4; ADR-002).
 *
 * Takes a COMPLETED conversion (token + result pathname), downloads the
 * converted Markdown, segments it into the evidence contract, and runs the
 * full pipeline to a gated terminal state in this request. This is ADR-002's
 * accepted Phase-1 shape: minutes of analysis inside one Node function, with
 * honest status objects published to Blob as it goes (the client polls
 * /api/readmap/status in parallel); if latency exceeds function ceilings in
 * practice, the pipeline splits into resumable stages before any third
 * service is introduced.
 *
 * Every artifact write goes through the pipeline's persistArtifact hook;
 * nothing user-readable is returned unless the grounding gate passed.
 */

import { NextResponse } from "next/server";

import { errorResponse } from "@/lib/api-errors";
import { signResultDownload } from "@/lib/blob";
import { requireSession } from "@/lib/guard";
import { checkConversionRateLimit, warnIfDegraded } from "@/lib/rate-limit";
import {
  getReadmapArtifact,
  getReadmapUnit,
  putReadmapArtifact,
  putReadmapUnit,
  readmapArtifactPath,
  readmapUnitPath,
} from "@/lib/readmap/artifacts";
import { verifyReadmapAccess, modelConfigured } from "@/lib/readmap/route-access";
import { getClientForTask } from "@/lib/readmap/models/model-router";
import { segmentDocument } from "@/lib/readmap/ingestion/segment";
import {
  runReadmapPipeline,
  type ReadmapPipelineResult,
} from "@/lib/readmap/orchestration/pipeline";
import { checksumOfMarkdown } from "@/lib/readmap/orchestration/stages";
import type { ReadMapStatusV1 } from "@/lib/readmap/schemas/status";
import type { ReadMapV1 } from "@/lib/readmap/schemas/readmap";
import type { CompressedTiersV1 } from "@/lib/readmap/schemas/signal";
import type { ConvertedDocumentV1 } from "@/lib/readmap/schemas/evidence";

export const runtime = "nodejs";
export const maxDuration = 300;

interface StartRequest {
  jobToken?: unknown;
  resultPathname?: unknown;
  originalFilename?: unknown;
  pagesOrSlides?: unknown;
}

function artifactMap(resultPathname: string) {
  const path = (name: "evidence.v1.json" | "signals.v1.json" | "tiers.v1.json" | "readmap.v1.json" | "status.v1.json") =>
    readmapArtifactPath(resultPathname, name);
  return {
    "evidence.v1.json": path("evidence.v1.json"),
    "signals.v1.json": path("signals.v1.json"),
    "tiers.v1.json": path("tiers.v1.json"),
    "readmap.v1.json": path("readmap.v1.json"),
    "status.v1.json": path("status.v1.json"),
  };
}

export async function POST(request: Request): Promise<NextResponse> {
  const denied = await requireSession(request);
  if (denied) return denied;

  const rateLimit = await checkConversionRateLimit(request);
  warnIfDegraded(rateLimit, "/api/readmap/start");
  if (rateLimit.limited) {
    return errorResponse("RATE_LIMITED", "conversion rate limit exceeded");
  }

  let body: StartRequest;
  try {
    body = (await request.json()) as StartRequest;
  } catch {
    return errorResponse("JOB_TOKEN_INVALID", "readmap start body was not json");
  }

  const verified = await verifyReadmapAccess(body);
  if ("error" in verified) return verified.error;
  const { jobId, resultPathname } = verified.access;

  // Rule 15 / plan check 9: refuse BEFORE any work or token spend when the
  // model configuration cannot run. Outside development the dev adapter is
  // fail-closed, and without a provider key the pipeline would die mid-way.
  if (!modelConfigured()) {
    return errorResponse(
      "SERVICE_UNAVAILABLE",
      "No model provider is configured for READMAP. Set GEMINI_API_KEY, or use READMAP_MODEL_PROVIDER=dev in development only.",
    );
  }

  const originalFilename =
    typeof body.originalFilename === "string" && body.originalFilename.length > 0
      ? body.originalFilename
      : "document";
  const pagesOrSlides =
    typeof body.pagesOrSlides === "number" &&
    Number.isInteger(body.pagesOrSlides) &&
    body.pagesOrSlides > 0
      ? body.pagesOrSlides
      : null;

  const paths = artifactMap(resultPathname);
  if (Object.values(paths).some((p) => p === null)) {
    return errorResponse("JOB_TOKEN_INVALID", "artifact paths could not be derived");
  }

  // A completed analysis already exists for this exact result: return it
  // instead of re-billing the pipeline (idempotent retry, plan §4). The
  // pipeline persists the ReadMapV1 object itself at readmap.v1.json, so its
  // presence is the completion signal — never a `.readmap` wrapper (§6-C1).
  const existingReadmap = await getReadmapArtifact<ReadMapV1>(
    paths["readmap.v1.json"] as string,
  );
  if (existingReadmap) {
    const existingTiers = await getReadmapArtifact<CompressedTiersV1>(
      paths["tiers.v1.json"] as string,
    );
    const existingStatus = await getReadmapArtifact<{ stage?: string }>(
      paths["status.v1.json"] as string,
      { fresh: true },
    );
    return NextResponse.json({
      status: existingStatus?.stage === "PARTIAL_READY" ? "PARTIAL_READY" : "READY",
      jobId,
      reused: true,
      readmap: existingReadmap,
      tiers: existingTiers ?? null,
      warnings: existingReadmap.coverage.limitations,
    });
  }

  let markdown: string;
  try {
    const url = await signResultDownload(resultPathname);
    const response = await fetch(url, { cache: "no-store" });
    if (!response.ok) {
      return errorResponse("BLOB_NOT_FOUND", "conversion result not readable");
    }
    markdown = await response.text();
  } catch {
    return errorResponse("BLOB_NOT_FOUND", "conversion result not readable");
  }
  if (markdown.trim().length === 0) {
    return errorResponse("INVALID_FILE_FORMAT", "conversion result is empty");
  }

  const lower = originalFilename.toLowerCase();
  const sourceType = lower.endsWith(".pptx") ? "pptx" : lower.endsWith(".docx") ? "docx" : "pdf";
  const document: ConvertedDocumentV1 = segmentDocument({
    markdown,
    filename: originalFilename,
    sourceType,
    pagesOrSlides,
  });

  const result: ReadmapPipelineResult = await runReadmapPipeline({
    jobId,
    checksumSha256: checksumOfMarkdown(markdown),
    document,
    getClient: getClientForTask,
    onStage: (status: ReadMapStatusV1) => {
      // Best-effort (D-002): a failed status write never fails the job.
      void putReadmapArtifact(paths["status.v1.json"] as string, status).catch(
        () => {},
      );
    },
    persistArtifact: async (name, value) => {
      const path = paths[name as keyof typeof paths];
      if (!path) throw new Error(`unknown artifact ${name}`);
      // §6-M4: evidence and signals are immutable snapshots — never
      // overwritten. On a retried run the same content is already there
      // (pinned by checksum + pipeline version), so a pre-existing
      // artifact is kept as-is instead of failing the write.
      const immutable = name === "evidence.v1.json" || name === "signals.v1.json";
      if (immutable) {
        const existing = await getReadmapArtifact(path);
        if (existing !== null) return;
      }
      await putReadmapArtifact(path, value, { immutable });
    },
    // §6-C2: per-unit checkpoints under the idempotency key, so a retried
    // or resumed run reuses completed units instead of re-billing them.
    checkpoint: {
      get: async <T,>(key: string) => {
        const unitPath = readmapUnitPath(resultPathname, key);
        if (!unitPath) return null;
        return getReadmapUnit<T>(unitPath);
      },
      put: async (key: string, value: unknown) => {
        const unitPath = readmapUnitPath(resultPathname, key);
        if (!unitPath) return;
        await putReadmapUnit(unitPath, value);
      },
    },
  });

  if (result.status === "FAILED" || !result.readmap) {
    return errorResponse(
      "CONVERSION_FAILED",
      result.failedStage === "GROUNDING"
        ? "The analysis could not be grounded in the document and was refused."
        : "The analysis could not complete. Please try again.",
    );
  }

  return NextResponse.json({
    status: result.status,
    jobId,
    readmap: result.readmap,
    tiers: result.tiers ?? null,
    warnings: result.warnings,
  });
}
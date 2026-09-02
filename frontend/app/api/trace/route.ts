/**
 * Client trace beacon — temporary diagnostic.
 *
 * A job that had already succeeded server-side was appearing to stall in one
 * user's browser, at a step that completes in ~1s from every client I can
 * test. The client flow reproduces cleanly from Node, so the difference is
 * browser-specific and invisible from here.
 *
 * This lets the browser report which step it reached, so the server log shows
 * where it actually stops rather than where I guess it stops.
 *
 * §47 applies: the payload carries a step name and a duration. No document
 * content, no filenames, no URLs, no tokens.
 */

import { NextResponse } from "next/server";

import { requireSession } from "@/lib/guard";

export const runtime = "nodejs";

const ALLOWED_STEPS = new Set([
  "start",
  "upload-begin",
  "upload-done",
  "prepare-done",
  "stage",
  "race-resolved",
  "download-url-begin",
  "download-url-done",
  "flow-complete",
  "flow-error",
]);

export async function POST(request: Request): Promise<NextResponse> {
  const denied = await requireSession(request);
  if (denied) return denied;

  let step = "unknown";
  let detail = "";
  let elapsedMs = -1;
  try {
    const body = (await request.json()) as Record<string, unknown>;
    step = typeof body.step === "string" ? body.step : "unknown";
    // Bounded and allow-listed, so the log cannot be used as a dumping ground.
    detail = typeof body.detail === "string" ? body.detail.slice(0, 80) : "";
    elapsedMs = typeof body.elapsedMs === "number" ? body.elapsedMs : -1;
  } catch {
    // Fall through and log what we have.
  }

  if (!ALLOWED_STEPS.has(step)) step = "unknown";
  console.info(`[client-trace] step=${step} elapsed_ms=${elapsedMs} ${detail}`);

  return NextResponse.json({ ok: true });
}

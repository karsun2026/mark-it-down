/**
 * Hourly retention sweep (§40, §41).
 *
 * Deletes abandoned source blobs past their retention window and result blobs
 * past theirs. §41 is explicit that browser-side cleanup is not sufficient —
 * a closed tab or a crashed converter must not strand documents in storage.
 *
 * Logs counts only (§47): never pathnames, never filenames.
 */

import { del, list } from "@vercel/blob";
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const maxDuration = 60;

const MINUTE_MS = 60 * 1000;

const SOURCE_MAX_AGE_MINUTES = envMinutes("SOURCE_BLOB_MAX_AGE_MINUTES", 60);
const RESULT_MAX_AGE_MINUTES = envMinutes("RESULT_BLOB_MAX_AGE_MINUTES", 120);
const STATUS_MAX_AGE_MINUTES = RESULT_MAX_AGE_MINUTES;

/** §41 - bound the work per invocation so a backlog cannot run past maxDuration. */
const MAX_DELETIONS_PER_RUN = 500;
const PAGE_SIZE = 250;

function envMinutes(name: string, fallback: number): number {
  const raw = process.env[name];
  const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function isAuthorized(request: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  return request.headers.get("authorization") === `Bearer ${secret}`;
}

function maxAgeMinutesFor(pathname: string): number | null {
  if (pathname.includes("/source/")) return SOURCE_MAX_AGE_MINUTES;
  if (pathname.includes("/result/")) return RESULT_MAX_AGE_MINUTES;
  if (pathname.endsWith("/status.json")) return STATUS_MAX_AGE_MINUTES;
  return null;
}

export async function GET(request: Request): Promise<NextResponse> {
  // Vercel Cron sends the CRON_SECRET as a bearer token. Anything else is
  // refused: this route deletes data.
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const now = Date.now();
  const deleted = { source: 0, result: 0, status: 0 };
  let scanned = 0;
  let cursor: string | undefined;
  let truncated = false;

  try {
    do {
      const page = await list({ prefix: "jobs/", limit: PAGE_SIZE, cursor });
      scanned += page.blobs.length;

      const expired: string[] = [];
      for (const blob of page.blobs) {
        const maxAge = maxAgeMinutesFor(blob.pathname);
        if (maxAge === null) continue;

        const ageMs = now - new Date(blob.uploadedAt).getTime();
        if (ageMs < maxAge * MINUTE_MS) continue;

        expired.push(blob.url);
        if (blob.pathname.includes("/source/")) deleted.source += 1;
        else if (blob.pathname.includes("/result/")) deleted.result += 1;
        else deleted.status += 1;
      }

      if (expired.length > 0) {
        await del(expired);
      }

      const total = deleted.source + deleted.result + deleted.status;
      if (total >= MAX_DELETIONS_PER_RUN) {
        // Leave the rest for the next hourly run rather than risk a timeout.
        truncated = true;
        break;
      }

      cursor = page.hasMore ? page.cursor : undefined;
    } while (cursor);
  } catch {
    console.info("cleanup sweep failed partway", { scanned, ...deleted });
    return NextResponse.json(
      { ok: false, scanned, deleted, truncated },
      { status: 500 },
    );
  }

  // Counts only (§47).
  console.info("cleanup sweep complete", { scanned, ...deleted, truncated });
  return NextResponse.json({ ok: true, scanned, deleted, truncated });
}

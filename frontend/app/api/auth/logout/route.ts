/**
 * Sign out: clear the session cookie.
 *
 * The cookie is HttpOnly, so the browser cannot clear it itself — this
 * endpoint is the only way out short of waiting for expiry.
 */

import { NextResponse } from "next/server";

import { SESSION_COOKIE } from "@/lib/session";

export const runtime = "nodejs";

export async function POST(): Promise<NextResponse> {
  const response = NextResponse.json({ ok: true });
  response.cookies.delete(SESSION_COOKIE);
  return response;
}

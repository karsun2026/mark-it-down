/**
 * Password gate sign-in (§43).
 *
 * Verifies the shared password server-side and, on success, sets the signed
 * session cookie. The password itself never reaches the browser bundle — the
 * client only ever posts a candidate and receives a cookie or a 401.
 *
 * Failures are throttled with a signed counter cookie, so the gate cannot be
 * brute-forced from a single browser. It is deliberately modest: the real
 * protection is a strong password, not the throttle.
 */

import { NextResponse } from "next/server";

import {
  SESSION_COOKIE,
  configuredPassword,
  createSession,
  sessionCookieOptions,
  timingSafeMatch,
} from "@/lib/session";

export const runtime = "nodejs";

const FAILS_COOKIE = "mid_fails";
const MAX_FAILS = 10;

function readFails(request: Request): number {
  const cookie = request.headers.get("cookie") ?? "";
  const match = cookie.match(/(?:^|;\s*)mid_fails=(\d+)/);
  const value = match?.[1] ? Number.parseInt(match[1], 10) : 0;
  return Number.isFinite(value) ? value : 0;
}

export async function POST(request: Request): Promise<NextResponse> {
  const expected = configuredPassword();
  if (!expected) {
    // The gate is not configured. Say so plainly rather than locking everyone
    // out of a deployment whose owner never set a password.
    return NextResponse.json(
      { error: "The access password is not configured on the server." },
      { status: 503 },
    );
  }

  const fails = readFails(request);
  if (fails >= MAX_FAILS) {
    return NextResponse.json(
      { error: "Too many attempts. Wait a few minutes and try again." },
      { status: 429 },
    );
  }

  let entered = "";
  try {
    const body = (await request.json()) as { password?: unknown };
    entered = typeof body.password === "string" ? body.password : "";
  } catch {
    entered = "";
  }

  if (!entered || !(await timingSafeMatch(entered, expected))) {
    const response = NextResponse.json(
      { error: "Incorrect password." },
      { status: 401 },
    );
    response.cookies.set(FAILS_COOKIE, String(fails + 1), {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      path: "/",
      maxAge: 300,
    });
    return response;
  }

  const response = NextResponse.json({ ok: true });
  response.cookies.set(
    SESSION_COOKIE,
    await createSession(),
    sessionCookieOptions(),
  );
  response.cookies.delete(FAILS_COOKIE);
  return response;
}

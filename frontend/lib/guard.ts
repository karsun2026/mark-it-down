/**
 * Per-route enforcement of the password gate (§43).
 *
 * ## Why not middleware
 *
 * The obvious place for this is `middleware.ts`, and that was the first
 * attempt. It cannot work here: Next.js middleware compiles to an Edge
 * Function, and Vercel rejects the deployment with
 *
 *     Edge Runtime is not supported in services.
 *     Service "frontend" produced Edge Function output "middleware".
 *
 * because `vercel.json` declares a multi-service project — which it must, to
 * run the Python converter container (§6, §8). Edge middleware and the
 * container service are mutually exclusive.
 *
 * So the gate is applied explicitly at each entry point instead. That is more
 * verbose, but it has a real advantage: a new route is visibly unguarded
 * rather than silently covered by a matcher pattern someone has to remember to
 * update.
 *
 * Coverage:
 *   /                        server component checks before rendering
 *   /api/blob/upload         requireSession
 *   /api/blob/prepare-job    requireSession
 *   /api/blob/download-url   requireSession
 *   /api/blob/cleanup        NOT gated - Vercel Cron authenticates with
 *                            CRON_SECRET; it has no browser session
 *   /converter/*             NOT gated here - routed to the container by the
 *                            platform, and protected independently by the
 *                            HMAC job token that only prepare-job issues
 */

import { NextResponse } from "next/server";

import {
  BYPASS_HEADER,
  SESSION_COOKIE,
  configuredPassword,
  isValidSession,
  timingSafeMatch,
} from "./session";

function cookieValue(request: Request, name: string): string | null {
  const header = request.headers.get("cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return decodeURIComponent(rest.join("="));
  }
  return null;
}

/** True when this request may proceed. */
export async function hasAccess(request: Request): Promise<boolean> {
  const expected = configuredPassword();
  // No password configured means the gate is off: local development, or a
  // deployment relying on platform protection instead.
  if (!expected) return true;

  if (await isValidSession(cookieValue(request, SESSION_COOKIE))) return true;

  // Automated callers (the §57 release test, CI) present the password as a
  // header rather than holding a cookie.
  const headerPassword = request.headers.get(BYPASS_HEADER);
  if (headerPassword && (await timingSafeMatch(headerPassword, expected))) {
    return true;
  }

  return false;
}

/**
 * Guard for an API route. Returns a 401 response to return immediately, or
 * null when the request may proceed.
 *
 * Usage: `const denied = await requireSession(request); if (denied) return denied;`
 */
export async function requireSession(
  request: Request,
): Promise<NextResponse | null> {
  if (await hasAccess(request)) return null;
  return NextResponse.json(
    { code: "SERVICE_UNAVAILABLE", message: "Please sign in to use this tool." },
    { status: 401 },
  );
}

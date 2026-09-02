/**
 * Conversion rate limiting (§44).
 *
 * §44: "5 conversions per user / 10 minutes", and "If no identity is available,
 * use IP-level Vercel Firewall/rate limiting. Do not add Redis solely for MVP."
 *
 * `@vercel/firewall` satisfies that exactly — the counter lives in Vercel's
 * edge, so there is no Redis and no new infrastructure. When an identity
 * exists the bucket is keyed on the user; when it does not, the SDK's default
 * bucket is the client IP, which is the fallback §44 names.
 *
 * ## The failure mode this module exists to make visible
 *
 * `checkRateLimit` depends on a Firewall rule with a matching ID existing in
 * the project dashboard. If that rule is missing the call does NOT throw: it
 * resolves with `{ rateLimited: false, error: 'not-found' }`. Reading only
 * `rateLimited` — the shape every code sample in the docs uses — therefore
 * yields a rate limiter that silently never limits anything, which is worse
 * than none because the code still reads as protected.
 *
 * So: every non-limiting outcome is logged with the reason, and
 * `RATE_LIMIT_REQUIRED=true` turns a misconfiguration into a refusal instead of
 * an open door. The default is fail-open, because failing closed on a
 * transient Firewall error would take the whole app down.
 *
 * Setup, once per project:
 *   Dashboard -> Firewall -> Configure -> New Rule
 *   If:   @vercel/firewall,  Rate limit ID: `conversions`
 *   Then: Rate Limit, Fixed Window, 600s window, 5 requests
 */

import { checkRateLimit } from "@vercel/firewall";

import { authenticate, rateLimitKeyFor, type Identity } from "./auth";

/** Must match the Rate limit ID configured on the dashboard rule. */
export const CONVERSION_RATE_LIMIT_ID = "conversions";

/** §44's stated intent, recorded here so the dashboard rule can be checked. */
export const EXPECTED_LIMIT = 5;
export const EXPECTED_WINDOW_SECONDS = 600;

export interface RateLimitOutcome {
  limited: boolean;
  /** Why the request was allowed, when it was not actually rate-checked. */
  degraded: "not-configured" | "error" | "disabled" | null;
}

function isEnabled(): boolean {
  return (process.env.RATE_LIMIT_ENABLED ?? "true").toLowerCase() !== "false";
}

function mustBeEnforced(): boolean {
  return (process.env.RATE_LIMIT_REQUIRED ?? "false").toLowerCase() === "true";
}

/**
 * Check the conversion rate limit for a request.
 *
 * Never throws. The caller decides what to do with `limited`.
 */
export async function checkConversionRateLimit(
  request: Request,
  identity?: Identity,
): Promise<RateLimitOutcome> {
  if (!isEnabled()) {
    return { limited: false, degraded: "disabled" };
  }

  let resolved = identity;
  if (!resolved) {
    try {
      resolved = await authenticate(request);
    } catch {
      // An auth failure is the caller's problem, not the limiter's. Fall back
      // to the anonymous (client-IP) bucket rather than skipping the check.
      resolved = { userId: null, source: "anonymous" };
    }
  }

  const key = rateLimitKeyFor(resolved);

  try {
    const { rateLimited, error } = await checkRateLimit(
      CONVERSION_RATE_LIMIT_ID,
      {
        request,
        // Omitting the key uses the SDK default: bucket by client IP (§44).
        ...(key ? { rateLimitKey: key } : {}),
      },
    );

    // The SDK does NOT throw when the dashboard rule is missing — it returns
    // `error: 'not-found'` with `rateLimited: false`. Ignoring this field is
    // precisely how a rate limiter ends up silently doing nothing.
    if (error === "not-found") {
      return {
        limited: mustBeEnforced(),
        degraded: mustBeEnforced() ? null : "not-configured",
      };
    }

    // 'blocked' means the firewall itself rejected the request. Treat it as
    // limited: something upstream has already decided to refuse this caller.
    if (error === "blocked") {
      return { limited: true, degraded: null };
    }

    return { limited: rateLimited, degraded: null };
  } catch (error) {
    const reason = error instanceof Error ? error.message : "unknown";
    // Shape only — never the key, which may identify a user (§47).
    console.warn(
      `rate limit check failed (id=${CONVERSION_RATE_LIMIT_ID}): ${reason}`,
    );
    return {
      limited: mustBeEnforced(),
      degraded: mustBeEnforced() ? null : "error",
    };
  }
}

/**
 * Log when a request was allowed without being genuinely rate-checked.
 *
 * This is the line that reveals a missing dashboard rule in production, rather
 * than letting it pass unnoticed.
 */
export function warnIfDegraded(outcome: RateLimitOutcome, route: string): void {
  if (!outcome.degraded) return;
  if (outcome.degraded === "disabled") return;
  console.warn(
    `rate limiting is NOT in effect on ${route} (${outcome.degraded}); ` +
      `expected a Firewall rule with id "${CONVERSION_RATE_LIMIT_ID}"`,
  );
}

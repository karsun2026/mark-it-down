/**
 * Modular request authentication (§43).
 *
 * §43 keeps auth pluggable and names two modes:
 *
 *   none   — development only
 *   entra  — Microsoft Entra ID, for production
 *
 * §43 is also explicit that production "should not expose internal conversion
 * capability anonymously on the internet". `AUTH_MODE=none` therefore does NOT
 * mean "safe to run publicly"; it means the platform must be doing the
 * gatekeeping instead, via Vercel Deployment Protection.
 *
 * The identity returned here feeds two things: the §44 rate-limit bucket, and
 * (later) any per-user quota. It never reaches the browser, and per §47 the
 * user id is never logged.
 */

export type AuthMode = "none" | "entra";

export interface Identity {
  /** Stable per-user key. `null` when anonymous. */
  userId: string | null;
  /** How the identity was established, for the rate-limit key namespace. */
  source: AuthMode | "anonymous";
}

export class AuthNotConfiguredError extends Error {
  constructor(mode: string) {
    super(`auth mode "${mode}" is selected but not configured`);
    this.name = "AuthNotConfiguredError";
  }
}

export function authMode(): AuthMode {
  const raw = (process.env.AUTH_MODE ?? "none").trim().toLowerCase();
  return raw === "entra" ? "entra" : "none";
}

/** True when the deployment is relying on the platform to gate access. */
export function isAnonymousMode(): boolean {
  return authMode() === "none";
}

/**
 * Resolve the caller's identity.
 *
 * Throws `AuthNotConfiguredError` rather than silently falling back to
 * anonymous: a deployment that *intends* to require Entra and is missing its
 * configuration must fail closed, not quietly serve everyone.
 */
export async function authenticate(request: Request): Promise<Identity> {
  const mode = authMode();

  if (mode === "none") {
    return { userId: null, source: "anonymous" };
  }

  // Entra ID. Phase 5 wires the real token validation; until the app
  // registration exists there is nothing to validate against, so this fails
  // closed by design.
  const tenantId = process.env.ENTRA_TENANT_ID;
  const clientId = process.env.ENTRA_CLIENT_ID;
  if (!tenantId || !clientId) {
    throw new AuthNotConfiguredError(mode);
  }

  // Vercel injects the verified user header when platform SSO is in front of
  // the app. Where a bearer token is used instead, validation goes here.
  const headerUser =
    request.headers.get("x-vercel-user-id") ??
    request.headers.get("x-ms-client-principal-id");
  if (!headerUser) {
    throw new AuthNotConfiguredError(mode);
  }

  return { userId: headerUser, source: "entra" };
}

/**
 * The §44 rate-limit bucket key.
 *
 * Namespaced by source so an authenticated user and an anonymous IP can never
 * collide in the same bucket. Returns null when there is no identity, which
 * tells the caller to fall back to the SDK's default client-IP bucket — which
 * is exactly what §44 prescribes when no identity is available.
 */
export function rateLimitKeyFor(identity: Identity): string | null {
  if (!identity.userId) return null;
  return `${identity.source}:${identity.userId}`;
}

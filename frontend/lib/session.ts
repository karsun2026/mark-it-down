/**
 * Signed session cookie for the shared-password gate (§43).
 *
 * §43 allows "Microsoft Entra ID **or another approved SSO/access-control
 * method**". This is that other method: one shared password, entered once,
 * after which the tool works normally.
 *
 * ## Why Web Crypto and not `node:crypto`
 *
 * This module is imported by `middleware.ts`, which Next.js runs on the Edge
 * runtime. Edge has no Node built-ins, so importing `node:crypto` here fails
 * the build outright with `UnhandledSchemeError`. `crypto.subtle` is available
 * in both Edge and Node, so everything below is async by necessity.
 *
 * ## Design notes that matter
 *
 *  * The password is verified **server-side only** and never reaches the
 *    browser bundle. The client posts it and gets back a cookie.
 *  * The cookie is HttpOnly, so JavaScript cannot read or exfiltrate it, and
 *    it is signed with `JOB_SIGNING_SECRET` so it cannot be forged.
 *  * Comparison is constant-time, so the password cannot be recovered a
 *    character at a time by measuring response times.
 *  * Middleware enforces it on API routes too, not just on the page. A gate
 *    that only hides the UI leaves `/api/blob/upload` open to anyone who
 *    reads the JavaScript.
 *
 * What this is NOT: per-person identity. One shared secret means no audit
 * trail and no individual revocation — rotate it for everyone, or move to
 * Entra. Recorded in SECURITY.md as a known limitation.
 */

export const SESSION_COOKIE = "mid_session";

/** How long a single sign-in lasts before the password is asked for again. */
export const SESSION_TTL_SECONDS = 12 * 60 * 60;

/** Header an automated caller may use instead of the cookie (§57 tests, CI). */
export const BYPASS_HEADER = "x-app-password";

const encoder = new TextEncoder();

function secretMaterial(): Uint8Array {
  const raw = process.env.JOB_SIGNING_SECRET ?? "";
  if (raw.length < 32) {
    throw new Error("JOB_SIGNING_SECRET missing or too short");
  }
  return encoder.encode(raw);
}

/** The configured gate password, or null when the gate is not enabled. */
export function configuredPassword(): string | null {
  const raw = (process.env.APP_PASSWORD ?? "").trim();
  return raw.length > 0 ? raw : null;
}

async function hmac(payload: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    secretMaterial() as unknown as BufferSource,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(payload) as unknown as BufferSource,
  );
  return base64url(new Uint8Array(signature));
}

function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function sha256(value: string): Promise<Uint8Array> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    encoder.encode(value) as unknown as BufferSource,
  );
  return new Uint8Array(digest);
}

/**
 * Constant-time comparison.
 *
 * Both sides are hashed first so the compared buffers are always the same
 * length — otherwise the comparison itself would leak the password's length.
 * The loop accumulates differences rather than returning early.
 */
export async function timingSafeMatch(a: string, b: string): Promise<boolean> {
  const [left, right] = await Promise.all([sha256(a), sha256(b)]);
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= (left[index] ?? 0) ^ (right[index] ?? 0);
  }
  return difference === 0;
}

/** Mint a session value: `<expiry>.<signature>`. */
export async function createSession(now: number = Date.now()): Promise<string> {
  const expiresAt = Math.floor(now / 1000) + SESSION_TTL_SECONDS;
  const payload = String(expiresAt);
  return `${payload}.${await hmac(payload)}`;
}

/** True when the cookie value is well-formed, correctly signed and unexpired. */
export async function isValidSession(
  value: string | undefined | null,
  now: number = Date.now(),
): Promise<boolean> {
  if (!value) return false;

  const parts = value.split(".");
  if (parts.length !== 2) return false;
  const [payload, signature] = parts;
  if (!payload || !signature) return false;

  let expected: string;
  try {
    expected = await hmac(payload);
  } catch {
    // Misconfigured secret: refuse rather than accept anything.
    return false;
  }

  // Signature first — an expired-but-unsigned cookie must not be
  // distinguishable from a forged one.
  if (!(await timingSafeMatch(signature, expected))) return false;

  const expiresAt = Number.parseInt(payload, 10);
  if (!Number.isFinite(expiresAt)) return false;
  return expiresAt > Math.floor(now / 1000);
}

/** Cookie attributes. Secure is dropped in development so localhost works. */
export function sessionCookieOptions() {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax" as const,
    path: "/",
    maxAge: SESSION_TTL_SECONDS,
  };
}

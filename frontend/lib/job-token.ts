/**
 * Mint HMAC-signed job tokens (§16).
 *
 * Wire format must match `converter/app/security/job_token.py` exactly:
 *
 *     base64url(JSON.stringify(payload, sorted keys, no spaces)
 *       + "." + base64url(HMAC_SHA256(payload_b64))
 *
 * Key ordering matters because both sides sign the serialized bytes. The
 * Python side uses `json.dumps(..., sort_keys=True, separators=(",", ":"))`,
 * so this builds the same compact, key-sorted form by hand rather than
 * relying on JS object insertion order.
 */

import { createHmac, timingSafeEqual } from "node:crypto";

export const MIN_SECRET_BYTES = 32;

export interface JobClaims {
  job_id: string;
  source_path: string;
  result_path: string;
  filename: string;
  source_size: number;
  exp: number;
}

function base64url(input: Buffer): string {
  return input.toString("base64url");
}

/**
 * Serialize claims exactly as Python's sort_keys/compact dumps would.
 *
 * Written out explicitly rather than via Object.keys().sort() so the field
 * list is visible and cannot drift silently from the Python dataclass.
 */
function serializeClaims(claims: JobClaims): string {
  const ordered = {
    exp: claims.exp,
    filename: claims.filename,
    job_id: claims.job_id,
    result_path: claims.result_path,
    source_path: claims.source_path,
    source_size: claims.source_size,
  };
  return JSON.stringify(ordered);
}

export function signingSecret(): Buffer {
  const raw = process.env.JOB_SIGNING_SECRET ?? "";
  const secret = Buffer.from(raw, "utf8");
  if (secret.length < MIN_SECRET_BYTES) {
    // A deployment fault, not a client error. Thrown so the route returns
    // SERVICE_UNAVAILABLE rather than minting a weakly-signed token.
    throw new Error("JOB_SIGNING_SECRET missing or too short");
  }
  return secret;
}

export function mintJobToken(claims: JobClaims, secret = signingSecret()): string {
  const payloadB64 = base64url(Buffer.from(serializeClaims(claims), "utf8"));
  const signature = createHmac("sha256", secret).update(payloadB64).digest();
  return `${payloadB64}.${base64url(signature)}`;
}

/**
 * Verify a token this server minted (§19 - the download route re-checks it).
 *
 * Returns null rather than throwing, so callers map the failure onto the right
 * §46 code themselves.
 */
export function verifyJobToken(
  token: string,
  secret = signingSecret(),
): { claims: JobClaims; expired: boolean } | null {
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [payloadB64, signatureB64] = parts;
  if (!payloadB64 || !signatureB64) return null;

  const expected = createHmac("sha256", secret).update(payloadB64).digest();
  let provided: Buffer;
  try {
    provided = Buffer.from(signatureB64, "base64url");
  } catch {
    return null;
  }
  if (provided.length !== expected.length) return null;
  if (!timingSafeEqual(provided, expected)) return null;

  let claims: JobClaims;
  try {
    claims = JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf8"));
  } catch {
    return null;
  }

  if (
    typeof claims?.job_id !== "string" ||
    typeof claims?.source_path !== "string" ||
    typeof claims?.result_path !== "string" ||
    typeof claims?.filename !== "string" ||
    typeof claims?.source_size !== "number" ||
    typeof claims?.exp !== "number"
  ) {
    return null;
  }

  const expired = claims.exp * 1000 < Date.now();
  return { claims, expired };
}

/**
 * Vercel Blob helpers (§13, §15, §19, §20).
 *
 * Everything is `access: 'private'` (§20) and reached through short-lived
 * signed URLs. No store credential ever leaves the server.
 *
 * The `useCache` flag on status GETs is not cosmetic — see DEVIATIONS.md
 * D-005. Presigned GETs are CDN-cached and an overwritten blob can serve a
 * stale body for up to 60 seconds, which would make a finished job appear
 * stuck while the client polls.
 */

import { head, issueSignedToken, presignUrl } from "@vercel/blob";

import { MAX_UPLOAD_BYTES } from "./types";

const ACCESS = "private" as const;

const MINUTE_MS = 60 * 1000;

export const SIGNED_SOURCE_URL_MINUTES = envMinutes(
  "SIGNED_SOURCE_URL_MINUTES",
  20,
);
export const SIGNED_RESULT_PUT_URL_MINUTES = envMinutes(
  "SIGNED_RESULT_PUT_URL_MINUTES",
  20,
);
export const SIGNED_DOWNLOAD_URL_MINUTES = envMinutes(
  "SIGNED_DOWNLOAD_URL_MINUTES",
  10,
);

function envMinutes(name: string, fallback: number): number {
  const raw = process.env[name];
  const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function expiryFromNow(minutes: number): number {
  return Date.now() + minutes * MINUTE_MS;
}

/** Signed GET for the source document, handed to the converter. */
export async function signSourceGet(pathname: string): Promise<string> {
  const validUntil = expiryFromNow(SIGNED_SOURCE_URL_MINUTES);
  const token = await issueSignedToken({
    pathname,
    operations: ["get"],
    validUntil,
  });
  const { presignedUrl } = await presignUrl(token, {
    operation: "get",
    pathname,
    access: ACCESS,
    validUntil,
  });
  return presignedUrl;
}

/** Signed DELETE so the converter can drop the source as soon as it is done. */
export async function signSourceDelete(pathname: string): Promise<string> {
  const validUntil = expiryFromNow(SIGNED_SOURCE_URL_MINUTES);
  const token = await issueSignedToken({
    pathname,
    operations: ["delete"],
    validUntil,
  });
  const { presignedUrl } = await presignUrl(token, {
    operation: "delete",
    pathname,
    access: ACCESS,
    validUntil,
  });
  return presignedUrl;
}

/** Signed PUT for the result ZIP. Written once, so no overwrite is allowed. */
export async function signResultPut(pathname: string): Promise<string> {
  const validUntil = expiryFromNow(SIGNED_RESULT_PUT_URL_MINUTES);
  const token = await issueSignedToken({
    pathname,
    operations: ["put"],
    allowedContentTypes: ["application/zip"],
    // §22 caps the result at 180 MB; leave headroom rather than a hard equal.
    maximumSizeInBytes: 200 * 1024 * 1024,
    validUntil,
  });
  const { presignedUrl } = await presignUrl(token, {
    operation: "put",
    pathname,
    access: ACCESS,
    allowedContentTypes: ["application/zip"],
    maximumSizeInBytes: 200 * 1024 * 1024,
    addRandomSuffix: false,
    allowOverwrite: false,
    validUntil,
  });
  return presignedUrl;
}

/**
 * Signed PUT for the status object (D-002).
 *
 * Overwritten at every stage, so `allowOverwrite` must be true and
 * `addRandomSuffix` false — otherwise each stage would land on a new pathname
 * the client is not polling.
 */
export async function signStatusPut(pathname: string): Promise<string> {
  const validUntil = expiryFromNow(SIGNED_RESULT_PUT_URL_MINUTES);
  const token = await issueSignedToken({
    pathname,
    operations: ["put"],
    allowedContentTypes: ["application/json"],
    maximumSizeInBytes: 64 * 1024,
    validUntil,
  });
  const { presignedUrl } = await presignUrl(token, {
    operation: "put",
    pathname,
    access: ACCESS,
    allowedContentTypes: ["application/json"],
    maximumSizeInBytes: 64 * 1024,
    addRandomSuffix: false,
    allowOverwrite: true,
    validUntil,
  });
  return presignedUrl;
}

/**
 * Signed GET for the status object, with the CDN cache bypassed.
 *
 * D-005: without `useCache: false` this returns a stale stage for up to 60
 * seconds after each overwrite, and polling reports a finished job as stuck.
 */
export async function signStatusGet(pathname: string): Promise<string> {
  const validUntil = expiryFromNow(SIGNED_RESULT_PUT_URL_MINUTES);
  const token = await issueSignedToken({
    pathname,
    operations: ["get"],
    validUntil,
  });
  const { presignedUrl } = await presignUrl(token, {
    operation: "get",
    pathname,
    access: ACCESS,
    useCache: false,
    validUntil,
  });
  return presignedUrl;
}

/** Signed GET for the finished ZIP, handed to the browser (§19). */
export async function signResultDownload(pathname: string): Promise<string> {
  const validUntil = expiryFromNow(SIGNED_DOWNLOAD_URL_MINUTES);
  const token = await issueSignedToken({
    pathname,
    operations: ["get"],
    validUntil,
  });
  const { presignedUrl } = await presignUrl(token, {
    operation: "get",
    pathname,
    access: ACCESS,
    validUntil,
  });
  return presignedUrl;
}

export interface BlobFacts {
  exists: boolean;
  size: number;
}

/**
 * §14 - verify the ACTUAL uploaded size rather than what the client declared.
 *
 * The client-upload token already caps size at the CDN, so this is belt and
 * braces; it is cheap, and it is the only check that sees reality.
 */
export async function inspectBlob(pathname: string): Promise<BlobFacts> {
  try {
    const details = await head(pathname);
    return { exists: true, size: details.size };
  } catch {
    return { exists: false, size: 0 };
  }
}

export function exceedsUploadLimit(size: number): boolean {
  return size > MAX_UPLOAD_BYTES;
}

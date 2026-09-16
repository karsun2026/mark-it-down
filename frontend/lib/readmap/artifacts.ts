/**
 * READMAP artifact persistence (ADR-004: version-named Vercel Blob JSON
 * objects; no database).
 *
 * Artifacts live under the CONVERSION job's own prefix, so the job scoping
 * machinery (`pathBelongsToJob`) applies unchanged:
 *
 *   jobs/<yyyy-mm-dd>/<job-id>/readmap/evidence.v1.json   (immutable snapshot)
 *   jobs/<yyyy-mm-dd>/<job-id>/readmap/signals.v1.json
 *   jobs/<yyyy-mm-dd>/<job-id>/readmap/tiers.v1.json      (precomputed tiers)
 *   jobs/<yyyy-mm-dd>/<job-id>/readmap/readmap.v1.json    (the gated result)
 *   jobs/<yyyy-mm-dd>/<job-id>/readmap/status.v1.json     (overwritten; D-002)
 *
 * `evidence`/`signals`/`tiers`/`readmap` are written once per version and
 * never overwritten with different content (spec §7: never overwrite the
 * evidence behind a displayed result — a retry writes the SAME version name
 * only because the pipeline version pins the content). `status` is the only
 * object that is deliberately overwritten, and its reads bypass the CDN
 * cache (D-005: a stale stage makes a finished job look stuck).
 */

import { createHash } from "node:crypto";

import { issueSignedToken, presignUrl, put } from "@vercel/blob";

const ACCESS = "private" as const;

/** Artifact file names the pipeline writes. Versioned per plan §5. */
export const READMAP_ARTIFACTS = [
  "evidence.v1.json",
  "signals.v1.json",
  "tiers.v1.json",
  "readmap.v1.json",
  "status.v1.json",
] as const;
export type ReadmapArtifactName = (typeof READMAP_ARTIFACTS)[number];

/** The job prefix `jobs/<date>/<job-id>` from a conversion result pathname. */
export function readmapBaseFromResultPath(resultPathname: string): string | null {
  const marker = "/result/";
  const index = resultPathname.indexOf(marker);
  if (index <= 0) return null;
  return resultPathname.slice(0, index);
}

/**
 * Full artifact pathname for one artifact name, or null when the name or the
 * result path is malformed. The allow-list of names is the guard: a client
 * can never make the server read or write outside `/readmap/`.
 */
export function readmapArtifactPath(
  resultPathname: string,
  name: ReadmapArtifactName,
): string | null {
  const base = readmapBaseFromResultPath(resultPathname);
  if (!base) return null;
  return `${base}/readmap/${name}`;
}

/** True when a pathname is a READMAP artifact (used by the retention sweep). */
export function isReadmapArtifact(pathname: string): boolean {
  return pathname.includes("/readmap/");
}

/** READMAP artifacts keep their own retention, independent of results (§23). */
export function readmapRetentionMinutes(): number {
  const raw = process.env.READMAP_RETENTION_DAYS;
  const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN;
  const days = Number.isFinite(parsed) && parsed > 0 ? parsed : 7;
  return days * 24 * 60;
}

/**
 * Write one artifact as private JSON.
 *
 * Immutable artifacts (`immutable: true`, ADR-004/spec §7) are written with
 * `allowOverwrite: false` so a re-run can never silently replace the evidence
 * behind a displayed result. The status object is the deliberate exception
 * (D-002): it is overwritten on every publish.
 */
export async function putReadmapArtifact(
  pathname: string,
  value: unknown,
  options: { immutable?: boolean } = {},
): Promise<void> {
  await put(pathname, JSON.stringify(value), {
    access: ACCESS,
    contentType: "application/json",
    addRandomSuffix: false,
    allowOverwrite: !options.immutable,
  });
}

/**
 * Checkpoint pathname for one pipeline unit (§6-C2). The stage key contains
 * `:` and other path-unsafe characters, so it is hashed to a flat name — the
 * checkpoint store is content-addressed by the exact key, never parsed.
 */
export function readmapUnitPath(resultPathname: string, key: string): string | null {
  const base = readmapBaseFromResultPath(resultPathname);
  if (!base) return null;
  const safe = createHash("sha256").update(key).digest("hex").slice(0, 32);
  return `${base}/readmap/units/${safe}.json`;
}

/**
 * Read one unit checkpoint (null when absent), scoped like every other
 * READMAP artifact read.
 */
export async function getReadmapUnit<T>(pathname: string): Promise<T | null> {
  return getReadmapArtifact<T>(pathname, { fresh: false });
}

/** Persist one unit checkpoint (overwritten is fine — content is key-pinned). */
export async function putReadmapUnit(
  pathname: string,
  value: unknown,
): Promise<void> {
  await putReadmapArtifact(pathname, value);
}

/**
 * Presigned GET for a READMAP artifact. `fresh` means "bypass the CDN cache"
 * (D-005): it maps to `useCache: false`, matching the converter's
 * `signStatusGet` convention — a stale status read makes a finished job look
 * stuck, so status reads must always bypass the edge cache.
 */
async function presignedGet(pathname: string, fresh: boolean): Promise<string> {
  const validUntil = Date.now() + 10 * 60 * 1000;
  const token = await issueSignedToken({
    pathname,
    operations: ["get"],
    validUntil,
  });
  const { presignedUrl } = await presignUrl(token, {
    operation: "get",
    pathname,
    access: ACCESS,
    useCache: !fresh,
    validUntil,
  });
  return presignedUrl;
}

/**
 * Read one artifact. Returns null when it does not exist yet (e.g. status
 * polled before the first publish) — the caller decides what that means.
 */
export async function getReadmapArtifact<T>(
  pathname: string,
  options: { fresh?: boolean } = {},
): Promise<T | null> {
  let url: string;
  try {
    url = await presignedGet(pathname, options.fresh ?? false);
  } catch {
    return null;
  }
  let response: Response;
  try {
    response = await fetch(url, { cache: "no-store" });
  } catch {
    return null;
  }
  if (!response.ok) return null;
  try {
    return (await response.json()) as T;
  } catch {
    return null;
  }
}
/**
 * Filename sanitisation and Blob path construction (§11, §31).
 *
 * This mirrors `converter/app/security/validation.py`. Both sides sanitise
 * independently — the client's copy is for building the display name and the
 * job path, the converter's is for anything touching its filesystem. Neither
 * trusts the other.
 *
 * §11: never use the raw user filename as a trusted path.
 */

import {
  MAX_UPLOAD_BYTES,
  SUPPORTED_EXTENSIONS,
  type SourceType,
  type SupportedExtension,
} from "./types";

// Illegal filesystem characters plus control characters. Spaces and hyphens
// are deliberately NOT stripped: they are legitimate in a display name, and
// the Python side keeps them too.
const INVALID_CHARS = /[<>:"/\\|?*\u0000-\u001f\u007f]/g;
const WHITESPACE_RUN = /\s+/g;
const DOT_RUN = /\.{2,}/g;
const MAX_STEM_LENGTH = 120;

const WINDOWS_RESERVED = new Set([
  "CON", "PRN", "AUX", "NUL",
  ...Array.from({ length: 9 }, (_, i) => `COM${i + 1}`),
  ...Array.from({ length: 9 }, (_, i) => `LPT${i + 1}`),
]);

/** Lowercased extension including the dot, or "" when absent. */
export function safeExtension(filename: string): string {
  const base = filename.replace(/\\/g, "/").split("/").pop() ?? "";
  const dot = base.lastIndexOf(".");
  // A leading dot means a hidden file, not an extension.
  if (dot <= 0) return "";
  return base.slice(dot).toLowerCase();
}

export function isSupportedExtension(
  extension: string,
): extension is SupportedExtension {
  return (SUPPORTED_EXTENSIONS as readonly string[]).includes(extension);
}

export function sourceTypeFor(filename: string): SourceType | null {
  const extension = safeExtension(filename);
  if (!isSupportedExtension(extension)) return null;
  return extension.slice(1) as SourceType;
}

/** Reduce an untrusted filename to a safe, human-readable stem. */
export function sanitizeFilenameStem(raw: string): string {
  let candidate = raw.replace(/\\/g, "/").split("/").pop() ?? "";

  const dot = candidate.lastIndexOf(".");
  if (dot > 0) candidate = candidate.slice(0, dot);

  candidate = candidate.normalize("NFC");
  candidate = candidate.replace(INVALID_CHARS, "_");
  // The directory portion is already gone, so a dot run cannot traverse.
  candidate = candidate.replace(DOT_RUN, ".");
  candidate = candidate.replace(WHITESPACE_RUN, " ").replace(/^[\s.]+|[\s.]+$/g, "");

  if (candidate.length > MAX_STEM_LENGTH) {
    candidate = candidate.slice(0, MAX_STEM_LENGTH).replace(/[\s.]+$/, "");
  }

  if (WINDOWS_RESERVED.has(candidate.toUpperCase())) {
    candidate = `${candidate}_file`;
  }

  return candidate || "document";
}

/** A URL/Blob-safe segment. Non-ASCII is dropped rather than percent-encoded. */
function pathSafe(stem: string): string {
  const ascii = stem.replace(/[^\w\-. ]/g, "-").replace(/\s+/g, "-");
  const trimmed = ascii.replace(/-{2,}/g, "-").replace(/^[-.]+|[-.]+$/g, "");
  return trimmed.slice(0, 80) || "document";
}

function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

export interface JobPaths {
  jobId: string;
  sourcePathname: string;
  resultPathname: string;
  statusPathname: string;
  /** Display stem, may contain Unicode. Not used for paths. */
  displayStem: string;
  includeMedia: boolean;
}

/**
 * Build the §11 job-scoped Blob paths.
 *
 * ```
 * jobs/<yyyy-mm-dd>/<job-id>/source/<safe-filename>
 * jobs/<yyyy-mm-dd>/<job-id>/result/<safe-stem>_markdown.zip
 * ```
 */
export function buildJobPaths(
  originalFilename: string,
  includeMedia: boolean,
  jobId: string = crypto.randomUUID(),
): JobPaths {
  const extension = safeExtension(originalFilename);
  const displayStem = sanitizeFilenameStem(originalFilename);
  const stem = pathSafe(displayStem);
  const date = todayUtc();
  const prefix = `jobs/${date}/${jobId}`;

  // The extension IS the instruction. The converter reads the deliverable
  // shape from the signed result path rather than from the request body, so a
  // caller cannot ask for one shape and be handed another.
  const resultName = includeMedia
    ? `${stem}_markdown.zip`
    : `${stem}.md`;

  return {
    jobId,
    sourcePathname: `${prefix}/source/${stem}${extension}`,
    resultPathname: `${prefix}/result/${resultName}`,
    statusPathname: `${prefix}/status.json`,
    displayStem,
    includeMedia,
  };
}

/**
 * Confirm a pathname really belongs to the job it claims (§15 step 2).
 *
 * The client supplies both the job id and the pathname, so the relationship
 * between them has to be checked rather than assumed.
 */
export function pathBelongsToJob(pathname: string, jobId: string): boolean {
  if (pathname.includes("..") || pathname.startsWith("/")) return false;
  return new RegExp(`^jobs/\\d{4}-\\d{2}-\\d{2}/${escapeRegex(jobId)}/`).test(
    pathname,
  );
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export interface ClientValidationResult {
  ok: boolean;
  code?: "UNSUPPORTED_FILE_TYPE" | "FILE_TOO_LARGE" | "INVALID_FILE_FORMAT";
}

/**
 * §10 - client-side checks. UX only; the backend re-validates everything.
 */
export function validateSelection(
  filename: string,
  size: number,
): ClientValidationResult {
  if (!isSupportedExtension(safeExtension(filename))) {
    return { ok: false, code: "UNSUPPORTED_FILE_TYPE" };
  }
  if (size <= 0) return { ok: false, code: "INVALID_FILE_FORMAT" };
  if (size > MAX_UPLOAD_BYTES) return { ok: false, code: "FILE_TOO_LARGE" };
  return { ok: true };
}

/** Human-readable size, e.g. "42.8 MB", matching the §2 mockups. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(1)} ${units[unit]}`;
}

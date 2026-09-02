/**
 * Shared types for the Mark it Down web app.
 *
 * Error codes mirror ENGINEERING_SPEC.md §46 exactly. They are the contract
 * between the converter, the API routes and the UI, so they must stay in step
 * with `converter/app/errors.py`.
 */

export const ERROR_CODES = [
  "UNSUPPORTED_FILE_TYPE",
  "FILE_TOO_LARGE",
  "INVALID_FILE_FORMAT",
  "PASSWORD_PROTECTED",
  "OFFICE_ARCHIVE_UNSAFE",
  "DOCUMENT_TOO_COMPLEX",
  "DOCUMENT_EXPANDS_TOO_LARGE",
  "DOWNLOAD_FAILED",
  "CONVERSION_TIMEOUT",
  "CONVERSION_FAILED",
  "RESULT_TOO_LARGE",
  "RESULT_UPLOAD_FAILED",
  "JOB_TOKEN_INVALID",
  "JOB_TOKEN_EXPIRED",
  "BLOB_NOT_FOUND",
  "RATE_LIMITED",
  "SERVICE_UNAVAILABLE",
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export interface ApiError {
  code: ErrorCode;
  message: string;
}

/** §9 - the only accepted input types. */
export const SUPPORTED_EXTENSIONS = [".docx", ".pptx", ".pdf"] as const;
export type SupportedExtension = (typeof SUPPORTED_EXTENSIONS)[number];

export type SourceType = "docx" | "pptx" | "pdf";

export const MIME_BY_EXTENSION: Record<SupportedExtension, string> = {
  ".docx":
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".pptx":
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".pdf": "application/pdf",
};

export const HUMAN_TYPE_LABEL: Record<SourceType, string> = {
  docx: "Word document",
  pptx: "PowerPoint presentation",
  pdf: "PDF document",
};

/** §10 - `100 * 1024 * 1024`, stated exactly as the spec writes it. */
export const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;

/**
 * The UI state machine. §52 also listed `confirming`; that step was removed
 * on owner feedback (DEVIATIONS D-015) - selecting a file is the intent, and
 * the useful question is asked in place instead of behind a modal.
 */
export type UiState =
  | "idle"
  | "selected"
  | "uploading"
  | "converting"
  | "preparing-download"
  | "complete"
  | "error";

/** D-002 - stages published by the converter, mirrored from `status.py`. */
export type JobStage =
  | "accepted"
  | "downloading"
  | "validating"
  | "converting"
  | "packaging"
  | "uploading"
  | "complete"
  | "failed";

export interface JobStatus {
  job_id: string;
  stage: JobStage;
  progress: number;
  done: boolean;
  ok: boolean;
  code?: ErrorCode;
  result_bytes?: number;
  pages_or_slides?: number;
  media_count?: number;
  warnings?: string[];
}

export interface PrepareJobResponse {
  jobToken: string;
  sourceGetUrl: string;
  resultPutUrl: string;
  sourceDeleteUrl: string;
  statusPutUrl: string;
  statusGetUrl: string;
  resultPathname: string;
}

export interface ConvertResponse {
  status: "success";
  jobId: string;
  resultPathname: string;
  resultBytes: number;
  warnings: string[];
  pagesOrSlides: number | null;
  mediaCount: number;
  elapsedMs: number;
  aiTokensUsed: 0;
}

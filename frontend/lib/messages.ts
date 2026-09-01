/**
 * Reader-facing text for every §46 error code.
 *
 * Shared by the API routes and the browser, so a given code reads identically
 * wherever it surfaces. This module imports nothing from `next/server`, which
 * is what lets the client use it too.
 *
 * Wording rules (§45, §47): no technical vocabulary, no filenames, no paths,
 * no library names — and always a next action where one exists.
 */

import type { ErrorCode } from "./types";

export const ERROR_MESSAGES: Record<ErrorCode, string> = {
  UNSUPPORTED_FILE_TYPE:
    "This file type is not supported. Please upload a Word (.docx), PowerPoint (.pptx) or PDF (.pdf) file.",
  FILE_TOO_LARGE: "The maximum supported file size is 100 MB.",
  INVALID_FILE_FORMAT:
    "This file does not appear to be a valid Word, PowerPoint or PDF document. It may be damaged or renamed from another format.",
  PASSWORD_PROTECTED:
    "This document is password protected. Please remove the password and try again.",
  OFFICE_ARCHIVE_UNSAFE:
    "This document could not be processed safely and was rejected.",
  DOCUMENT_TOO_COMPLEX: "This document is too complex to convert reliably.",
  DOCUMENT_EXPANDS_TOO_LARGE:
    "This document expands beyond the safe processing limit during conversion.",
  DOWNLOAD_FAILED: "The uploaded file could not be retrieved. Please try again.",
  CONVERSION_TIMEOUT: "The conversion took too long to complete.",
  CONVERSION_FAILED: "The document could not be converted. Please try again.",
  RESULT_TOO_LARGE: "The converted result is too large to return safely.",
  RESULT_UPLOAD_FAILED:
    "The converted result could not be saved. Please try again.",
  JOB_TOKEN_INVALID: "This conversion request is not valid.",
  JOB_TOKEN_EXPIRED:
    "This conversion request has expired. Please upload the file again.",
  BLOB_NOT_FOUND: "The uploaded file could not be found. Please upload it again.",
  RATE_LIMITED:
    "Too many conversions requested. Please wait a few minutes and try again.",
  SERVICE_UNAVAILABLE:
    "The conversion service is temporarily unavailable. Please try again.",
};

/** HTTP status per code. 4xx where the caller can act, 5xx where they cannot. */
export const ERROR_STATUS: Record<ErrorCode, number> = {
  UNSUPPORTED_FILE_TYPE: 415,
  FILE_TOO_LARGE: 413,
  INVALID_FILE_FORMAT: 422,
  PASSWORD_PROTECTED: 422,
  OFFICE_ARCHIVE_UNSAFE: 422,
  DOCUMENT_TOO_COMPLEX: 422,
  DOCUMENT_EXPANDS_TOO_LARGE: 413,
  DOWNLOAD_FAILED: 502,
  CONVERSION_TIMEOUT: 504,
  CONVERSION_FAILED: 500,
  RESULT_TOO_LARGE: 413,
  RESULT_UPLOAD_FAILED: 502,
  JOB_TOKEN_INVALID: 401,
  JOB_TOKEN_EXPIRED: 401,
  BLOB_NOT_FOUND: 404,
  RATE_LIMITED: 429,
  SERVICE_UNAVAILABLE: 503,
};

export function messageForCode(code: ErrorCode): string {
  return ERROR_MESSAGES[code];
}

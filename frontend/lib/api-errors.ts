/**
 * Server-side error helpers (§45, §46, §47).
 *
 * Routes never return a stack trace or an internal message. They return a
 * stable code and reader-facing text, and log only the shape of the failure.
 */

import { NextResponse } from "next/server";

import type { ErrorCode } from "./types";

const MESSAGES: Record<ErrorCode, string> = {
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

const STATUS: Record<ErrorCode, number> = {
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

export function messageFor(code: ErrorCode): string {
  return MESSAGES[code];
}

/** Build the §46 error response. `internalDetail` is logged, never returned. */
export function errorResponse(
  code: ErrorCode,
  internalDetail?: string,
): NextResponse {
  if (internalDetail) {
    // Shape only. Never document content, filenames, URLs or tokens (§47).
    console.info(`request failed code=${code} detail=${internalDetail}`);
  }
  return NextResponse.json(
    { code, message: MESSAGES[code] },
    { status: STATUS[code] },
  );
}

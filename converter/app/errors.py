"""Stable error codes and the single exception type the API surfaces.

ENGINEERING_SPEC.md §46 fixes the error-code vocabulary; §45 forbids returning
stack traces to the browser. Every failure path therefore raises
`ConversionError`, which carries a code from `ErrorCode` and a message written
for a non-technical reader.

Internal detail (paths, subprocess output, library exceptions) goes in
`internal_detail`, which is logged but never serialised to the client.
"""

from __future__ import annotations

from enum import StrEnum


class ErrorCode(StrEnum):
    """The complete set of codes from ENGINEERING_SPEC.md §46."""

    UNSUPPORTED_FILE_TYPE = "UNSUPPORTED_FILE_TYPE"
    FILE_TOO_LARGE = "FILE_TOO_LARGE"
    INVALID_FILE_FORMAT = "INVALID_FILE_FORMAT"
    PASSWORD_PROTECTED = "PASSWORD_PROTECTED"
    OFFICE_ARCHIVE_UNSAFE = "OFFICE_ARCHIVE_UNSAFE"
    DOCUMENT_TOO_COMPLEX = "DOCUMENT_TOO_COMPLEX"
    DOCUMENT_EXPANDS_TOO_LARGE = "DOCUMENT_EXPANDS_TOO_LARGE"
    DOWNLOAD_FAILED = "DOWNLOAD_FAILED"
    CONVERSION_TIMEOUT = "CONVERSION_TIMEOUT"
    CONVERSION_FAILED = "CONVERSION_FAILED"
    RESULT_TOO_LARGE = "RESULT_TOO_LARGE"
    RESULT_UPLOAD_FAILED = "RESULT_UPLOAD_FAILED"
    JOB_TOKEN_INVALID = "JOB_TOKEN_INVALID"
    JOB_TOKEN_EXPIRED = "JOB_TOKEN_EXPIRED"
    BLOB_NOT_FOUND = "BLOB_NOT_FOUND"
    RATE_LIMITED = "RATE_LIMITED"
    SERVICE_UNAVAILABLE = "SERVICE_UNAVAILABLE"


# Reader-facing text. Deliberately free of technical vocabulary, filenames and
# numbers the user did not supply themselves.
_MESSAGES: dict[ErrorCode, str] = {
    ErrorCode.UNSUPPORTED_FILE_TYPE: (
        "This file type is not supported. Please upload a Word (.docx), "
        "PowerPoint (.pptx) or PDF (.pdf) file."
    ),
    ErrorCode.FILE_TOO_LARGE: "The maximum supported file size is 100 MB.",
    ErrorCode.INVALID_FILE_FORMAT: (
        "This file does not appear to be a valid Word, PowerPoint or PDF "
        "document. It may be damaged or renamed from another format."
    ),
    ErrorCode.PASSWORD_PROTECTED: (
        "This document is password protected. Please remove the password and "
        "try again."
    ),
    ErrorCode.OFFICE_ARCHIVE_UNSAFE: (
        "This document could not be processed safely and was rejected."
    ),
    ErrorCode.DOCUMENT_TOO_COMPLEX: (
        "This document is too complex to convert reliably."
    ),
    ErrorCode.DOCUMENT_EXPANDS_TOO_LARGE: (
        "This document expands beyond the safe processing limit during "
        "conversion."
    ),
    ErrorCode.DOWNLOAD_FAILED: (
        "The uploaded file could not be retrieved. Please try again."
    ),
    ErrorCode.CONVERSION_TIMEOUT: "The conversion took too long to complete.",
    ErrorCode.CONVERSION_FAILED: (
        "The document could not be converted. Please try again."
    ),
    ErrorCode.RESULT_TOO_LARGE: (
        "The converted result is too large to return safely."
    ),
    ErrorCode.RESULT_UPLOAD_FAILED: (
        "The converted result could not be saved. Please try again."
    ),
    ErrorCode.JOB_TOKEN_INVALID: "This conversion request is not valid.",
    ErrorCode.JOB_TOKEN_EXPIRED: (
        "This conversion request has expired. Please upload the file again."
    ),
    ErrorCode.BLOB_NOT_FOUND: (
        "The uploaded file could not be found. Please upload it again."
    ),
    ErrorCode.RATE_LIMITED: (
        "Too many conversions requested. Please wait a few minutes and try "
        "again."
    ),
    ErrorCode.SERVICE_UNAVAILABLE: (
        "The conversion service is temporarily unavailable. Please try again."
    ),
}

# HTTP status per code. 4xx where the caller can act, 5xx where they cannot.
_STATUS: dict[ErrorCode, int] = {
    ErrorCode.UNSUPPORTED_FILE_TYPE: 415,
    ErrorCode.FILE_TOO_LARGE: 413,
    ErrorCode.INVALID_FILE_FORMAT: 422,
    ErrorCode.PASSWORD_PROTECTED: 422,
    ErrorCode.OFFICE_ARCHIVE_UNSAFE: 422,
    ErrorCode.DOCUMENT_TOO_COMPLEX: 422,
    ErrorCode.DOCUMENT_EXPANDS_TOO_LARGE: 413,
    ErrorCode.DOWNLOAD_FAILED: 502,
    ErrorCode.CONVERSION_TIMEOUT: 504,
    ErrorCode.CONVERSION_FAILED: 500,
    ErrorCode.RESULT_TOO_LARGE: 413,
    ErrorCode.RESULT_UPLOAD_FAILED: 502,
    ErrorCode.JOB_TOKEN_INVALID: 401,
    ErrorCode.JOB_TOKEN_EXPIRED: 401,
    ErrorCode.BLOB_NOT_FOUND: 404,
    ErrorCode.RATE_LIMITED: 429,
    ErrorCode.SERVICE_UNAVAILABLE: 503,
}


class ConversionError(Exception):
    """A failure with a stable, client-safe error code.

    `internal_detail` is for logs only. It must never reach the browser, so
    `to_payload()` deliberately omits it.
    """

    def __init__(
        self,
        code: ErrorCode,
        *,
        internal_detail: str | None = None,
        message: str | None = None,
    ) -> None:
        self.code = code
        self.message = message or _MESSAGES[code]
        self.internal_detail = internal_detail
        super().__init__(f"{code}: {self.message}")

    @property
    def http_status(self) -> int:
        return _STATUS[self.code]

    def to_payload(self) -> dict[str, str]:
        """The exact JSON body returned to the client."""
        return {"code": str(self.code), "message": self.message}


def message_for(code: ErrorCode) -> str:
    """Reader-facing message for a code, for use outside exception handling."""
    return _MESSAGES[code]

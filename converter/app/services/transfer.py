"""Streaming source download and result upload (ENGINEERING_SPEC.md §24, §25).

Neither direction may hold a whole document in memory. The source is streamed
to disk in chunks with a running byte count that aborts the moment the declared
ceiling is passed, and the result ZIP is streamed from disk to the presigned
PUT URL rather than read into a buffer.

The abort matters: a Content-Length header is a claim by the server, not a
guarantee, so the limit is enforced against bytes actually received.
"""

from __future__ import annotations

import logging
from pathlib import Path

import httpx

from app.config import settings
from app.errors import ConversionError, ErrorCode

logger = logging.getLogger(__name__)

CHUNK_BYTES = 1024 * 1024

# Presigned URLs are already short-lived; these bound a stalled transfer.
CONNECT_TIMEOUT_SECONDS = 15.0
READ_TIMEOUT_SECONDS = 120.0


def _timeout() -> httpx.Timeout:
    return httpx.Timeout(
        connect=CONNECT_TIMEOUT_SECONDS,
        read=READ_TIMEOUT_SECONDS,
        write=READ_TIMEOUT_SECONDS,
        pool=CONNECT_TIMEOUT_SECONDS,
    )


def download_source(
    signed_get_url: str,
    destination: Path,
    *,
    max_bytes: int | None = None,
    client: httpx.Client | None = None,
) -> int:
    """Stream a presigned GET to `destination`, returning bytes written.

    Raises FILE_TOO_LARGE as soon as the running total exceeds the ceiling,
    without waiting for the transfer to finish.
    """
    ceiling = max_bytes if max_bytes is not None else settings.max_upload_bytes
    destination.parent.mkdir(parents=True, exist_ok=True)

    owns_client = client is None
    http = client or httpx.Client(timeout=_timeout(), follow_redirects=True)

    written = 0
    try:
        with http.stream("GET", signed_get_url) as response:
            if response.status_code == 404:
                raise ConversionError(
                    ErrorCode.BLOB_NOT_FOUND,
                    internal_detail="source blob returned 404",
                )
            if response.status_code >= 400:
                raise ConversionError(
                    ErrorCode.DOWNLOAD_FAILED,
                    internal_detail=f"source GET status {response.status_code}",
                )

            # Cheap pre-check when the server declares a size, but never the
            # only check - the body is what actually counts.
            declared = response.headers.get("content-length")
            if declared is not None and declared.isdigit() and int(declared) > ceiling:
                raise ConversionError(
                    ErrorCode.FILE_TOO_LARGE,
                    internal_detail=f"declared content-length {declared}",
                )

            with destination.open("wb") as handle:
                for chunk in response.iter_bytes(CHUNK_BYTES):
                    written += len(chunk)
                    if written > ceiling:
                        raise ConversionError(
                            ErrorCode.FILE_TOO_LARGE,
                            internal_detail=f"source exceeded ceiling at {written}",
                        )
                    handle.write(chunk)
    except ConversionError:
        destination.unlink(missing_ok=True)
        raise
    except httpx.HTTPError as exc:
        destination.unlink(missing_ok=True)
        raise ConversionError(
            ErrorCode.DOWNLOAD_FAILED,
            internal_detail=f"source download failed: {type(exc).__name__}",
        ) from exc
    finally:
        if owns_client:
            http.close()

    if written == 0:
        destination.unlink(missing_ok=True)
        raise ConversionError(
            ErrorCode.DOWNLOAD_FAILED, internal_detail="source was empty"
        )

    logger.info("source downloaded: %d bytes", written)
    return written


def upload_result(
    signed_put_url: str,
    source: Path,
    *,
    content_type: str = "application/zip",
    client: httpx.Client | None = None,
) -> int:
    """Stream `source` to a presigned PUT URL, returning bytes sent.

    The file handle is passed to httpx as the request body so the ZIP is read
    incrementally rather than loaded into memory (§25). Presigned Blob URLs
    carry their own authorisation, so no Authorization header is sent.
    """
    if not source.is_file():
        raise ConversionError(
            ErrorCode.RESULT_UPLOAD_FAILED,
            internal_detail="result file missing before upload",
        )

    size = source.stat().st_size
    owns_client = client is None
    http = client or httpx.Client(timeout=_timeout(), follow_redirects=True)

    try:
        with source.open("rb") as handle:
            response = http.put(
                signed_put_url,
                content=handle,
                headers={
                    "content-type": content_type,
                    "content-length": str(size),
                },
            )
    except httpx.HTTPError as exc:
        raise ConversionError(
            ErrorCode.RESULT_UPLOAD_FAILED,
            internal_detail=f"result upload failed: {type(exc).__name__}",
        ) from exc
    finally:
        if owns_client:
            http.close()

    if response.status_code >= 400:
        raise ConversionError(
            ErrorCode.RESULT_UPLOAD_FAILED,
            internal_detail=f"result PUT status {response.status_code}",
        )

    logger.info("result uploaded: %d bytes", size)
    return size


def delete_blob(signed_delete_url: str, *, client: httpx.Client | None = None) -> bool:
    """Best-effort delete of the source blob (§40).

    Never raises: a failed delete must not fail an otherwise successful job,
    because the hourly cleanup cron (§41) is the backstop for exactly this.
    """
    owns_client = client is None
    http = client or httpx.Client(timeout=_timeout(), follow_redirects=True)
    try:
        response = http.request("DELETE", signed_delete_url)
    except httpx.HTTPError as exc:
        logger.info("source delete failed: %s", type(exc).__name__)
        return False
    finally:
        if owns_client:
            http.close()

    if response.status_code >= 400:
        logger.info("source delete status %s", response.status_code)
        return False
    return True

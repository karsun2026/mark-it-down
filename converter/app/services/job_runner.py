"""The full remote job: Blob in, convert, Blob out (§66 steps 8-19).

This is the network-facing wrapper around `pipeline.run_conversion`. The order
below is the spec's, with the D-002 status publishes interleaved:

    verify token -> bind URLs to signed paths -> stream source down
    -> convert (validate, quota, delete source, package)
    -> stream result up -> delete source blob -> report

The concurrency semaphore is acquired around the whole job, not just the
conversion, because the workspace budget covers the downloaded source too.
"""

from __future__ import annotations

import logging
import threading
import time

from app.config import settings
from app.errors import ConversionError, ErrorCode
from app.models import ConvertRequest, ConvertResponse
from app.security.job_token import (
    JobClaims,
    assert_url_matches_path,
    verify_job_token,
)
from app.security.validation import sanitize_filename_stem, source_type_for_filename
from app.services.pipeline import run_conversion
from app.services.status import Stage, StatusPublisher
from app.services.transfer import delete_blob, download_source, upload_result
from app.services.workspace import JobWorkspace

logger = logging.getLogger(__name__)

# §27 - a process-level cap. D-001 defaults it to 1.
_semaphore = threading.BoundedSemaphore(
    max(1, settings.max_local_concurrent_conversions)
)

# How long to wait for a slot before shedding load. Waiting out the whole
# conversion deadline would just guarantee a timeout instead of a clean 503.
SLOT_WAIT_SECONDS = 30


def run_job(request: ConvertRequest) -> ConvertResponse:
    """Execute one conversion job end to end."""
    # 1. Verify the token before touching the network at all.
    claims = verify_job_token(request.jobToken)

    # 2. Bind every presigned URL to the pathname the token was signed for.
    #    Without this the token proves a job exists, not that these URLs are
    #    the ones that job is allowed to use.
    assert_url_matches_path(
        request.sourceGetUrl, claims.source_path, label="source"
    )
    assert_url_matches_path(
        request.resultPutUrl, claims.result_path, label="result"
    )
    if request.sourceDeleteUrl:
        assert_url_matches_path(
            request.sourceDeleteUrl, claims.source_path, label="source delete"
        )

    # 3. Reject unsupported types before doing any work.
    source_type = source_type_for_filename(claims.filename)

    if claims.source_size > settings.max_upload_bytes:
        raise ConversionError(
            ErrorCode.FILE_TOO_LARGE,
            internal_detail=f"claimed source_size {claims.source_size}",
        )

    status = StatusPublisher(claims.job_id, request.statusPutUrl)

    if not _semaphore.acquire(timeout=SLOT_WAIT_SECONDS):
        raise ConversionError(
            ErrorCode.SERVICE_UNAVAILABLE,
            internal_detail="no conversion slot available",
        )
    try:
        return _run_guarded(request, claims, source_type, status)
    except ConversionError as exc:
        status.publish(Stage.FAILED, error_code=exc.code)
        raise
    except Exception:
        status.publish(Stage.FAILED, error_code=ErrorCode.CONVERSION_FAILED)
        raise
    finally:
        _semaphore.release()


def _run_guarded(
    request: ConvertRequest,
    claims: JobClaims,
    source_type,
    status: StatusPublisher,
) -> ConvertResponse:
    started = time.perf_counter()
    output_stem = sanitize_filename_stem(claims.filename)

    # The deliverable shape is read from the SIGNED result path, not from the
    # request body, so a caller cannot ask for one shape and be given another.
    include_media = not claims.result_path.lower().endswith(".md")

    with JobWorkspace(claims.job_id) as workspace:
        status.publish(Stage.DOWNLOADING)

        source_path = workspace.source_path(f".{source_type}")
        download_source(request.sourceGetUrl, source_path)

        status.publish(Stage.CONVERTING)
        outcome = run_conversion(
            workspace=workspace,
            source_path=source_path,
            source_type=source_type,
            output_stem=output_stem,
            original_filename=claims.filename,
            include_media=include_media,
        )

        status.publish(Stage.UPLOADING)
        upload_result(
            request.resultPutUrl,
            outcome.result_path,
            content_type=outcome.result_content_type,
        )

        # 4. Source goes as soon as the result is safely stored (§40).
        if request.sourceDeleteUrl:
            delete_blob(request.sourceDeleteUrl)

        elapsed_ms = int((time.perf_counter() - started) * 1000)

        status.publish(
            Stage.COMPLETE,
            result_bytes=outcome.result_bytes,
            pages_or_slides=outcome.pages_or_slides,
            media_count=outcome.media_count,
            warnings=outcome.warnings,
        )

        logger.info(
            "job complete job_id=%s type=%s result_bytes=%d elapsed_ms=%d",
            claims.job_id,
            source_type,
            outcome.result_bytes,
            elapsed_ms,
        )

        return ConvertResponse(
            jobId=claims.job_id,
            resultPathname=claims.result_path,
            resultBytes=outcome.result_bytes,
            warnings=outcome.warnings,
            pagesOrSlides=outcome.pages_or_slides,
            mediaCount=outcome.media_count,
            elapsedMs=elapsed_ms,
        )

"""FastAPI surface for the converter service (ENGINEERING_SPEC.md §28).

Endpoints:

    GET  /converter/health   liveness
    GET  /converter/ready    readiness - Pandoc, python-pptx, pypdf, /tmp
    POST /converter/v1/convert   (Phase 2 - needs the Blob data path)

§28 forbids revealing filesystem paths or secrets in these responses, and §45
forbids returning stack traces, so every handler funnels failures through
`ConversionError`.
"""

from __future__ import annotations

import logging
import os
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from starlette.concurrency import run_in_threadpool

from app.config import settings
from app.errors import ConversionError, ErrorCode
from app.models import ConvertRequest, ConvertResponse
from app.services.job_runner import run_job
from app.services.workspace import log_startup_capacity, probe_disk

logger = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(_app: FastAPI) -> AsyncIterator[None]:
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
    )
    # D-001: measure the disk rather than trusting the spec's ~500MB assumption.
    log_startup_capacity()
    yield


app = FastAPI(
    title="Mark-it-Down converter",
    version="0.1.0",
    docs_url=None,  # no interactive docs on an internal service
    redoc_url=None,
    openapi_url=None,
    lifespan=lifespan,
)


# The converter is called cross-origin by the market intelligence suite, so the
# browser sends a preflight before the convert POST. Origins are ALLOW-LISTED
# from the environment rather than opened to "*": this endpoint spends real
# compute, and although every request must still carry a valid HMAC job token,
# there is no reason to let an arbitrary page attempt one.
#
# CORS_ALLOWED_ORIGINS is a comma-separated list of absolute origins.
_allowed_origins = [
    origin.strip()
    for origin in (os.environ.get("CORS_ALLOWED_ORIGINS") or "").split(",")
    if origin.strip()
]
# Preview deployments get a generated hostname, so an exact list cannot cover
# them. CORS_ALLOWED_ORIGIN_REGEX takes a BOUNDED pattern (one project's
# preview hosts), never a blanket wildcard.
_allowed_origin_regex = (os.environ.get("CORS_ALLOWED_ORIGIN_REGEX") or "").strip()

if _allowed_origins or _allowed_origin_regex:
    app.add_middleware(
        CORSMiddleware,
        allow_origins=_allowed_origins,
        allow_origin_regex=_allowed_origin_regex or None,
        allow_methods=["POST", "OPTIONS"],
        allow_headers=["content-type"],
        # No cookies are involved: authorisation is the job token in the body.
        allow_credentials=False,
        max_age=3600,
    )
    logger.info(
        "CORS enabled: %d exact origin(s), regex=%s",
        len(_allowed_origins),
        bool(_allowed_origin_regex),
    )


@app.exception_handler(ConversionError)
async def conversion_error_handler(
    _request: Request, exc: ConversionError
) -> JSONResponse:
    # internal_detail is logged, never serialised (§45, §47).
    logger.info("request failed code=%s detail=%s", exc.code, exc.internal_detail)
    return JSONResponse(status_code=exc.http_status, content=exc.to_payload())


@app.exception_handler(Exception)
async def unhandled_error_handler(_request: Request, exc: Exception) -> JSONResponse:
    # Log the type only. The message may quote document content.
    logger.error("unhandled error: %s", type(exc).__name__)
    fallback = ConversionError(ErrorCode.CONVERSION_FAILED)
    return JSONResponse(
        status_code=fallback.http_status, content=fallback.to_payload()
    )


@app.get("/converter/health")
async def health() -> dict[str, str]:
    return {"status": "ok"}


@app.post("/converter/v1/convert", response_model=ConvertResponse)
async def convert(request: ConvertRequest) -> ConvertResponse:
    """Convert one document (§17, §18).

    The body carries only a job token and presigned URLs; the document itself
    never passes through this endpoint, and neither does the result.

    The work is blocking and CPU/disk bound, so it runs on a worker thread
    rather than occupying the event loop for up to 690 seconds.
    """
    return await run_in_threadpool(run_job, request)


@app.get("/converter/ready")
async def ready() -> JSONResponse:
    """Readiness per §28, without exposing paths or versions of anything secret."""
    from app.converters.docx import pandoc_available

    checks: dict[str, bool] = {
        "pandoc": pandoc_available(),
        "python_pptx": _importable("pptx"),
        "pypdf": _importable("pypdf"),
        "pdfplumber": _importable("pdfplumber"),
        "tmp_writable": _tmp_writable(),
    }

    ready_now = all(checks.values())
    probe = probe_disk()
    body = {
        "status": "ready" if ready_now else "not_ready",
        "checks": checks,
        # Capacity numbers only - never the path itself.
        "workspace_free_mb": probe.free_mb,
        "workspace_budget_mb": settings.max_workspace_bytes // (1024 * 1024),
        "max_concurrent_conversions": settings.max_local_concurrent_conversions,
    }
    return JSONResponse(status_code=200 if ready_now else 503, content=body)


def _importable(module_name: str) -> bool:
    import importlib.util

    try:
        return importlib.util.find_spec(module_name) is not None
    except (ImportError, ValueError):
        return False


def _tmp_writable() -> bool:
    try:
        settings.workspace_root.mkdir(parents=True, exist_ok=True)
        probe_file = settings.workspace_root / ".write-probe"
        probe_file.write_bytes(b"ok")
        probe_file.unlink()
    except OSError:
        return False
    return True

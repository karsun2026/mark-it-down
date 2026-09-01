"""Job status published to Blob (DEVIATIONS.md D-002).

ENGINEERING_SPEC.md §17 has the browser hold one HTTP request open for the
whole conversion, which §26 allows to run for up to 690 seconds. Mobile
handoffs, corporate proxies and background-tab throttling all break a
connection that long, and the spec defines no idempotency key, so a retry
re-runs the entire conversion.

The converter therefore publishes a small JSON object to Blob as it passes each
stage. The browser still issues the same POST, but a dropped connection
degrades to polling this object instead of failing the job.

Two constraints this must respect:

  * §39/§47 - the status object is readable by the client, so it carries no
    document content, no paths, no URLs and no tokens. Only a stage name,
    counters and a stable error code.
  * Presigned GETs are served through Vercel's CDN cache, where an overwritten
    blob can serve a stale body for up to 60 seconds. A status URL MUST be
    presigned with `useCache: false`, or polling reads stale stages. The
    frontend owns that; this module documents the requirement so it cannot be
    lost.

Publishing is always best-effort: a status write failing must never fail a
conversion that is otherwise succeeding.
"""

from __future__ import annotations

import json
import logging
from enum import StrEnum

import httpx

from app.errors import ErrorCode

logger = logging.getLogger(__name__)

STATUS_CONTENT_TYPE = "application/json"
STATUS_TIMEOUT_SECONDS = 10.0


class Stage(StrEnum):
    """Coarse progress stages, ordered as the pipeline runs them."""

    ACCEPTED = "accepted"
    DOWNLOADING = "downloading"
    VALIDATING = "validating"
    CONVERTING = "converting"
    PACKAGING = "packaging"
    UPLOADING = "uploading"
    COMPLETE = "complete"
    FAILED = "failed"


# Rough share of total work completed at the START of each stage, so the client
# can show honest coarse progress. §52 forbids inventing fake percentages, so
# these are stage markers, not a simulated ramp.
_STAGE_PROGRESS: dict[Stage, int] = {
    Stage.ACCEPTED: 0,
    Stage.DOWNLOADING: 5,
    Stage.VALIDATING: 25,
    Stage.CONVERTING: 35,
    Stage.PACKAGING: 80,
    Stage.UPLOADING: 90,
    Stage.COMPLETE: 100,
    Stage.FAILED: 100,
}


def build_status(
    *,
    job_id: str,
    stage: Stage,
    error_code: ErrorCode | None = None,
    result_bytes: int | None = None,
    pages_or_slides: int | None = None,
    media_count: int | None = None,
    warnings: list[str] | None = None,
) -> dict[str, object]:
    """Assemble the status payload.

    Deliberately narrow: everything here is safe for the browser to read.
    """
    payload: dict[str, object] = {
        "job_id": job_id,
        "stage": str(stage),
        "progress": _STAGE_PROGRESS[stage],
        "done": stage in (Stage.COMPLETE, Stage.FAILED),
        "ok": stage is not Stage.FAILED,
    }
    if error_code is not None:
        payload["code"] = str(error_code)
    if result_bytes is not None:
        payload["result_bytes"] = result_bytes
    if pages_or_slides is not None:
        payload["pages_or_slides"] = pages_or_slides
    if media_count is not None:
        payload["media_count"] = media_count
    if warnings is not None:
        payload["warnings"] = list(warnings)
    return payload


class StatusPublisher:
    """Writes status to a presigned PUT URL, or does nothing without one.

    The URL must be presigned for the job's status pathname with
    `allowOverwrite: true` and `addRandomSuffix: false`, since the same
    pathname is rewritten at every stage.
    """

    def __init__(
        self,
        job_id: str,
        signed_put_url: str | None,
        *,
        client: httpx.Client | None = None,
    ) -> None:
        self.job_id = job_id
        self._url = signed_put_url
        self._client = client
        self._last_stage: Stage | None = None

    @property
    def enabled(self) -> bool:
        return bool(self._url)

    @property
    def last_stage(self) -> Stage | None:
        return self._last_stage

    def publish(self, stage: Stage, **fields: object) -> bool:
        """Publish one stage. Returns True when the write succeeded.

        Never raises. A conversion that succeeds but cannot publish its status
        is still a successful conversion; the client falls back to the open
        HTTP response.
        """
        self._last_stage = stage
        if not self._url:
            return False

        payload = build_status(job_id=self.job_id, stage=stage, **fields)  # type: ignore[arg-type]
        body = json.dumps(payload, separators=(",", ":")).encode("utf-8")

        owns_client = self._client is None
        http = self._client or httpx.Client(timeout=STATUS_TIMEOUT_SECONDS)
        try:
            response = http.put(
                self._url,
                content=body,
                headers={
                    "content-type": STATUS_CONTENT_TYPE,
                    "content-length": str(len(body)),
                },
            )
        except httpx.HTTPError as exc:
            logger.info(
                "status publish failed stage=%s error=%s", stage, type(exc).__name__
            )
            return False
        finally:
            if owns_client:
                http.close()

        if response.status_code >= 400:
            logger.info(
                "status publish rejected stage=%s status=%s",
                stage,
                response.status_code,
            )
            return False
        return True

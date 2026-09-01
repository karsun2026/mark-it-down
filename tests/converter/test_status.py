"""Status publishing tests (DEVIATIONS.md D-002; §39, §47, §52)."""

from __future__ import annotations

import json

import httpx
import pytest

from app.errors import ErrorCode
from app.services.status import Stage, StatusPublisher, build_status

URL = "https://store.private.blob.vercel-storage.com/jobs/a/status.json"


def client_returning(handler) -> httpx.Client:
    return httpx.Client(transport=httpx.MockTransport(handler))


class TestPayload:
    def test_minimal_payload_shape(self) -> None:
        payload = build_status(job_id="abc", stage=Stage.CONVERTING)
        assert payload["job_id"] == "abc"
        assert payload["stage"] == "converting"
        assert payload["done"] is False
        assert payload["ok"] is True

    def test_complete_is_done_and_ok(self) -> None:
        payload = build_status(job_id="abc", stage=Stage.COMPLETE)
        assert payload["done"] is True
        assert payload["ok"] is True
        assert payload["progress"] == 100

    def test_failed_is_done_and_not_ok(self) -> None:
        payload = build_status(
            job_id="abc", stage=Stage.FAILED, error_code=ErrorCode.CONVERSION_TIMEOUT
        )
        assert payload["done"] is True
        assert payload["ok"] is False
        assert payload["code"] == "CONVERSION_TIMEOUT"

    def test_progress_is_monotonic_through_the_pipeline(self) -> None:
        """§52 forbids invented percentages; these are ordered stage markers."""
        order = [
            Stage.ACCEPTED,
            Stage.DOWNLOADING,
            Stage.VALIDATING,
            Stage.CONVERTING,
            Stage.PACKAGING,
            Stage.UPLOADING,
            Stage.COMPLETE,
        ]
        values = [build_status(job_id="a", stage=s)["progress"] for s in order]
        assert values == sorted(values)
        assert values[0] == 0
        assert values[-1] == 100

    def test_carries_no_paths_urls_or_tokens(self) -> None:
        """§39/§47 - the client reads this, so it must stay clean."""
        payload = build_status(
            job_id="abc",
            stage=Stage.COMPLETE,
            result_bytes=123,
            media_count=4,
            pages_or_slides=9,
            warnings=["Page 4 may be scanned or image-based."],
        )
        raw = json.dumps(payload)
        assert "/tmp" not in raw
        assert "C:\\" not in raw
        assert "http" not in raw
        assert "Bearer" not in raw

    def test_optional_fields_omitted_when_absent(self) -> None:
        payload = build_status(job_id="abc", stage=Stage.DOWNLOADING)
        for absent in ("code", "result_bytes", "media_count", "pages_or_slides"):
            assert absent not in payload


class TestPublisher:
    def test_publishes_json_body_via_put(self) -> None:
        captured: dict[str, object] = {}

        def capture(request: httpx.Request) -> httpx.Response:
            captured["method"] = request.method
            captured["type"] = request.headers.get("content-type")
            captured["body"] = json.loads(request.content)
            return httpx.Response(200)

        publisher = StatusPublisher("abc", URL, client=client_returning(capture))
        assert publisher.publish(Stage.CONVERTING) is True
        assert captured["method"] == "PUT"
        assert captured["type"] == "application/json"
        assert captured["body"]["stage"] == "converting"

    def test_disabled_without_url(self) -> None:
        publisher = StatusPublisher("abc", None)
        assert publisher.enabled is False
        assert publisher.publish(Stage.CONVERTING) is False
        # Stage is still tracked so callers can reason about progress.
        assert publisher.last_stage is Stage.CONVERTING

    @pytest.mark.parametrize("status", [400, 403, 500])
    def test_rejected_write_returns_false_without_raising(self, status) -> None:
        publisher = StatusPublisher(
            "abc", URL, client=client_returning(lambda r: httpx.Response(status))
        )
        assert publisher.publish(Stage.CONVERTING) is False

    def test_network_error_never_raises(self) -> None:
        """A status write must never be able to fail a good conversion."""

        def boom(request: httpx.Request) -> httpx.Response:
            raise httpx.ConnectError("down", request=request)

        publisher = StatusPublisher("abc", URL, client=client_returning(boom))
        assert publisher.publish(Stage.COMPLETE) is False

    def test_same_pathname_rewritten_each_stage(self) -> None:
        """Overwrite-in-place is why the URL needs allowOverwrite: true."""
        seen: list[str] = []

        def capture(request: httpx.Request) -> httpx.Response:
            seen.append(str(request.url))
            return httpx.Response(200)

        publisher = StatusPublisher("abc", URL, client=client_returning(capture))
        for stage in (Stage.DOWNLOADING, Stage.CONVERTING, Stage.COMPLETE):
            publisher.publish(stage)

        assert len(seen) == 3
        assert len(set(seen)) == 1

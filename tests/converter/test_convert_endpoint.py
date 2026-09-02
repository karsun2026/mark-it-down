"""Convert endpoint tests (ENGINEERING_SPEC.md §17, §18, §45, §66).

Drives a real job end to end — token, download, convert, package, upload — with
Blob served by httpx.MockTransport. Nothing here touches the network.
"""

from __future__ import annotations

import time

import httpx
import pytest
from fastapi.testclient import TestClient

from app.api import app
from app.errors import ErrorCode
from app.security.job_token import MIN_SECRET_BYTES, JobClaims, mint_job_token

SECRET = "s" * MIN_SECRET_BYTES
STORE = "https://store.private.blob.vercel-storage.com"
JOB_ID = "6f3b9d"
SOURCE_PATH = f"jobs/2026-09-01/{JOB_ID}/source/deck.pptx"
RESULT_PATH = f"jobs/2026-09-01/{JOB_ID}/result/deck_markdown.zip"
STATUS_PATH = f"jobs/2026-09-01/{JOB_ID}/status.json"


@pytest.fixture(autouse=True)
def signing_secret_env(monkeypatch):
    monkeypatch.setenv("JOB_SIGNING_SECRET", SECRET)


@pytest.fixture(autouse=True)
def isolated_workspace(tmp_path, monkeypatch):
    import dataclasses

    from app import config as config_module
    from app.services import workspace as workspace_module

    rooted = dataclasses.replace(config_module.settings, workspace_root=tmp_path)
    monkeypatch.setattr(config_module, "settings", rooted)
    monkeypatch.setattr(workspace_module, "settings", rooted)


@pytest.fixture
def blob(fixture_path, monkeypatch):
    """A fake Blob store recording what the converter did to it."""
    source_bytes = fixture_path("text-only.pptx").read_bytes()
    state: dict[str, object] = {
        "uploaded": None,
        "statuses": [],
        "deleted": False,
        "source_bytes": source_bytes,
        "put_status": 200,
    }

    def handler(request: httpx.Request) -> httpx.Response:
        path = request.url.path.lstrip("/")
        if request.method == "GET" and path == SOURCE_PATH:
            body = state["source_bytes"]
            return httpx.Response(
                200, content=body, headers={"content-length": str(len(body))}
            )
        if request.method == "PUT" and path == RESULT_PATH:
            state["uploaded"] = request.content
            return httpx.Response(state["put_status"])
        if request.method == "PUT" and path == STATUS_PATH:
            import json

            state["statuses"].append(json.loads(request.content))
            return httpx.Response(200)
        if request.method == "DELETE" and path == SOURCE_PATH:
            state["deleted"] = True
            return httpx.Response(204)
        return httpx.Response(404)

    # Capture the real class BEFORE patching: calling httpx.Client inside the
    # replacement would re-enter the patch and recurse forever.
    real_client_cls = httpx.Client

    def fake_client(*args, **kwargs):
        return real_client_cls(transport=httpx.MockTransport(handler))

    # Both modules construct their own clients when none is injected.
    from app.services import status as status_module
    from app.services import transfer as transfer_module

    monkeypatch.setattr(transfer_module.httpx, "Client", fake_client)
    monkeypatch.setattr(status_module.httpx, "Client", fake_client)
    return state


def make_token(**overrides) -> str:
    defaults = {
        "job_id": JOB_ID,
        "source_path": SOURCE_PATH,
        "result_path": RESULT_PATH,
        "filename": "deck.pptx",
        "source_size": 4096,
        "exp": int(time.time()) + 600,
    }
    defaults.update(overrides)
    return mint_job_token(JobClaims(**defaults), SECRET.encode())


def make_body(**overrides) -> dict[str, object]:
    body: dict[str, object] = {
        "jobToken": make_token(),
        "sourceGetUrl": f"{STORE}/{SOURCE_PATH}?sig=a",
        "resultPutUrl": f"{STORE}/{RESULT_PATH}?sig=b",
        "sourceDeleteUrl": f"{STORE}/{SOURCE_PATH}?sig=c",
        "statusPutUrl": f"{STORE}/{STATUS_PATH}?sig=d",
    }
    body.update(overrides)
    return body


@pytest.fixture
def client() -> TestClient:
    return TestClient(app)


class TestSuccessfulJob:
    def test_returns_small_success_body(self, client, blob) -> None:
        response = client.post("/converter/v1/convert", json=make_body())
        assert response.status_code == 200
        body = response.json()

        assert body["status"] == "success"
        assert body["jobId"] == JOB_ID
        assert body["resultPathname"] == RESULT_PATH
        assert body["resultBytes"] > 0
        assert body["aiTokensUsed"] == 0

    def test_response_never_contains_zip_bytes(self, client, blob) -> None:
        """§18 - the result must not travel through the Function body."""
        response = client.post("/converter/v1/convert", json=make_body())
        # A small JSON control message, not a document.
        assert len(response.content) < 4096
        assert b"PK\x03\x04" not in response.content

    def test_result_uploaded_to_blob(self, client, blob) -> None:
        """The fixture has no images, so the deliverable is a bare .md."""
        client.post("/converter/v1/convert", json=make_body())
        uploaded = blob["uploaded"]
        assert uploaded is not None
        text = uploaded.decode("utf-8")
        assert text.startswith("## Slide 1")
        # D-014: no conversion report anywhere in the deliverable.
        assert "conversion-report" not in text
        # A bare .md, not an archive.
        assert not uploaded.startswith(b"PK")

    def test_source_blob_deleted_after_success(self, client, blob) -> None:
        client.post("/converter/v1/convert", json=make_body())
        assert blob["deleted"] is True

    def test_publishes_ordered_status_stages(self, client, blob) -> None:
        """D-002 - a dropped connection can be recovered by polling these."""
        client.post("/converter/v1/convert", json=make_body())
        stages = [s["stage"] for s in blob["statuses"]]

        assert stages[0] == "downloading"
        assert "converting" in stages
        assert stages[-1] == "complete"
        assert blob["statuses"][-1]["done"] is True
        assert blob["statuses"][-1]["ok"] is True

    def test_works_without_status_url(self, client, blob) -> None:
        response = client.post(
            "/converter/v1/convert", json=make_body(statusPutUrl=None)
        )
        assert response.status_code == 200
        assert blob["statuses"] == []


class TestTokenEnforcement:
    def test_missing_token_rejected(self, client, blob) -> None:
        body = make_body()
        del body["jobToken"]
        assert client.post("/converter/v1/convert", json=body).status_code == 422

    def test_bad_signature_rejected(self, client, blob) -> None:
        token = make_token()
        payload, _ = token.split(".")
        response = client.post(
            "/converter/v1/convert", json=make_body(jobToken=f"{payload}.AAAA")
        )
        assert response.status_code == 401
        assert response.json()["code"] == ErrorCode.JOB_TOKEN_INVALID

    def test_expired_token_rejected(self, client, blob) -> None:
        response = client.post(
            "/converter/v1/convert",
            json=make_body(jobToken=make_token(exp=int(time.time()) - 3600)),
        )
        assert response.status_code == 401
        assert response.json()["code"] == ErrorCode.JOB_TOKEN_EXPIRED

    def test_result_url_must_match_signed_path(self, client, blob) -> None:
        """A valid token must not authorise writing somewhere else."""
        response = client.post(
            "/converter/v1/convert",
            json=make_body(resultPutUrl=f"{STORE}/jobs/other/result/evil.zip"),
        )
        assert response.status_code == 401
        assert response.json()["code"] == ErrorCode.JOB_TOKEN_INVALID
        assert blob["uploaded"] is None, "nothing may be written on a bad binding"

    def test_unsupported_filename_rejected_before_download(
        self, client, blob
    ) -> None:
        response = client.post(
            "/converter/v1/convert",
            json=make_body(jobToken=make_token(filename="notes.txt")),
        )
        assert response.status_code == 415
        assert response.json()["code"] == ErrorCode.UNSUPPORTED_FILE_TYPE

    def test_oversized_declared_size_rejected(self, client, blob) -> None:
        response = client.post(
            "/converter/v1/convert",
            json=make_body(jobToken=make_token(source_size=200 * 1024 * 1024)),
        )
        assert response.status_code == 413
        assert response.json()["code"] == ErrorCode.FILE_TOO_LARGE


class TestFailureHandling:
    def test_upload_failure_reported_cleanly(self, client, blob) -> None:
        blob["put_status"] = 500
        response = client.post("/converter/v1/convert", json=make_body())

        assert response.status_code == 502
        assert response.json()["code"] == ErrorCode.RESULT_UPLOAD_FAILED
        assert set(response.json()) == {"code", "message"}

    def test_failure_publishes_failed_status(self, client, blob) -> None:
        blob["put_status"] = 500
        client.post("/converter/v1/convert", json=make_body())

        last = blob["statuses"][-1]
        assert last["stage"] == "failed"
        assert last["ok"] is False
        assert last["code"] == ErrorCode.RESULT_UPLOAD_FAILED

    def test_corrupt_source_rejected(self, client, blob) -> None:
        blob["source_bytes"] = b"this is not a pptx"
        response = client.post("/converter/v1/convert", json=make_body())
        assert response.status_code == 422
        assert response.json()["code"] == ErrorCode.INVALID_FILE_FORMAT

    def test_errors_never_leak_internal_detail(self, client, blob) -> None:
        """§45 - no stack traces, no paths, no URLs."""
        blob["source_bytes"] = b"nope"
        raw = client.post("/converter/v1/convert", json=make_body()).text
        assert "Traceback" not in raw
        assert "/tmp" not in raw
        assert "C:\\" not in raw
        assert "vercel-storage" not in raw


class TestRequestContract:
    def test_extra_fields_rejected(self, client, blob) -> None:
        response = client.post(
            "/converter/v1/convert", json=make_body(unexpected="x")
        )
        assert response.status_code == 422

    def test_file_content_is_not_accepted(self, client, blob) -> None:
        """§17 - the document must never be sent to this endpoint."""
        response = client.post(
            "/converter/v1/convert", json=make_body(fileContent="AAAA")
        )
        assert response.status_code == 422

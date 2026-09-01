"""Streaming transfer tests (ENGINEERING_SPEC.md §24, §25, §40).

All HTTP is served by httpx.MockTransport, so these run offline and assert on
behaviour rather than on a live Blob store.
"""

from __future__ import annotations

import httpx
import pytest

from app.errors import ConversionError, ErrorCode
from app.services.transfer import delete_blob, download_source, upload_result

URL = "https://store.private.blob.vercel-storage.com/jobs/a/source/input.pdf"


def client_returning(handler) -> httpx.Client:
    return httpx.Client(transport=httpx.MockTransport(handler))


def bytes_response(payload: bytes, *, declared: int | None = None) -> httpx.Response:
    headers = {"content-length": str(declared if declared is not None else len(payload))}
    return httpx.Response(200, content=payload, headers=headers)


class TestDownload:
    def test_writes_body_to_disk(self, tmp_path) -> None:
        destination = tmp_path / "input.pdf"
        payload = b"%PDF-1.7\n" + b"x" * 5000
        client = client_returning(lambda request: bytes_response(payload))

        written = download_source(URL, destination, client=client)

        assert written == len(payload)
        assert destination.read_bytes() == payload

    def test_streams_multi_chunk_body(self, tmp_path) -> None:
        destination = tmp_path / "big.pdf"
        payload = b"y" * (3 * 1024 * 1024 + 17)
        client = client_returning(lambda request: bytes_response(payload))

        written = download_source(URL, destination, client=client)

        assert written == len(payload)
        assert destination.stat().st_size == len(payload)

    def test_aborts_when_body_exceeds_ceiling(self, tmp_path) -> None:
        """The ceiling is enforced on bytes RECEIVED, not the declared size."""
        destination = tmp_path / "toobig.pdf"
        payload = b"z" * 4096
        # Server lies about the size, then sends more than allowed.
        client = client_returning(
            lambda request: bytes_response(payload, declared=10)
        )

        with pytest.raises(ConversionError) as caught:
            download_source(URL, destination, max_bytes=1000, client=client)

        assert caught.value.code is ErrorCode.FILE_TOO_LARGE
        assert not destination.exists(), "partial download must be cleaned up"

    def test_rejects_oversized_declared_length_early(self, tmp_path) -> None:
        destination = tmp_path / "declared.pdf"
        client = client_returning(
            lambda request: bytes_response(b"x" * 10, declared=999_999_999)
        )
        with pytest.raises(ConversionError) as caught:
            download_source(URL, destination, max_bytes=1000, client=client)
        assert caught.value.code is ErrorCode.FILE_TOO_LARGE

    def test_404_maps_to_blob_not_found(self, tmp_path) -> None:
        client = client_returning(lambda request: httpx.Response(404))
        with pytest.raises(ConversionError) as caught:
            download_source(URL, tmp_path / "x.pdf", client=client)
        assert caught.value.code is ErrorCode.BLOB_NOT_FOUND

    @pytest.mark.parametrize("status", [400, 403, 500, 503])
    def test_other_errors_map_to_download_failed(self, tmp_path, status) -> None:
        client = client_returning(lambda request: httpx.Response(status))
        with pytest.raises(ConversionError) as caught:
            download_source(URL, tmp_path / "x.pdf", client=client)
        assert caught.value.code is ErrorCode.DOWNLOAD_FAILED

    def test_network_error_maps_to_download_failed(self, tmp_path) -> None:
        def boom(request: httpx.Request) -> httpx.Response:
            raise httpx.ConnectError("refused", request=request)

        with pytest.raises(ConversionError) as caught:
            download_source(URL, tmp_path / "x.pdf", client=client_returning(boom))
        assert caught.value.code is ErrorCode.DOWNLOAD_FAILED

    def test_empty_body_rejected(self, tmp_path) -> None:
        destination = tmp_path / "empty.pdf"
        client = client_returning(lambda request: bytes_response(b""))
        with pytest.raises(ConversionError) as caught:
            download_source(URL, destination, client=client)
        assert caught.value.code is ErrorCode.DOWNLOAD_FAILED
        assert not destination.exists()

    def test_no_authorization_header_sent(self, tmp_path) -> None:
        """Presigned URLs carry their own auth; a bearer token must not leak."""
        seen: dict[str, httpx.Headers] = {}

        def capture(request: httpx.Request) -> httpx.Response:
            seen["headers"] = request.headers
            return bytes_response(b"data")

        download_source(URL, tmp_path / "x.pdf", client=client_returning(capture))
        assert "authorization" not in seen["headers"]


class TestUpload:
    PUT_URL = "https://store.private.blob.vercel-storage.com/jobs/a/result/r.zip"

    def test_sends_file_body_and_returns_size(self, tmp_path) -> None:
        source = tmp_path / "result.zip"
        source.write_bytes(b"PK\x03\x04" + b"q" * 2048)
        captured: dict[str, object] = {}

        def capture(request: httpx.Request) -> httpx.Response:
            captured["body"] = request.content
            captured["type"] = request.headers.get("content-type")
            captured["method"] = request.method
            return httpx.Response(200)

        sent = upload_result(
            self.PUT_URL, source, client=client_returning(capture)
        )

        assert sent == source.stat().st_size
        assert captured["method"] == "PUT"
        assert captured["type"] == "application/zip"
        assert captured["body"] == source.read_bytes()

    def test_missing_file_rejected(self, tmp_path) -> None:
        with pytest.raises(ConversionError) as caught:
            upload_result(self.PUT_URL, tmp_path / "nope.zip")
        assert caught.value.code is ErrorCode.RESULT_UPLOAD_FAILED

    @pytest.mark.parametrize("status", [400, 403, 413, 500])
    def test_error_status_maps_to_upload_failed(self, tmp_path, status) -> None:
        source = tmp_path / "r.zip"
        source.write_bytes(b"data")
        client = client_returning(lambda request: httpx.Response(status))
        with pytest.raises(ConversionError) as caught:
            upload_result(self.PUT_URL, source, client=client)
        assert caught.value.code is ErrorCode.RESULT_UPLOAD_FAILED

    def test_network_error_maps_to_upload_failed(self, tmp_path) -> None:
        source = tmp_path / "r.zip"
        source.write_bytes(b"data")

        def boom(request: httpx.Request) -> httpx.Response:
            raise httpx.ReadTimeout("slow", request=request)

        with pytest.raises(ConversionError) as caught:
            upload_result(self.PUT_URL, source, client=client_returning(boom))
        assert caught.value.code is ErrorCode.RESULT_UPLOAD_FAILED


class TestDelete:
    DELETE_URL = "https://store.private.blob.vercel-storage.com/jobs/a/source/i.pdf"

    def test_successful_delete_reports_true(self) -> None:
        client = client_returning(lambda request: httpx.Response(200))
        assert delete_blob(self.DELETE_URL, client=client) is True

    def test_failed_delete_never_raises(self) -> None:
        """§40/§41 - cleanup cron is the backstop; a failed delete is not fatal."""
        client = client_returning(lambda request: httpx.Response(500))
        assert delete_blob(self.DELETE_URL, client=client) is False

    def test_network_error_never_raises(self) -> None:
        def boom(request: httpx.Request) -> httpx.Response:
            raise httpx.ConnectError("gone", request=request)

        assert delete_blob(self.DELETE_URL, client=client_returning(boom)) is False

    def test_uses_delete_method(self) -> None:
        seen: dict[str, str] = {}

        def capture(request: httpx.Request) -> httpx.Response:
            seen["method"] = request.method
            return httpx.Response(204)

        delete_blob(self.DELETE_URL, client=client_returning(capture))
        assert seen["method"] == "DELETE"

"""Job token tests (ENGINEERING_SPEC.md §16, §45)."""

from __future__ import annotations

import time

import pytest

from app.errors import ConversionError, ErrorCode
from app.security.job_token import (
    MIN_SECRET_BYTES,
    JobClaims,
    assert_url_matches_path,
    mint_job_token,
    signing_secret,
    verify_job_token,
)

SECRET = b"y" * MIN_SECRET_BYTES


def make_claims(**overrides) -> JobClaims:
    defaults = {
        "job_id": "6f3b9d",
        "source_path": "jobs/2026-09-01/6f3b9d/source/report.pdf",
        "result_path": "jobs/2026-09-01/6f3b9d/result/report_markdown.zip",
        "filename": "report.pdf",
        "source_size": 1234,
        "exp": int(time.time()) + 600,
    }
    defaults.update(overrides)
    return JobClaims(**defaults)


class TestRoundTrip:
    def test_valid_token_verifies(self) -> None:
        claims = make_claims()
        assert verify_job_token(mint_job_token(claims, SECRET), SECRET) == claims

    def test_claims_survive_exactly(self) -> None:
        claims = make_claims(filename="Übersicht Studie.docx", source_size=99)
        restored = verify_job_token(mint_job_token(claims, SECRET), SECRET)
        assert restored.filename == "Übersicht Studie.docx"
        assert restored.source_size == 99


class TestSignature:
    def test_wrong_secret_rejected(self) -> None:
        token = mint_job_token(make_claims(), SECRET)
        with pytest.raises(ConversionError) as caught:
            verify_job_token(token, b"z" * MIN_SECRET_BYTES)
        assert caught.value.code is ErrorCode.JOB_TOKEN_INVALID

    def test_tampered_payload_rejected(self) -> None:
        """The whole point: claims cannot be edited without the secret."""
        token = mint_job_token(make_claims(), SECRET)
        payload, signature = token.split(".")
        forged = payload[:-4] + "AAAA"
        with pytest.raises(ConversionError) as caught:
            verify_job_token(f"{forged}.{signature}", SECRET)
        assert caught.value.code is ErrorCode.JOB_TOKEN_INVALID

    @pytest.mark.parametrize(
        "token",
        ["", ".", "abc", "a.b.c", "onlypayload", ".sig", "payload."],
    )
    def test_malformed_tokens_rejected(self, token: str) -> None:
        with pytest.raises(ConversionError) as caught:
            verify_job_token(token, SECRET)
        assert caught.value.code is ErrorCode.JOB_TOKEN_INVALID

    def test_unsigned_payload_rejected(self) -> None:
        """A payload with a plausible but unsigned signature must not pass."""
        import base64
        import json

        payload = base64.urlsafe_b64encode(
            json.dumps(make_claims().to_payload()).encode()
        ).decode().rstrip("=")
        with pytest.raises(ConversionError):
            verify_job_token(f"{payload}.{payload}", SECRET)


class TestExpiry:
    def test_expired_token_rejected(self) -> None:
        token = mint_job_token(
            make_claims(exp=int(time.time()) - 3600), SECRET
        )
        with pytest.raises(ConversionError) as caught:
            verify_job_token(token, SECRET)
        assert caught.value.code is ErrorCode.JOB_TOKEN_EXPIRED

    def test_small_clock_skew_tolerated(self) -> None:
        token = mint_job_token(make_claims(exp=int(time.time()) - 5), SECRET)
        assert verify_job_token(token, SECRET).job_id == "6f3b9d"

    def test_expiry_checked_after_signature(self) -> None:
        """An expired token with a bad signature is INVALID, not EXPIRED.

        Reporting expiry first would confirm payload contents to a caller who
        cannot produce a valid signature.
        """
        token = mint_job_token(make_claims(exp=int(time.time()) - 3600), SECRET)
        payload, _ = token.split(".")
        with pytest.raises(ConversionError) as caught:
            verify_job_token(f"{payload}.AAAA", SECRET)
        assert caught.value.code is ErrorCode.JOB_TOKEN_INVALID


class TestSecretPolicy:
    def test_missing_secret_is_service_error(self, monkeypatch) -> None:
        monkeypatch.delenv("JOB_SIGNING_SECRET", raising=False)
        with pytest.raises(ConversionError) as caught:
            signing_secret()
        assert caught.value.code is ErrorCode.SERVICE_UNAVAILABLE

    def test_short_secret_refused(self, monkeypatch) -> None:
        monkeypatch.setenv("JOB_SIGNING_SECRET", "tooshort")
        with pytest.raises(ConversionError) as caught:
            signing_secret()
        assert caught.value.code is ErrorCode.SERVICE_UNAVAILABLE

    def test_adequate_secret_accepted(self, monkeypatch) -> None:
        monkeypatch.setenv("JOB_SIGNING_SECRET", "a" * MIN_SECRET_BYTES)
        assert len(signing_secret()) >= MIN_SECRET_BYTES


class TestUrlBinding:
    """A valid token must not authorise arbitrary pathnames."""

    BASE = "https://store.private.blob.vercel-storage.com"
    PATH = "jobs/2026-09-01/6f3b9d/result/report_markdown.zip"

    def test_matching_url_accepted(self) -> None:
        assert_url_matches_path(
            f"{self.BASE}/{self.PATH}?vercel-blob-valid-until=123",
            self.PATH,
            label="result",
        )

    def test_url_encoded_path_accepted(self) -> None:
        path = "jobs/2026-09-01/6f3b9d/result/Market%20Study_markdown.zip"
        assert_url_matches_path(
            f"{self.BASE}/{path}",
            "jobs/2026-09-01/6f3b9d/result/Market Study_markdown.zip",
            label="result",
        )

    def test_mismatched_path_rejected(self) -> None:
        """The attack this exists to stop: redirect the result elsewhere."""
        with pytest.raises(ConversionError) as caught:
            assert_url_matches_path(
                f"{self.BASE}/jobs/other/result/elsewhere.zip",
                self.PATH,
                label="result",
            )
        assert caught.value.code is ErrorCode.JOB_TOKEN_INVALID

    def test_non_https_rejected(self) -> None:
        with pytest.raises(ConversionError) as caught:
            assert_url_matches_path(
                f"http://store.example.com/{self.PATH}", self.PATH, label="result"
            )
        assert caught.value.code is ErrorCode.JOB_TOKEN_INVALID

    def test_path_prefix_not_enough(self) -> None:
        """A longer path that merely starts with the signed one must fail."""
        with pytest.raises(ConversionError):
            assert_url_matches_path(
                f"{self.BASE}/{self.PATH}/../../evil.zip",
                self.PATH,
                label="result",
            )

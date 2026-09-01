"""Cross-language job token contract (§16).

The frontend mints job tokens in TypeScript; the converter verifies them in
Python. Nothing at runtime forces those two implementations to agree, so the
agreement is pinned here with a shared vector.

The token below was produced by `frontend/lib/job-token.ts` and is asserted
against in `frontend/lib/job-token.test.ts` as an inline snapshot. If either
serializer changes — field order, JSON spacing, non-ASCII escaping, base64
alphabet — one of these two tests fails instead of production.
"""

from __future__ import annotations

import pytest

from app.errors import ConversionError, ErrorCode
from app.security.job_token import (
    JobClaims,
    mint_job_token,
    serialize_claims,
    verify_job_token,
)

# Shared with frontend/lib/job-token.test.ts
SECRET = b"s" * 32

CLAIMS = JobClaims(
    job_id="6f3b9d",
    source_path="jobs/2026-09-01/6f3b9d/source/report.pdf",
    result_path="jobs/2026-09-01/6f3b9d/result/report_markdown.zip",
    filename="report.pdf",
    source_size=1234,
    exp=1788260000,
)

# Minted by the TypeScript implementation.
TS_MINTED_TOKEN = (
    "eyJleHAiOjE3ODgyNjAwMDAsImZpbGVuYW1lIjoicmVwb3J0LnBkZiIsImpvYl9pZCI6IjZm"
    "M2I5ZCIsInJlc3VsdF9wYXRoIjoiam9icy8yMDI2LTA5LTAxLzZmM2I5ZC9yZXN1bHQvcmVw"
    "b3J0X21hcmtkb3duLnppcCIsInNvdXJjZV9wYXRoIjoiam9icy8yMDI2LTA5LTAxLzZmM2I5"
    "ZC9zb3VyY2UvcmVwb3J0LnBkZiIsInNvdXJjZV9zaXplIjoxMjM0fQ"
    ".B5gGcVb5QR3EJgU35E_-tQt2jLqVEWicIzMVjFh0c3E"
)

EXPECTED_PAYLOAD = (
    '{"exp":1788260000,"filename":"report.pdf","job_id":"6f3b9d",'
    '"result_path":"jobs/2026-09-01/6f3b9d/result/report_markdown.zip",'
    '"source_path":"jobs/2026-09-01/6f3b9d/source/report.pdf",'
    '"source_size":1234}'
)


class TestWireFormat:
    def test_python_serialisation_matches_typescript(self) -> None:
        assert serialize_claims(CLAIMS).decode("utf-8") == EXPECTED_PAYLOAD

    def test_python_mints_the_identical_token(self) -> None:
        """Both languages must produce the same bytes for the same claims."""
        assert mint_job_token(CLAIMS, SECRET) == TS_MINTED_TOKEN

    def test_non_ascii_is_not_escaped(self) -> None:
        """JSON.stringify emits non-ASCII raw; ensure_ascii=True would not."""
        claims = JobClaims(
            job_id="j",
            source_path="jobs/2026-09-01/j/source/a.docx",
            result_path="jobs/2026-09-01/j/result/a_markdown.zip",
            filename="Übersicht Studie.docx",
            source_size=1,
            exp=1788260000,
        )
        payload = serialize_claims(claims).decode("utf-8")
        assert "Übersicht Studie.docx" in payload
        assert "\\u00dc" not in payload


class TestVerification:
    def test_python_accepts_the_typescript_signature(self) -> None:
        """The whole point: the converter accepts what the frontend signs.

        The shared vector's `exp` is fixed and now in the past, so verification
        ends at the expiry check. Reaching that check is itself the assertion:
        `verify_job_token` only evaluates expiry AFTER `compare_digest` has
        accepted the signature, so EXPIRED proves the HMAC matched across
        languages, where INVALID would prove it did not.
        """
        with pytest.raises(ConversionError) as caught:
            verify_job_token(TS_MINTED_TOKEN, SECRET)
        assert caught.value.code is ErrorCode.JOB_TOKEN_EXPIRED

    def test_python_verifies_a_live_typescript_token(self) -> None:
        """Full success path, with the expiry moved into the future.

        Re-signed here rather than re-minted from claims, so the payload bytes
        under test are still the ones TypeScript would produce.
        """
        import base64
        import hashlib
        import hmac
        import json
        import time

        payload = json.loads(
            base64.urlsafe_b64decode(TS_MINTED_TOKEN.split(".")[0] + "==")
        )
        payload["exp"] = int(time.time()) + 600
        payload_b64 = (
            base64.urlsafe_b64encode(
                json.dumps(
                    payload, separators=(",", ":"), sort_keys=True,
                    ensure_ascii=False,
                ).encode("utf-8")
            )
            .decode("ascii")
            .rstrip("=")
        )
        signature = (
            base64.urlsafe_b64encode(
                hmac.new(
                    SECRET, payload_b64.encode("ascii"), hashlib.sha256
                ).digest()
            )
            .decode("ascii")
            .rstrip("=")
        )

        claims = verify_job_token(f"{payload_b64}.{signature}", SECRET)
        assert claims.job_id == CLAIMS.job_id
        assert claims.source_path == CLAIMS.source_path
        assert claims.result_path == CLAIMS.result_path

    def test_typescript_token_rejected_under_wrong_secret(self) -> None:
        with pytest.raises(ConversionError) as caught:
            verify_job_token(TS_MINTED_TOKEN, b"z" * 32)
        assert caught.value.code is ErrorCode.JOB_TOKEN_INVALID

    def test_tampered_typescript_token_rejected(self) -> None:
        payload, signature = TS_MINTED_TOKEN.split(".")
        with pytest.raises(ConversionError):
            verify_job_token(f"{payload[:-4]}AAAA.{signature}", SECRET)

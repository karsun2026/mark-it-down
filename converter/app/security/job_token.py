"""HMAC-signed job tokens (ENGINEERING_SPEC.md §16).

The converter receives presigned Blob URLs in its request body. Those URLs are
opaque capabilities, so on their own they say nothing about which job they
belong to. The job token is what binds them: it is minted by the frontend,
names the exact source and result pathnames for the job, and is verified here
before any byte is moved.

§16 requires the converter to validate signature, expiry, job id, filename,
source path and result path. `verify_job_token` does the first two;
`assert_url_matches_path` does the binding that makes the rest meaningful — a
caller holding a valid token must not be able to point the result at a
different pathname than the one it was signed for.

Format is a compact JWS-like string, avoiding a JWT dependency for one claim
set: base64url(payload_json) + "." + base64url(hmac_sha256(payload_b64)).
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import time
from dataclasses import dataclass
from urllib.parse import parse_qs, unquote, urlparse

from app.errors import ConversionError, ErrorCode

_SECRET_ENV = "JOB_SIGNING_SECRET"
MIN_SECRET_BYTES = 32

# Small allowance for clock skew between the frontend and the converter.
CLOCK_SKEW_SECONDS = 60


@dataclass(frozen=True)
class JobClaims:
    """The §16 payload."""

    job_id: str
    source_path: str
    result_path: str
    filename: str
    source_size: int
    exp: int

    def to_payload(self) -> dict[str, object]:
        return {
            "job_id": self.job_id,
            "source_path": self.source_path,
            "result_path": self.result_path,
            "filename": self.filename,
            "source_size": self.source_size,
            "exp": self.exp,
        }


def _b64encode(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).decode("ascii").rstrip("=")


def _b64decode(value: str) -> bytes:
    padding = "=" * (-len(value) % 4)
    try:
        return base64.urlsafe_b64decode(value + padding)
    except (ValueError, TypeError) as exc:
        raise ConversionError(
            ErrorCode.JOB_TOKEN_INVALID, internal_detail="base64 decode failed"
        ) from exc


def signing_secret() -> bytes:
    """The shared secret, refusing to run with a weak or missing one."""
    raw = os.environ.get(_SECRET_ENV, "")
    secret = raw.encode("utf-8")
    if len(secret) < MIN_SECRET_BYTES:
        # A misconfigured secret is a deployment fault, not a client error.
        raise ConversionError(
            ErrorCode.SERVICE_UNAVAILABLE,
            internal_detail=(
                f"{_SECRET_ENV} missing or shorter than {MIN_SECRET_BYTES} bytes"
            ),
        )
    return secret


def _sign(payload_b64: str, secret: bytes) -> str:
    digest = hmac.new(secret, payload_b64.encode("ascii"), hashlib.sha256).digest()
    return _b64encode(digest)


def serialize_claims(claims: JobClaims) -> bytes:
    """Canonical claim serialisation, shared with the TypeScript minter.

    `ensure_ascii=False` matters: the frontend mints tokens with
    `JSON.stringify`, which emits non-ASCII characters raw. Escaping them here
    would produce different bytes for the same claims, so a token minted on one
    side could not be reproduced on the other.

    Verification does not depend on this — `verify_job_token` signs the
    base64 payload string exactly as received rather than re-serialising — but
    keeping the two minters byte-identical is what makes the wire format
    testable across languages. See `tests/converter/test_job_token.py`.
    """
    return json.dumps(
        claims.to_payload(),
        separators=(",", ":"),
        sort_keys=True,
        ensure_ascii=False,
    ).encode("utf-8")


def mint_job_token(claims: JobClaims, secret: bytes | None = None) -> str:
    """Create a signed token. Used by tests and by any server-side caller."""
    key = secret if secret is not None else signing_secret()
    payload_b64 = _b64encode(serialize_claims(claims))
    return f"{payload_b64}.{_sign(payload_b64, key)}"


def verify_job_token(token: str, secret: bytes | None = None) -> JobClaims:
    """Verify signature then expiry, returning the claims.

    Signature is checked before anything else is trusted, and compared in
    constant time so the comparison cannot be used as an oracle.
    """
    key = secret if secret is not None else signing_secret()

    parts = token.split(".")
    if len(parts) != 2 or not all(parts):
        raise ConversionError(
            ErrorCode.JOB_TOKEN_INVALID, internal_detail="malformed token"
        )

    payload_b64, signature_b64 = parts
    expected = _sign(payload_b64, key)
    if not hmac.compare_digest(signature_b64, expected):
        raise ConversionError(
            ErrorCode.JOB_TOKEN_INVALID, internal_detail="signature mismatch"
        )

    try:
        payload = json.loads(_b64decode(payload_b64))
    except (ValueError, UnicodeDecodeError) as exc:
        raise ConversionError(
            ErrorCode.JOB_TOKEN_INVALID, internal_detail="payload not json"
        ) from exc

    if not isinstance(payload, dict):
        raise ConversionError(
            ErrorCode.JOB_TOKEN_INVALID, internal_detail="payload not an object"
        )

    try:
        claims = JobClaims(
            job_id=str(payload["job_id"]),
            source_path=str(payload["source_path"]),
            result_path=str(payload["result_path"]),
            filename=str(payload["filename"]),
            source_size=int(payload["source_size"]),
            exp=int(payload["exp"]),
        )
    except (KeyError, TypeError, ValueError) as exc:
        raise ConversionError(
            ErrorCode.JOB_TOKEN_INVALID, internal_detail="missing or bad claim"
        ) from exc

    # Expiry is checked only after the signature proves the payload is ours.
    if claims.exp + CLOCK_SKEW_SECONDS < int(time.time()):
        raise ConversionError(
            ErrorCode.JOB_TOKEN_EXPIRED, internal_detail="exp in the past"
        )

    return claims


def pathname_from_signed_url(url: str) -> str | None:
    """Extract the blob pathname a presigned URL targets.

    Vercel presigns the two operation families differently, and assuming one
    shape rejects the other:

      * read operations (``get``/``head``) address the blob directly, so the
        pathname is the URL path on the private store host::

            https://<store>.private.blob.vercel-storage.com/jobs/.../input.pptx

      * write operations (``put``) go to the Blob API, so the pathname is a
        query parameter and the URL path is a fixed endpoint::

            https://vercel.com/api/blob/?pathname=jobs/.../result.zip&...

    Returns None when no pathname can be determined.
    """
    parsed = urlparse(url)

    # Query form wins when present: an API-style URL's path is the endpoint,
    # not the blob.
    query_pathname = parse_qs(parsed.query).get("pathname")
    if query_pathname and query_pathname[0]:
        return unquote(query_pathname[0]).lstrip("/")

    path = unquote(parsed.path).lstrip("/")
    return path or None


def assert_url_matches_path(url: str, expected_pathname: str, *, label: str) -> None:
    """Bind a presigned URL to the pathname the token was signed for.

    Without this, a caller holding one valid token could pass a presigned PUT
    for an unrelated pathname and have the converter write the result there.
    The token would verify, so the signature check alone is not sufficient.
    """
    parsed = urlparse(url)

    if parsed.scheme != "https":
        raise ConversionError(
            ErrorCode.JOB_TOKEN_INVALID,
            internal_detail=f"{label} url is not https",
        )

    actual = pathname_from_signed_url(url)
    if actual is None or actual != expected_pathname.lstrip("/"):
        raise ConversionError(
            ErrorCode.JOB_TOKEN_INVALID,
            internal_detail=f"{label} url does not target the signed pathname",
        )

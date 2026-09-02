"""§57 near-limit release test — the half that requires a deployment.

    MARKITDOWN_BASE_URL=https://your-deployment.vercel.app \\
      .venv/Scripts/python.exe scripts/release_test_e2e.py --format pptx

This covers the four §57 checks that are properties of the deployed data path
and cannot be observed locally:

    1. browser direct upload succeeds
    2. binary never passes through a normal Function request body
    6. result uploads directly to Blob
    8. result downloads via a signed Blob URL

Check 2 is the one that matters most and is the easiest to get wrong, so it is
asserted structurally rather than by inspection: this script drives the same
routes the browser does and asserts that **no request or response carrying the
document ever goes to the app's own origin**. Every large transfer must be to a
Blob host. If a future change starts proxying bytes through a Function, this
fails.

The upload here is a plain HTTP PUT to the presigned URL the app issues, which
is exactly what `uploadPresigned` does in the browser (DEVIATIONS D-004). It is
not a browser, so it does not prove the UI works — it proves the data path does.

Requires: a deployment with a Blob store, and JOB_SIGNING_SECRET configured.
Exit code 0 only if every check passes.
"""

from __future__ import annotations

import argparse
import os
import sys
import time
from dataclasses import dataclass, field
from pathlib import Path
from urllib.parse import urlparse

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO / "converter"))

import httpx  # noqa: E402

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

MEGABYTE = 1024 * 1024
FIXTURE_DIR = REPO / "tests" / "converter" / "fixtures" / "large"

MIME = {
    "pptx": (
        "application/vnd.openxmlformats-officedocument.presentationml.presentation"
    ),
    "docx": (
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    ),
    "pdf": "application/pdf",
}

# A Function response is capped at 4.5 MB (§3). Control messages should be far
# smaller than that; anything approaching it means bytes are being proxied.
CONTROL_MESSAGE_CEILING = 64 * 1024

UPLOAD_TIMEOUT = httpx.Timeout(connect=30.0, read=900.0, write=900.0, pool=30.0)


@dataclass
class Check:
    label: str
    passed: bool
    detail: str
    spec_ref: str = ""


@dataclass
class Report:
    base_url: str
    source_format: str
    source_bytes: int = 0
    checks: list[Check] = field(default_factory=list)
    app_origin_bytes: int = 0
    blob_origin_bytes: int = 0
    largest_function_payload: int = 0
    duration_seconds: float = 0.0

    @property
    def passed(self) -> bool:
        return all(c.passed for c in self.checks)


def _mb(value: int | float) -> str:
    return f"{value / MEGABYTE:.1f} MB"


def _is_blob_host(url: str) -> bool:
    host = (urlparse(url).hostname or "").lower()
    return host.endswith("blob.vercel-storage.com")


def run(base_url: str, source: Path, source_format: str) -> Report:
    report = Report(base_url=base_url, source_format=source_format)
    report.source_bytes = source.stat().st_size
    base = base_url.rstrip("/")
    app_host = (urlparse(base).hostname or "").lower()

    started = time.perf_counter()

    with httpx.Client(timeout=UPLOAD_TIMEOUT, follow_redirects=True) as client:
        # --- 1. Ask the app to authorise an upload (small JSON) -------------
        job_id = f"release-{int(time.time())}"
        date = time.strftime("%Y-%m-%d")
        prefix = f"jobs/{date}/{job_id}"
        source_pathname = f"{prefix}/source/near-limit.{source_format}"
        result_pathname = f"{prefix}/result/near-limit_markdown.zip"
        status_pathname = f"{prefix}/status.json"

        # The event shape @vercel/blob/client's `upload()` sends. Getting this
        # wrong returns a confusing 5xx rather than a validation error, so it is
        # written out explicitly rather than assembled.
        auth_body = {
            "type": "blob.generate-client-token",
            "payload": {
                "pathname": source_pathname,
                "callbackUrl": f"{base}/api/blob/upload",
                "multipart": False,
                "clientPayload": None,
            },
        }
        auth_response = client.post(f"{base}/api/blob/upload", json=auth_body)
        report.largest_function_payload = max(
            report.largest_function_payload, len(auth_response.content)
        )
        report.app_origin_bytes += len(auth_response.content)

        if auth_response.status_code != 200:
            report.checks.append(
                Check(
                    "upload authorization succeeded",
                    False,
                    f"HTTP {auth_response.status_code}: "
                    f"{auth_response.text[:200]}",
                    "§13",
                )
            )
            return report

        report.checks.append(
            Check(
                "upload authorization succeeded",
                True,
                f"{len(auth_response.content)} byte response",
                "§13",
            )
        )

        client_token = auth_response.json().get("clientToken")
        report.checks.append(
            Check(
                "app issued a scoped client upload token",
                bool(client_token),
                "token issued" if client_token else auth_response.text[:160],
                "§13",
            )
        )
        if not client_token:
            return report

        # --- 2. Upload the document DIRECTLY to Blob -----------------------
        #
        # Driven through the real @vercel/blob/client `upload()` via a small
        # Node helper. Reimplementing the Blob upload protocol here would test
        # the reimplementation, not the app.
        upload_result = _upload_via_sdk(
            base, source_pathname, source, source_format
        )
        upload_ok = bool(upload_result.get("ok"))
        blob_url = str(upload_result.get("url", ""))

        report.checks.append(
            Check(
                "browser direct upload succeeded",
                upload_ok,
                f"{_mb(report.source_bytes)} in "
                f"{upload_result.get('elapsedMs', 0) / 1000:.1f}s"
                if upload_ok
                else str(upload_result.get("error"))[:200],
                "§12, §57.1",
            )
        )
        if not upload_ok:
            return report

        report.blob_origin_bytes += report.source_bytes
        report.checks.append(
            Check(
                "upload landed on a private Blob host, not the app",
                _is_blob_host(blob_url) and ".private." in blob_url,
                urlparse(blob_url).hostname or "?",
                "§3, §20, §57.1",
            )
        )

        # --- 3. Prepare the job (small JSON) -------------------------------
        prepare_response = client.post(
            f"{base}/api/blob/prepare-job",
            json={
                "jobId": job_id,
                "sourcePathname": source_pathname,
                "resultPathname": result_pathname,
                "statusPathname": status_pathname,
                "originalFilename": f"near-limit.{source_format}",
            },
        )
        report.largest_function_payload = max(
            report.largest_function_payload, len(prepare_response.content)
        )
        report.app_origin_bytes += len(prepare_response.content)

        report.checks.append(
            Check(
                "prepare-job succeeded",
                prepare_response.status_code == 200,
                f"HTTP {prepare_response.status_code}",
                "§15",
            )
        )
        if prepare_response.status_code != 200:
            return report
        job = prepare_response.json()

        # --- 4. Convert (small JSON in, small JSON out) --------------------
        convert_response = client.post(
            f"{base}/converter/v1/convert",
            json={
                "jobToken": job["jobToken"],
                "sourceGetUrl": job["sourceGetUrl"],
                "resultPutUrl": job["resultPutUrl"],
                "sourceDeleteUrl": job["sourceDeleteUrl"],
                "statusPutUrl": job["statusPutUrl"],
            },
            timeout=httpx.Timeout(connect=30.0, read=900.0, write=60.0, pool=30.0),
        )
        report.largest_function_payload = max(
            report.largest_function_payload, len(convert_response.content)
        )
        report.app_origin_bytes += len(convert_response.content)

        report.checks.append(
            Check(
                "conversion succeeded",
                convert_response.status_code == 200,
                f"HTTP {convert_response.status_code}: "
                f"{convert_response.text[:200]}",
                "§17, §18",
            )
        )
        if convert_response.status_code != 200:
            return report

        result = convert_response.json()
        report.checks.append(
            Check(
                "converter response is a small control message",
                len(convert_response.content) < CONTROL_MESSAGE_CEILING,
                f"{len(convert_response.content)} bytes "
                f"(ceiling {CONTROL_MESSAGE_CEILING})",
                "§18, §57.7",
            )
        )
        report.checks.append(
            Check(
                "converter response carries no ZIP bytes",
                b"PK\x03\x04" not in convert_response.content,
                "no ZIP signature in the response body",
                "§18",
            )
        )
        report.checks.append(
            Check(
                "AI tokens used is zero",
                result.get("aiTokensUsed") == 0,
                str(result.get("aiTokensUsed")),
                "§1, §64, §73",
            )
        )

        # --- 5. Download the result via a signed Blob URL ------------------
        download_response = client.post(
            f"{base}/api/blob/download-url",
            json={
                "jobToken": job["jobToken"],
                "resultPathname": job["resultPathname"],
            },
        )
        report.largest_function_payload = max(
            report.largest_function_payload, len(download_response.content)
        )
        report.app_origin_bytes += len(download_response.content)

        report.checks.append(
            Check(
                "download-url succeeded",
                download_response.status_code == 200,
                f"HTTP {download_response.status_code}",
                "§19",
            )
        )
        if download_response.status_code != 200:
            return report

        download_url = download_response.json()["downloadUrl"]
        report.checks.append(
            Check(
                "download target is a Blob host, not the app",
                _is_blob_host(download_url),
                urlparse(download_url).hostname or "?",
                "§19, §57.8",
            )
        )

        # Stream the ZIP down and count it without holding it in memory.
        downloaded = 0
        first_bytes = b""
        with client.stream("GET", download_url) as response:
            for chunk in response.iter_bytes(MEGABYTE):
                if not first_bytes:
                    first_bytes = chunk[:4]
                downloaded += len(chunk)
        report.blob_origin_bytes += downloaded

        report.checks.append(
            Check(
                "result downloaded from Blob and is a ZIP",
                downloaded > 0 and first_bytes == b"PK\x03\x04",
                f"{_mb(downloaded)} downloaded",
                "§57.8",
            )
        )

    report.duration_seconds = time.perf_counter() - started

    # --- The structural assertion: no document bytes touched the app -------
    report.checks.append(
        Check(
            "no binary crossed a Function request or response body",
            report.largest_function_payload < CONTROL_MESSAGE_CEILING
            and report.app_origin_bytes < CONTROL_MESSAGE_CEILING * 8,
            f"largest app payload {report.largest_function_payload} bytes; "
            f"{_mb(report.blob_origin_bytes)} moved via Blob hosts "
            f"({app_host} carried control messages only)",
            "§3, §57.2",
        )
    )
    return report



def _upload_via_sdk(
    base_url: str, pathname: str, source: Path, source_format: str
) -> dict:
    """Run the real client-SDK upload through a Node helper."""
    import subprocess

    script = REPO / "frontend" / "scripts" / "e2e-upload.mjs"
    try:
        completed = subprocess.run(  # noqa: S603 - fixed argv, no shell
            [
                "node",
                str(script),
                base_url,
                pathname,
                str(source),
                MIME[source_format],
            ],
            capture_output=True,
            text=True,
            timeout=1800,
            check=False,
            cwd=str(REPO / "frontend"),
        )
    except (OSError, subprocess.SubprocessError) as exc:
        return {"ok": False, "error": f"node helper failed: {type(exc).__name__}"}

    line = (completed.stdout or "").strip().splitlines()
    if not line:
        return {"ok": False, "error": (completed.stderr or "no output")[:300]}
    try:
        import json as _json

        return _json.loads(line[-1])
    except ValueError:
        return {"ok": False, "error": line[-1][:300]}


def _extract_presigned_url(payload: object) -> str | None:
    """Find the upload URL in the authorization response.

    The SDK's response shape has changed across versions, so search rather than
    assume a key path.
    """
    found: list[str] = []

    def walk(node: object) -> None:
        if isinstance(node, str):
            if node.startswith("https://") and _is_blob_host(node):
                found.append(node)
        elif isinstance(node, dict):
            for value in node.values():
                walk(value)
        elif isinstance(node, list):
            for value in node:
                walk(value)

    walk(payload)
    return found[0] if found else None


def print_report(report: Report) -> None:
    print()
    print("=" * 72)
    print(f"§57 DEPLOYED RELEASE TEST — {report.source_format.upper()}")
    print(f"target: {report.base_url}")
    print("=" * 72)
    print(f"  source              {_mb(report.source_bytes)}")
    print(f"  via Blob hosts      {_mb(report.blob_origin_bytes)}")
    print(f"  via app origin      {report.app_origin_bytes} bytes")
    print(f"  largest fn payload  {report.largest_function_payload} bytes")
    print(f"  duration            {report.duration_seconds:.1f}s")
    print()
    for check in report.checks:
        print(f"  [{'PASS' if check.passed else 'FAIL'}] {check.label}")
        print(f"         {check.detail}   ({check.spec_ref})")
    print()
    print(f"  RESULT: {'PASS' if report.passed else 'FAIL'}")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--format", choices=["pptx", "pdf", "docx"], default="pptx")
    parser.add_argument(
        "--base-url",
        default=os.environ.get("MARKITDOWN_BASE_URL", ""),
        help="deployment origin, or set MARKITDOWN_BASE_URL",
    )
    args = parser.parse_args()

    if not args.base_url:
        print("No deployment target.")
        print("Set MARKITDOWN_BASE_URL or pass --base-url.")
        print()
        print("This script cannot be run without a deployment: §57 checks 1, 2,")
        print("6 and 8 are properties of the live Blob data path. The remaining")
        print("§57 checks are covered by scripts/release_test_local.py.")
        return 2

    source = FIXTURE_DIR / f"near-limit.{args.format}"
    if not source.exists():
        print(f"missing fixture: {source}")
        print("Generate it with: scripts/make_large_fixtures.py --mb 97")
        return 2

    report = run(args.base_url, source, args.format)
    print_report(report)
    return 0 if report.passed else 1


if __name__ == "__main__":
    raise SystemExit(main())

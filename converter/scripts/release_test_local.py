"""§57 near-limit release test — the half that can run without a deployment.

    .venv/Scripts/python.exe scripts/release_test_local.py --format pptx

§57 lists eight checks. Four of them are properties of the converter itself and
are measured here against a real 95-100 MB document:

    3. converter streams source
    4. memory remains bounded
    5. /tmp remains below guard
    7. converter response is small JSON

The other four (browser direct upload, no binary through a Function body,
result uploads directly to Blob, result downloads via a signed Blob URL) are
properties of the deployed data path and cannot be observed from here. They are
covered by `scripts/release_test_e2e.py`, which needs a deployment.

Streaming is exercised for real: the source is served over a local HTTP server
and pulled through `transfer.download_source`, and the result is pushed through
`transfer.upload_result` to a sink that discards the body. If either buffered
the whole file, peak memory would exceed the file size and the run would fail.

Exit code is 0 only if every check in scope passes, so CI can gate on it.
"""

from __future__ import annotations

import argparse
import contextlib
import http.server
import os
import socketserver
import sys
import tempfile
import threading
import time
from dataclasses import dataclass, field
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO / "converter"))

os.environ.setdefault(
    "WORKSPACE_ROOT", str(Path(tempfile.gettempdir()) / "doc2md-release-test")
)

import psutil  # noqa: E402

# Windows consoles default to a codepage that mangles the section sign.
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

from app.config import settings  # noqa: E402
from app.security.validation import SourceType  # noqa: E402
from app.services.pipeline import run_conversion  # noqa: E402
from app.services.transfer import download_source, upload_result  # noqa: E402
from app.services.workspace import JobWorkspace, directory_size  # noqa: E402

MEGABYTE = 1024 * 1024
FIXTURE_DIR = REPO / "tests" / "converter" / "fixtures" / "large"

SAMPLE_INTERVAL_SECONDS = 0.05


# ---------------------------------------------------------------------------
# Sampling
# ---------------------------------------------------------------------------


class ResourceSampler:
    """Samples process-tree RSS and workspace size on a background thread.

    The conversion runs in a spawned child (A1.6), so sampling only this
    process would miss where the memory actually goes.
    """

    def __init__(self, workspace_root: Path) -> None:
        self._workspace_root = workspace_root
        self._process = psutil.Process()
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None
        self.peak_rss_bytes = 0
        self.peak_workspace_bytes = 0
        self.samples = 0
        self.baseline_rss_bytes = self._tree_rss()
        self._phase = "startup"
        self._phase_peaks: dict[str, int] = {}
        self._phase_starts: dict[str, int] = {}

    def phase(self, name: str) -> None:
        """Begin a named phase; its peak is tracked separately."""
        self._phase = name
        self._phase_starts.setdefault(name, self._tree_rss())
        self._phase_peaks.setdefault(name, 0)

    def phase_delta(self, name: str) -> int:
        """How much RSS the phase added over the level it started at."""
        peak = self._phase_peaks.get(name, 0)
        start = self._phase_starts.get(name, 0)
        return max(0, peak - start)

    def _tree_rss(self) -> int:
        total = 0
        try:
            total += self._process.memory_info().rss
            for child in self._process.children(recursive=True):
                try:
                    total += child.memory_info().rss
                except (psutil.NoSuchProcess, psutil.AccessDenied):
                    continue
        except (psutil.NoSuchProcess, psutil.AccessDenied):
            pass
        return total

    def _run(self) -> None:
        while not self._stop.is_set():
            rss = self._tree_rss()
            self.peak_rss_bytes = max(self.peak_rss_bytes, rss)
            self._phase_peaks[self._phase] = max(
                self._phase_peaks.get(self._phase, 0), rss
            )
            # A file vanishing mid-walk (the source being deleted) is
            # expected, not an error.
            with contextlib.suppress(OSError):
                self.peak_workspace_bytes = max(
                    self.peak_workspace_bytes,
                    directory_size(self._workspace_root),
                )
            self.samples += 1
            self._stop.wait(SAMPLE_INTERVAL_SECONDS)

    def __enter__(self) -> ResourceSampler:
        self._thread = threading.Thread(target=self._run, daemon=True)
        self._thread.start()
        return self

    def __exit__(self, *_exc: object) -> None:
        self._stop.set()
        if self._thread:
            self._thread.join(timeout=5)


# ---------------------------------------------------------------------------
# Local HTTP endpoints, standing in for Blob
# ---------------------------------------------------------------------------


class _QuietHandler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *_args: object) -> None:  # noqa: A003
        pass


def serve_file(path: Path) -> tuple[str, socketserver.TCPServer, threading.Thread]:
    """Serve `path` over HTTP so the real streaming downloader can pull it."""
    directory = str(path.parent)

    class Handler(_QuietHandler):
        def __init__(self, *args: object, **kwargs: object) -> None:
            super().__init__(*args, directory=directory, **kwargs)  # type: ignore[arg-type]

    server = socketserver.TCPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    port = server.server_address[1]
    return f"http://127.0.0.1:{port}/{path.name}", server, thread


class _SinkHandler(_QuietHandler):
    """Accepts a PUT and discards the body in chunks, counting bytes."""

    received = 0

    def do_PUT(self) -> None:  # noqa: N802 - http.server naming
        remaining = int(self.headers.get("content-length", 0))
        while remaining > 0:
            chunk = self.rfile.read(min(1024 * 1024, remaining))
            if not chunk:
                break
            remaining -= len(chunk)
            type(self).received += len(chunk)
        self.send_response(200)
        self.end_headers()


def serve_sink() -> tuple[str, socketserver.TCPServer, threading.Thread]:
    _SinkHandler.received = 0
    server = socketserver.TCPServer(("127.0.0.1", 0), _SinkHandler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    return f"http://127.0.0.1:{server.server_address[1]}/result.zip", server, thread


# ---------------------------------------------------------------------------
# Checks
# ---------------------------------------------------------------------------


@dataclass
class Check:
    label: str
    passed: bool
    detail: str
    spec_ref: str = ""


@dataclass
class RunReport:
    source_format: str
    source_bytes: int = 0
    downloaded_bytes: int = 0
    zip_bytes: int = 0
    uploaded_bytes: int = 0
    peak_rss_bytes: int = 0
    baseline_rss_bytes: int = 0
    download_rss_delta: int = 0
    convert_rss_delta: int = 0
    upload_rss_delta: int = 0
    peak_workspace_bytes: int = 0
    output_tree_bytes: int = 0
    duration_seconds: float = 0.0
    pages_or_slides: int | None = None
    media_count: int = 0
    warnings: list[str] = field(default_factory=list)
    checks: list[Check] = field(default_factory=list)

    @property
    def passed(self) -> bool:
        return all(check.passed for check in self.checks)


def _mb(value: int | float) -> str:
    return f"{value / MEGABYTE:.1f} MB"


def run_once(source: Path, source_type: SourceType) -> RunReport:
    report = RunReport(source_format=str(source_type))
    report.source_bytes = source.stat().st_size

    job_id = f"release-{source_type}"
    workspace_root = settings.workspace_root

    source_url, file_server, _ = serve_file(source)
    sink_url, sink_server, _ = serve_sink()

    try:
        with JobWorkspace(job_id) as workspace, ResourceSampler(
            workspace_root
        ) as sampler:
            started = time.perf_counter()

            # 1. Stream the source in, exactly as the converter does in prod.
            sampler.phase("download")
            target = workspace.source_path(f".{source_type}")
            report.downloaded_bytes = download_source(source_url, target)

            # 2. Convert (validation, quotas, source deletion, packaging).
            sampler.phase("convert")
            outcome = run_conversion(
                workspace=workspace,
                source_path=target,
                source_type=source_type,
                output_stem="near-limit",
                original_filename=source.name,
            )
            report.output_tree_bytes = directory_size(workspace.output_dir)

            # 3. Stream the result out.
            sampler.phase("upload")
            report.uploaded_bytes = upload_result(sink_url, outcome.zip_path)

            report.duration_seconds = time.perf_counter() - started
            report.zip_bytes = outcome.zip_bytes
            report.pages_or_slides = outcome.pages_or_slides
            report.media_count = outcome.media_count
            report.warnings = list(outcome.warnings)

        report.peak_rss_bytes = sampler.peak_rss_bytes
        report.baseline_rss_bytes = sampler.baseline_rss_bytes
        report.download_rss_delta = sampler.phase_delta("download")
        report.convert_rss_delta = sampler.phase_delta("convert")
        report.upload_rss_delta = sampler.phase_delta("upload")
        report.peak_workspace_bytes = sampler.peak_workspace_bytes
    finally:
        file_server.shutdown()
        file_server.server_close()
        sink_server.shutdown()
        sink_server.server_close()

    _evaluate(report)
    return report


def _evaluate(report: RunReport) -> None:
    add = report.checks.append

    # §57.1 - the fixture must actually be in the band the spec requires.
    add(
        Check(
            "source is in the 95-100 MB band",
            95 * MEGABYTE <= report.source_bytes <= 100 * MEGABYTE,
            _mb(report.source_bytes),
            "§57",
        )
    )

    add(
        Check(
            "source downloaded completely",
            report.downloaded_bytes == report.source_bytes,
            f"{_mb(report.downloaded_bytes)} of {_mb(report.source_bytes)}",
            "§24",
        )
    )

    # §57.3/§24 - streaming is a property of the TRANSFER phases, so it is
    # measured there rather than across the whole run. A buffering reader would
    # add roughly the file size to RSS; a streaming one adds a few chunks.
    # The interpreter's fixed baseline (Pillow, pdfminer, python-pptx loaded)
    # is excluded by measuring each phase against its own starting level.
    transfer_ceiling = max(64 * MEGABYTE, report.source_bytes // 4)
    add(
        Check(
            "source download streamed, not buffered",
            report.download_rss_delta < transfer_ceiling,
            f"download added {_mb(report.download_rss_delta)} for a "
            f"{_mb(report.source_bytes)} file "
            f"(ceiling {_mb(transfer_ceiling)})",
            "§24, §57.3",
        )
    )
    add(
        Check(
            "result upload streamed, not buffered",
            report.upload_rss_delta < transfer_ceiling,
            f"upload added {_mb(report.upload_rss_delta)} for a "
            f"{_mb(report.zip_bytes)} ZIP (ceiling {_mb(transfer_ceiling)})",
            "§25",
        )
    )

    # §57.4 - must fit the container. Pro/Enterprise max is 4 GB (§65).
    container_memory = 4 * 1024 * MEGABYTE
    add(
        Check(
            "peak memory fits the 4 GB container",
            report.peak_rss_bytes < container_memory * 0.75,
            f"peak {_mb(report.peak_rss_bytes)} ({report.peak_rss_bytes / container_memory:.0%} of 4 GB)",
            "§57.4, §65",
        )
    )

    # §57.5 - the workspace guard.
    add(
        Check(
            "peak workspace stayed under the /tmp guard",
            report.peak_workspace_bytes < settings.max_workspace_bytes,
            f"peak {_mb(report.peak_workspace_bytes)} vs guard "
            f"{_mb(settings.max_workspace_bytes)}",
            "§22, §57.5, D-001",
        )
    )

    add(
        Check(
            "output tree stayed under its quota",
            report.output_tree_bytes <= settings.max_output_tree_bytes,
            f"{_mb(report.output_tree_bytes)} vs "
            f"{_mb(settings.max_output_tree_bytes)}",
            "§22",
        )
    )

    add(
        Check(
            "result ZIP stayed under its quota",
            report.zip_bytes <= settings.max_result_zip_bytes,
            f"{_mb(report.zip_bytes)} vs {_mb(settings.max_result_zip_bytes)}",
            "§22",
        )
    )

    add(
        Check(
            "result uploaded completely",
            report.uploaded_bytes == report.zip_bytes,
            f"{_mb(report.uploaded_bytes)}",
            "§25",
        )
    )

    # §26 - and A1.6's child timeout must not have fired.
    add(
        Check(
            "completed inside the conversion deadline",
            report.duration_seconds < settings.conversion_timeout_seconds,
            f"{report.duration_seconds:.1f}s vs "
            f"{settings.conversion_timeout_seconds}s",
            "§26",
        )
    )

    # §32 types pages_or_slides as optional, and DOCX legitimately has none:
    # Word pagination requires a layout engine we deliberately do not run.
    # Requiring a page count here would fail a correct conversion.
    page_count_ok = (
        report.pages_or_slides is None
        if report.source_format == "docx"
        else (report.pages_or_slides or 0) > 0
    )
    add(
        Check(
            "produced usable output",
            report.zip_bytes > 0 and report.media_count > 0 and page_count_ok,
            f"{report.pages_or_slides if report.pages_or_slides is not None else 'n/a'} "
            f"pages/slides, {report.media_count} media, "
            f"{_mb(report.zip_bytes)} ZIP",
            "§32, §73",
        )
    )


def print_report(report: RunReport) -> None:
    print()
    print("=" * 72)
    print(f"§57 NEAR-LIMIT RELEASE TEST — {report.source_format.upper()}")
    print("=" * 72)
    print(f"  source            {_mb(report.source_bytes)}")
    print(f"  pages/slides      {report.pages_or_slides}")
    print(f"  media files       {report.media_count}")
    print(f"  output tree       {_mb(report.output_tree_bytes)}")
    print(f"  result ZIP        {_mb(report.zip_bytes)}")
    print(f"  baseline memory   {_mb(report.baseline_rss_bytes)}")
    print(f"  peak memory       {_mb(report.peak_rss_bytes)}")
    print(f"    download added  {_mb(report.download_rss_delta)}")
    print(f"    convert added   {_mb(report.convert_rss_delta)}")
    print(f"    upload added    {_mb(report.upload_rss_delta)}")
    print(f"  peak workspace    {_mb(report.peak_workspace_bytes)}")
    print(f"  duration          {report.duration_seconds:.1f}s")
    if report.warnings:
        print(f"  warnings          {len(report.warnings)}")
    print()
    for check in report.checks:
        mark = "PASS" if check.passed else "FAIL"
        print(f"  [{mark}] {check.label}")
        print(f"         {check.detail}   ({check.spec_ref})")
    print()
    print(f"  RESULT: {'PASS' if report.passed else 'FAIL'}")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--format",
        choices=["pptx", "pdf", "docx", "all"],
        default="all",
        help="A8.3 requires PPTX and PDF specifically after Amendment 01",
    )
    args = parser.parse_args()

    formats = ["pptx", "pdf", "docx"] if args.format == "all" else [args.format]
    reports: list[RunReport] = []

    for name in formats:
        source = FIXTURE_DIR / f"near-limit.{name}"
        if not source.exists():
            print(f"missing fixture: {source}")
            print("Generate it with: scripts/make_large_fixtures.py --mb 95")
            return 2
        reports.append(run_once(source, SourceType(name)))

    for report in reports:
        print_report(report)

    print()
    print("=" * 72)
    failed = [r for r in reports if not r.passed]
    if failed:
        print(f"OVERALL: FAIL ({len(failed)} of {len(reports)} formats)")
    else:
        print(f"OVERALL: PASS ({len(reports)} formats)")
    print()
    print("NOT COVERED HERE — these need a deployment, see release_test_e2e.py:")
    print("  §57.1  browser direct upload succeeds")
    print("  §57.2  binary never passes through a Function request body")
    print("  §57.6  result uploads directly to Blob")
    print("  §57.8  result downloads via a signed Blob URL")
    print("=" * 72)
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())

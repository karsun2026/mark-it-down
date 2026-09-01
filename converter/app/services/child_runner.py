"""Run an in-process converter inside a killable child process (Amendment A1.6).

ENGINEERING_SPEC.md §26 gives the Pandoc subprocess its own timeout because a
subprocess can be *killed*. The PPTX and PDF converters are libraries running
in this process, so a pathological document can block past the §26 deadline
with no clean way to interrupt it. A timer cannot help: the blocking call never
yields.

The amendment identifies this for PPTX. It applies equally to PDF, whose A2.3
per-page table budget has the same un-interruptibility problem, so both
in-process engines run here. DOCX already shells out to Pandoc and does not.

Concurrency (§27, D-001): the child runs *inside* the parent's semaphore slot
and its workspace budget reservation, so it does not multiply the ceiling.
"""

from __future__ import annotations

import logging
import multiprocessing
import queue as queue_module
from dataclasses import dataclass
from multiprocessing.context import SpawnProcess
from pathlib import Path

from app.converters.base import ConversionResult
from app.errors import ConversionError, ErrorCode
from app.services.workspace import JobWorkspace

logger = logging.getLogger(__name__)

# How long to wait for a terminated child to actually die before escalating.
_TERMINATE_GRACE_SECONDS = 5.0
# How long to wait for the result object after the child reports completion.
_RESULT_DRAIN_SECONDS = 10.0


@dataclass(frozen=True)
class ChildRequest:
    """Everything the child needs. Must be picklable — paths, not objects."""

    job_id: str
    workspace_root: str
    source_path: str
    source_type: str
    output_stem: str


@dataclass(frozen=True)
class ChildOutcome:
    """Result or failure, flattened so it survives pickling."""

    ok: bool
    error_code: str | None = None
    markdown_path: str | None = None
    media_dir: str | None = None
    pages_or_slides: int | None = None
    media_count: int = 0
    warnings: tuple[str, ...] = ()


def _child_main(request: ChildRequest, result_queue) -> None:  # pragma: no cover
    """Entry point executed in the child process.

    Covered by the integration test rather than by line coverage: it never runs
    in the parent interpreter.
    """
    try:
        # Import inside the child so a spawn-started process picks these up
        # after its own module initialisation.
        from app.converters.router import converter_for
        from app.security.validation import SourceType

        workspace = JobWorkspace(
            request.job_id,
            reservation_bytes=0,
            root_override=Path(request.workspace_root),
        )
        converter = converter_for(
            SourceType(request.source_type), workspace, request.output_stem
        )
        result = converter.convert(Path(request.source_path))

        result_queue.put(
            ChildOutcome(
                ok=True,
                markdown_path=str(result.markdown_path),
                media_dir=str(result.media_dir),
                pages_or_slides=result.pages_or_slides,
                media_count=result.media_count,
                warnings=tuple(result.warnings),
            )
        )
    except ConversionError as exc:
        result_queue.put(ChildOutcome(ok=False, error_code=str(exc.code)))
    except BaseException as exc:  # noqa: BLE001 - the child must never hang
        # Type name only. The message may quote document content (§47).
        logger.info("child conversion failed: %s", type(exc).__name__)
        result_queue.put(
            ChildOutcome(ok=False, error_code=str(ErrorCode.CONVERSION_FAILED))
        )


def _kill(process: SpawnProcess) -> None:
    """Terminate, then escalate to SIGKILL if the child ignores it."""
    process.terminate()
    process.join(_TERMINATE_GRACE_SECONDS)
    if process.is_alive():
        logger.info("child ignored terminate; killing")
        process.kill()
        process.join(_TERMINATE_GRACE_SECONDS)


def run_conversion_in_child(
    *,
    workspace: JobWorkspace,
    source_path: Path,
    source_type: str,
    output_stem: str,
    timeout_seconds: float,
) -> ConversionResult:
    """Convert in a child process, killing it if it outruns `timeout_seconds`.

    On timeout the child is killed and CONVERSION_TIMEOUT is raised. A1.6 is
    explicit that no new error code is introduced — §46 stands as written.

    The workspace itself is cleaned up by the caller's context manager, so a
    killed child leaves no residue.
    """
    # "spawn" rather than "fork": it is the only start method available on
    # Windows, and it avoids inheriting a forked copy of the parent's threads
    # and open handles inside a request-serving process.
    context = multiprocessing.get_context("spawn")
    result_queue = context.Queue()

    request = ChildRequest(
        job_id=workspace.job_id,
        workspace_root=str(workspace.root),
        source_path=str(source_path),
        source_type=source_type,
        output_stem=output_stem,
    )

    process: SpawnProcess = context.Process(
        target=_child_main,
        args=(request, result_queue),
        daemon=True,
    )
    process.start()

    try:
        try:
            # Wait on the QUEUE, not on the process. A child that finished its
            # work but is slow to exit should still be treated as successful.
            outcome: ChildOutcome = result_queue.get(timeout=timeout_seconds)
        except queue_module.Empty:
            logger.info(
                "child exceeded %ss; killing job_id=%s",
                timeout_seconds,
                workspace.job_id,
            )
            _kill(process)
            raise ConversionError(
                ErrorCode.CONVERSION_TIMEOUT,
                internal_detail=f"child conversion exceeded {timeout_seconds}s",
            ) from None

        process.join(_RESULT_DRAIN_SECONDS)
        if process.is_alive():
            # Result already delivered; do not let a lingering child leak.
            _kill(process)
    finally:
        result_queue.close()
        if process.is_alive():
            _kill(process)

    if not outcome.ok:
        code = ErrorCode(outcome.error_code or ErrorCode.CONVERSION_FAILED)
        raise ConversionError(code, internal_detail="raised in child process")

    if outcome.markdown_path is None or outcome.media_dir is None:
        raise ConversionError(
            ErrorCode.CONVERSION_FAILED,
            internal_detail="child returned an incomplete result",
        )

    return ConversionResult(
        markdown_path=Path(outcome.markdown_path),
        media_dir=Path(outcome.media_dir),
        pages_or_slides=outcome.pages_or_slides,
        media_count=outcome.media_count,
        warnings=list(outcome.warnings),
    )

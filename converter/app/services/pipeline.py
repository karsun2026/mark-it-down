"""The local conversion sequence (ENGINEERING_SPEC.md §22, §66 steps 10-16).

Order matters and is fixed by §22:

    validate structure -> convert -> verify output quota
    -> delete local source -> create ZIP -> verify ZIP quota

Deleting the source before zipping is what keeps peak disk below the workspace
budget; it is not an optimisation.

This module is deliberately network-free. Downloading the source and uploading
the result belong to the Blob services in Phase 2, so the whole conversion core
stays testable without any network or platform dependency.
"""

from __future__ import annotations

import logging
import time
from dataclasses import dataclass
from pathlib import Path

from app.config import settings
from app.converters.router import converter_for
from app.errors import ConversionError, ErrorCode
from app.security.validation import (
    SourceType,
    inspect_office_archive,
    validate_source_file,
)
from app.services.child_runner import run_conversion_in_child
from app.services.packager import build_result_zip
from app.services.workspace import JobWorkspace

logger = logging.getLogger(__name__)

# Engines that run as libraries in this process and therefore cannot be
# interrupted without killing a process (Amendment A1.6). DOCX is absent
# because Pandoc is already a killable subprocess with its own timeout.
_CHILD_PROCESS_TYPES = frozenset({SourceType.PPTX, SourceType.PDF})


@dataclass(frozen=True)
class PipelineOutcome:
    """Everything the caller needs after a successful local conversion."""

    result_path: Path
    result_bytes: int
    result_content_type: str
    markdown_filename: str
    pages_or_slides: int | None
    media_count: int
    warnings: list[str]
    elapsed_ms: int


def run_conversion(
    *,
    workspace: JobWorkspace,
    source_path: Path,
    source_type: SourceType,
    output_stem: str,
    original_filename: str,
    include_media: bool = True,
) -> PipelineOutcome:
    """Convert one already-downloaded document into its deliverable.

    Two shapes, chosen by the user before the job starts:

      * Markdown only  -> a single `.md` file, delivered as-is
      * Markdown + media -> a `.zip` containing the `.md` and a `media/` folder

    Markdown-only genuinely skips image extraction rather than doing the work
    and discarding it, which on an image-heavy deck is most of the cost.
    """
    started = time.perf_counter()

    # 1. Real content validation, then archive safety for Office formats.
    validate_source_file(source_path, source_type)
    if source_type in (SourceType.DOCX, SourceType.PPTX):
        stats = inspect_office_archive(source_path)
        logger.info(
            "archive inspected: members=%d uncompressed=%d ratio=%.1f",
            stats.member_count,
            stats.uncompressed_bytes,
            stats.compression_ratio,
        )

    # 2. Convert.
    #
    # Amendment A1.6: the in-process engines (PPTX, PDF) run in a killable
    # child process with their own wall-clock timeout, because a library call
    # cannot be interrupted the way the Pandoc subprocess can. DOCX already
    # shells out to Pandoc with its own timeout, so it runs in-process here.
    if source_type in _CHILD_PROCESS_TYPES:
        result = run_conversion_in_child(
            workspace=workspace,
            source_path=source_path,
            source_type=str(source_type),
            output_stem=output_stem,
            timeout_seconds=settings.pptx_conversion_timeout_seconds,
            include_media=include_media,
        )
    else:
        converter = converter_for(
            source_type, workspace, output_stem, include_media
        )
        result = converter.convert(source_path)

    # 3. Output quota before anything else is written.
    output_bytes = workspace.enforce_output_quota()

    elapsed_ms = int((time.perf_counter() - started) * 1000)

    # 4. Drop the source before packaging to halve peak disk use (§22).
    workspace.delete_local_source()

    # 5. Deliver.
    #
    # No conversion report is written. It was required by §38/§39, but in real
    # use nobody opens it (DEVIATIONS D-014) - and a bare `.md` with a JSON
    # file bolted alongside would force a ZIP on users who asked not to have
    # one.
    if include_media and result.media_count > 0:
        result_path = build_result_zip(workspace, output_stem)
        content_type = "application/zip"
    else:
        # Markdown only: hand over the file itself. No archive to unpack, and
        # nothing for a ZIP tool to refuse.
        result_path = result.markdown_path
        content_type = "text/markdown; charset=utf-8"

    result_bytes = result_path.stat().st_size
    if result_bytes > settings.max_result_zip_bytes:
        raise ConversionError(
            ErrorCode.RESULT_TOO_LARGE,
            internal_detail=f"result {result_bytes} > {settings.max_result_zip_bytes}",
        )

    logger.info(
        "conversion complete: type=%s media=%s output_bytes=%d result_bytes=%d "
        "media_files=%d warnings=%d elapsed_ms=%d",
        source_type,
        include_media,
        output_bytes,
        result_bytes,
        result.media_count,
        len(result.warnings),
        elapsed_ms,
    )

    return PipelineOutcome(
        result_path=result_path,
        result_bytes=result_bytes,
        result_content_type=content_type,
        markdown_filename=result.markdown_path.name,
        pages_or_slides=result.pages_or_slides,
        media_count=result.media_count,
        warnings=result.warnings,
        elapsed_ms=elapsed_ms,
    )

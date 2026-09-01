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

from app.converters.router import converter_for
from app.security.validation import (
    SourceType,
    inspect_office_archive,
    validate_source_file,
)
from app.services.packager import build_result_zip
from app.services.report import build_report, write_report
from app.services.workspace import JobWorkspace

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class PipelineOutcome:
    """Everything the caller needs after a successful local conversion."""

    zip_path: Path
    zip_bytes: int
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
) -> PipelineOutcome:
    """Convert one already-downloaded document into a packaged result ZIP."""
    started = time.perf_counter()
    source_size = source_path.stat().st_size

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
    converter = converter_for(source_type, workspace, output_stem)
    result = converter.convert(source_path)

    # 3. Output quota before anything else is written.
    output_bytes = workspace.enforce_output_quota()

    elapsed_ms = int((time.perf_counter() - started) * 1000)

    # 4. Report joins the output tree so it is packaged with the Markdown.
    payload = build_report(
        source_filename=original_filename,
        source_type=source_type,
        source_size_bytes=source_size,
        markdown_filename=result.markdown_path.name,
        result=result,
        elapsed_ms=elapsed_ms,
    )
    write_report(workspace.output_dir, payload)

    # 5. Drop the source before zipping to halve peak disk use (§22).
    workspace.delete_local_source()

    # 6. Package and check the ZIP ceiling.
    zip_path = build_result_zip(workspace, output_stem)
    zip_bytes = zip_path.stat().st_size

    logger.info(
        "conversion complete: type=%s output_bytes=%d zip_bytes=%d "
        "media=%d warnings=%d elapsed_ms=%d",
        source_type,
        output_bytes,
        zip_bytes,
        result.media_count,
        len(result.warnings),
        elapsed_ms,
    )

    return PipelineOutcome(
        zip_path=zip_path,
        zip_bytes=zip_bytes,
        markdown_filename=result.markdown_path.name,
        pages_or_slides=result.pages_or_slides,
        media_count=result.media_count,
        warnings=result.warnings,
        elapsed_ms=elapsed_ms,
    )

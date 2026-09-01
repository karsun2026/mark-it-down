"""Build the result ZIP (ENGINEERING_SPEC.md §38).

Package layout:

    <stem>_markdown/
    |-- <stem>.md
    |-- conversion-report.json
    `-- media/

The original source document is deliberately excluded (§38), and the ZIP is
written to disk and streamed later rather than held in memory (§25).
"""

from __future__ import annotations

import logging
import zipfile
from pathlib import Path

from app.config import settings
from app.errors import ConversionError, ErrorCode
from app.services.workspace import JobWorkspace

logger = logging.getLogger(__name__)


def build_result_zip(workspace: JobWorkspace, stem: str) -> Path:
    """Zip the output tree and return the archive path.

    Raises RESULT_TOO_LARGE if the finished archive breaches §22's ceiling.
    """
    package_root = f"{stem}_markdown"
    zip_path = workspace.result_dir / f"{stem}_markdown.zip"
    workspace.assert_within(zip_path)
    zip_path.parent.mkdir(parents=True, exist_ok=True)

    output_dir = workspace.output_dir
    if not output_dir.is_dir():
        raise ConversionError(
            ErrorCode.CONVERSION_FAILED,
            internal_detail="output directory missing at packaging time",
        )

    members = sorted(
        (path for path in output_dir.rglob("*") if path.is_file()),
        key=lambda p: p.as_posix(),
    )
    if not members:
        raise ConversionError(
            ErrorCode.CONVERSION_FAILED,
            internal_detail="no output files to package",
        )

    written = 0
    try:
        with zipfile.ZipFile(
            zip_path, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=6
        ) as archive:
            for member in members:
                relative = member.relative_to(output_dir).as_posix()
                archive.write(member, arcname=f"{package_root}/{relative}")
                written += 1
    except OSError as exc:
        # A full disk lands here; surface it as an expansion failure rather
        # than letting the function die on ENOSPC (§23).
        zip_path.unlink(missing_ok=True)
        raise ConversionError(
            ErrorCode.DOCUMENT_EXPANDS_TOO_LARGE,
            internal_detail=f"zip write failed: errno={exc.errno}",
        ) from exc

    size = zip_path.stat().st_size
    if size > settings.max_result_zip_bytes:
        zip_path.unlink(missing_ok=True)
        raise ConversionError(
            ErrorCode.RESULT_TOO_LARGE,
            internal_detail=f"result zip {size} > {settings.max_result_zip_bytes}",
        )

    logger.info("packaged %d file(s) into result zip (%d bytes)", written, size)
    return zip_path

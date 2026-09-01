"""Runtime configuration, read from the environment once at import.

Defaults mirror ENGINEERING_SPEC.md §42, with one deliberate change recorded in
DEVIATIONS.md D-001: the workspace budget is a GLOBAL ceiling across all
in-flight jobs on this instance, and concurrency defaults to 1.

The spec's §22 pairing of a 425 MB budget with 2 concurrent conversions
oversubscribes a ~500 MB /tmp, because Vercel Fluid compute runs concurrent
invocations inside a single instance sharing a single disk.
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

MEGABYTE = 1024 * 1024


def _int_env(name: str, default: int) -> int:
    raw = os.environ.get(name)
    if raw is None or raw.strip() == "":
        return default
    try:
        return int(raw)
    except ValueError:
        return default


def _bool_env(name: str, default: bool) -> bool:
    raw = os.environ.get(name)
    if raw is None:
        return default
    return raw.strip().lower() in {"1", "true", "yes", "on"}


@dataclass(frozen=True)
class Settings:
    """Immutable snapshot of the converter's configuration."""

    app_env: str

    # Size ceilings (bytes)
    max_upload_bytes: int
    max_output_tree_bytes: int
    max_result_zip_bytes: int
    max_workspace_bytes: int

    # Office archive safety (§30)
    max_archive_members: int
    max_office_uncompressed_bytes: int
    max_compression_ratio: int

    # Time and concurrency (§26, §27)
    conversion_timeout_seconds: int
    pandoc_timeout_seconds: int
    max_local_concurrent_conversions: int

    # Filesystem
    workspace_root: Path
    pandoc_binary: str

    # Privacy (§47)
    log_filenames: bool

    @property
    def max_upload_mb(self) -> int:
        return self.max_upload_bytes // MEGABYTE


def _load() -> Settings:
    max_upload_mb = _int_env("MAX_UPLOAD_MB", 100)
    max_output_tree_mb = _int_env("MAX_OUTPUT_TREE_MB", 180)
    max_result_zip_mb = _int_env("MAX_RESULT_ZIP_MB", 180)

    # D-001: global, not per-job. Kept below the ~500 MB /tmp the spec assumes,
    # with headroom for the ZIP being written alongside the output tree.
    max_workspace_mb = _int_env("MAX_TMP_WORKSPACE_MB", 425)

    conversion_timeout = _int_env("CONVERSION_TIMEOUT_SECONDS", 690)

    return Settings(
        app_env=os.environ.get("APP_ENV", "development"),
        max_upload_bytes=max_upload_mb * MEGABYTE,
        max_output_tree_bytes=max_output_tree_mb * MEGABYTE,
        max_result_zip_bytes=max_result_zip_mb * MEGABYTE,
        max_workspace_bytes=max_workspace_mb * MEGABYTE,
        max_archive_members=_int_env("MAX_ARCHIVE_MEMBERS", 10_000),
        max_office_uncompressed_bytes=(
            _int_env("MAX_OFFICE_UNCOMPRESSED_MB", 350) * MEGABYTE
        ),
        max_compression_ratio=_int_env("MAX_COMPRESSION_RATIO", 100),
        conversion_timeout_seconds=conversion_timeout,
        # Pandoc must not be able to consume the whole job budget on its own.
        pandoc_timeout_seconds=_int_env(
            "PANDOC_TIMEOUT_SECONDS", max(60, conversion_timeout // 2)
        ),
        # D-001: 1, not the spec's 2.
        max_local_concurrent_conversions=_int_env(
            "MAX_LOCAL_CONCURRENT_CONVERSIONS", 1
        ),
        workspace_root=Path(
            os.environ.get("WORKSPACE_ROOT", "/tmp/doc2md")
        ).resolve(),
        pandoc_binary=os.environ.get("PANDOC_BIN", "pandoc"),
        log_filenames=_bool_env("LOG_FILENAMES", False),
    )


settings = _load()


def reload_settings() -> Settings:
    """Re-read the environment. Tests use this; runtime code should not."""
    global settings
    settings = _load()
    return settings

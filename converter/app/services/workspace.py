"""Per-job scratch space on /tmp, with a global disk budget.

ENGINEERING_SPEC.md §21 fixes the layout and §22 the quotas. DEVIATIONS.md
D-001 explains why the budget is enforced globally rather than per job:
Vercel Fluid compute runs concurrent invocations inside one instance sharing
one /tmp, so a per-job ceiling multiplied by the concurrency limit can
oversubscribe the disk.

`JobWorkspace` reserves its share of the global budget on entry and releases it
on exit, so raising MAX_LOCAL_CONCURRENT_CONVERSIONS can never oversubscribe.
"""

from __future__ import annotations

import logging
import shutil
import threading
from dataclasses import dataclass
from pathlib import Path
from types import TracebackType

from app.config import settings
from app.errors import ConversionError, ErrorCode

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class DiskProbe:
    """Measured capacity of the workspace filesystem.

    The spec's §4 assumption of a ~500 MB /tmp is not documented by Vercel, so
    it is measured at startup rather than trusted.
    """

    total_bytes: int
    free_bytes: int

    @property
    def total_mb(self) -> int:
        return self.total_bytes // (1024 * 1024)

    @property
    def free_mb(self) -> int:
        return self.free_bytes // (1024 * 1024)


def probe_disk(root: Path | None = None) -> DiskProbe:
    """Measure the filesystem backing the workspace root."""
    target = root or settings.workspace_root
    # Walk up to the nearest existing ancestor; the root may not exist yet.
    probe_target = target
    while not probe_target.exists() and probe_target != probe_target.parent:
        probe_target = probe_target.parent
    usage = shutil.disk_usage(probe_target)
    return DiskProbe(total_bytes=usage.total, free_bytes=usage.free)


class WorkspaceBudget:
    """Process-wide ledger of bytes reserved across all in-flight jobs."""

    def __init__(self, capacity_bytes: int) -> None:
        self._capacity = capacity_bytes
        self._reserved = 0
        self._lock = threading.Lock()

    @property
    def capacity_bytes(self) -> int:
        return self._capacity

    @property
    def reserved_bytes(self) -> int:
        with self._lock:
            return self._reserved

    @property
    def available_bytes(self) -> int:
        with self._lock:
            return self._capacity - self._reserved

    def reserve(self, amount: int) -> None:
        """Claim `amount` bytes, or refuse if the instance cannot afford it."""
        with self._lock:
            if self._reserved + amount > self._capacity:
                raise ConversionError(
                    ErrorCode.SERVICE_UNAVAILABLE,
                    internal_detail=(
                        f"workspace budget exhausted: reserved={self._reserved} "
                        f"requested={amount} capacity={self._capacity}"
                    ),
                )
            self._reserved += amount

    def release(self, amount: int) -> None:
        with self._lock:
            self._reserved = max(0, self._reserved - amount)


# One ledger per process. Sized from config, verified against the real disk.
budget = WorkspaceBudget(settings.max_workspace_bytes)


def directory_size(path: Path) -> int:
    """Total bytes of all regular files under `path`."""
    if not path.exists():
        return 0
    total = 0
    for entry in path.rglob("*"):
        if entry.is_file() and not entry.is_symlink():
            total += entry.stat().st_size
    return total


class JobWorkspace:
    """A quota-enforced scratch directory for one conversion.

    Layout follows §21:

        <root>/<job-id>/
        |-- source/
        |-- output/
        |   `-- media/
        `-- result/

    Used as a context manager; the tree is always removed on exit, including
    on failure, so a crashed job cannot strand bytes on a shared disk.
    """

    def __init__(self, job_id: str, reservation_bytes: int | None = None) -> None:
        self.job_id = job_id
        self.root = (settings.workspace_root / job_id).resolve()
        self._reservation = (
            reservation_bytes
            if reservation_bytes is not None
            else settings.max_workspace_bytes
        )
        self._entered = False

    # -- lifecycle ---------------------------------------------------------

    def __enter__(self) -> JobWorkspace:
        budget.reserve(self._reservation)
        self._entered = True
        try:
            for directory in (self.source_dir, self.media_dir, self.result_dir):
                directory.mkdir(parents=True, exist_ok=True)
        except Exception:
            budget.release(self._reservation)
            self._entered = False
            raise
        return self

    def __exit__(
        self,
        exc_type: type[BaseException] | None,
        exc: BaseException | None,
        tb: TracebackType | None,
    ) -> None:
        self.cleanup()

    def cleanup(self) -> None:
        """Remove the tree and release the reservation. Safe to call twice."""
        shutil.rmtree(self.root, ignore_errors=True)
        if self._entered:
            budget.release(self._reservation)
            self._entered = False

    # -- paths -------------------------------------------------------------

    @property
    def source_dir(self) -> Path:
        return self.root / "source"

    @property
    def output_dir(self) -> Path:
        return self.root / "output"

    @property
    def media_dir(self) -> Path:
        return self.output_dir / "media"

    @property
    def result_dir(self) -> Path:
        return self.root / "result"

    def source_path(self, extension: str) -> Path:
        return self.source_dir / f"input{extension}"

    def markdown_path(self, stem: str) -> Path:
        return self.output_dir / f"{stem}.md"

    # -- guards ------------------------------------------------------------

    def contains(self, path: Path) -> bool:
        """True when `path` is inside this workspace (§21: no outside writes)."""
        try:
            resolved = path.resolve()
        except OSError:
            return False
        return resolved == self.root or self.root in resolved.parents

    def assert_within(self, path: Path) -> Path:
        """Raise unless `path` is inside this workspace."""
        if not self.contains(path):
            raise ConversionError(
                ErrorCode.CONVERSION_FAILED,
                internal_detail="attempted write outside job workspace",
            )
        return path

    def output_bytes(self) -> int:
        return directory_size(self.output_dir)

    def enforce_output_quota(self) -> int:
        """Fail with DOCUMENT_EXPANDS_TOO_LARGE if the output tree is too big."""
        size = self.output_bytes()
        if size > settings.max_output_tree_bytes:
            raise ConversionError(
                ErrorCode.DOCUMENT_EXPANDS_TOO_LARGE,
                internal_detail=(
                    f"output tree {size} > {settings.max_output_tree_bytes}"
                ),
            )
        return size

    def delete_local_source(self) -> None:
        """Drop the source before zipping, per §22, to halve peak disk use."""
        shutil.rmtree(self.source_dir, ignore_errors=True)


def log_startup_capacity() -> DiskProbe:
    """Log measured disk capacity against the configured budget.

    Emits a warning when the configured budget exceeds what the disk can
    actually provide - the condition D-001 exists to prevent.
    """
    probe = probe_disk()
    logger.info(
        "workspace disk probe: total=%dMB free=%dMB budget=%dMB concurrency=%d",
        probe.total_mb,
        probe.free_mb,
        settings.max_workspace_bytes // (1024 * 1024),
        settings.max_local_concurrent_conversions,
    )
    if settings.max_workspace_bytes > probe.free_bytes:
        logger.warning(
            "configured workspace budget (%dMB) exceeds free disk (%dMB); "
            "lower MAX_TMP_WORKSPACE_MB",
            settings.max_workspace_bytes // (1024 * 1024),
            probe.free_mb,
        )
    return probe

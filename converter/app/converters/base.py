"""Shared converter interface and media handling.

ENGINEERING_SPEC.md §32 defines `ConversionResult` and the converter contract.

`MediaWriter` adds content-addressed de-duplication, which the spec does not
require but which matters at the 100 MB ceiling: a deck with a logo on every
master would otherwise write one copy of that image per slide and can exhaust
the §22 output budget on redundant bytes alone.
"""

from __future__ import annotations

import hashlib
import logging
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from pathlib import Path

from app.config import settings
from app.errors import ConversionError, ErrorCode
from app.services.workspace import JobWorkspace

logger = logging.getLogger(__name__)

# Extension by image signature, so media files are named honestly regardless of
# what the container claimed.
_IMAGE_SIGNATURES: tuple[tuple[bytes, str], ...] = (
    (b"\x89PNG\r\n\x1a\n", ".png"),
    (b"\xff\xd8\xff", ".jpg"),
    (b"GIF87a", ".gif"),
    (b"GIF89a", ".gif"),
    (b"BM", ".bmp"),
    (b"II*\x00", ".tiff"),
    (b"MM\x00*", ".tiff"),
)


def sniff_image_extension(data: bytes, fallback: str = ".png") -> str:
    """Best-effort image extension from magic bytes."""
    for signature, extension in _IMAGE_SIGNATURES:
        if data.startswith(signature):
            return extension
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return ".webp"
    return fallback


@dataclass
class ConversionResult:
    """The §32 contract returned by every converter."""

    markdown_path: Path
    media_dir: Path
    pages_or_slides: int | None
    media_count: int
    warnings: list[str] = field(default_factory=list)


class MediaWriter:
    """Writes extracted images into the workspace `media/` directory.

    De-duplicates by SHA-256 of the bytes, so repeated images (logos,
    backgrounds, watermarks) are stored once and referenced many times.
    """

    def __init__(self, workspace: JobWorkspace) -> None:
        self._workspace = workspace
        self._media_dir = workspace.media_dir
        self._by_digest: dict[str, str] = {}
        self._bytes_written = 0
        self._names_used: set[str] = set()

    @property
    def count(self) -> int:
        """Number of distinct media files on disk."""
        return len(self._by_digest)

    @property
    def bytes_written(self) -> int:
        return self._bytes_written

    def _unique_name(self, preferred: str) -> str:
        if preferred not in self._names_used:
            return preferred
        stem, _, extension = preferred.rpartition(".")
        counter = 2
        while True:
            candidate = f"{stem}-{counter}.{extension}"
            if candidate not in self._names_used:
                return candidate
            counter += 1

    def write(self, data: bytes, preferred_name: str) -> str:
        """Store `data` and return its workspace-relative Markdown path.

        Returns an existing path when these exact bytes were already written.
        """
        digest = hashlib.sha256(data).hexdigest()
        existing = self._by_digest.get(digest)
        if existing is not None:
            return existing

        # Guard the output budget as we go, so a runaway document fails fast
        # rather than after writing hundreds of megabytes.
        if self._bytes_written + len(data) > settings.max_output_tree_bytes:
            raise ConversionError(
                ErrorCode.DOCUMENT_EXPANDS_TOO_LARGE,
                internal_detail=(
                    f"media budget exceeded at {self._bytes_written + len(data)}"
                ),
            )

        name = self._unique_name(preferred_name)
        destination = self._media_dir / name
        self._workspace.assert_within(destination)
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_bytes(data)

        self._names_used.add(name)
        self._bytes_written += len(data)
        relative = f"media/{name}"
        self._by_digest[digest] = relative
        return relative


class BaseConverter(ABC):
    """Converts one validated source document into Markdown plus media."""

    source_label: str

    def __init__(
        self,
        workspace: JobWorkspace,
        output_stem: str,
        include_media: bool = True,
    ) -> None:
        self.workspace = workspace
        self.output_stem = output_stem
        self.warnings: list[str] = []
        self.media = MediaWriter(workspace)
        # When the user asked for Markdown only, images are never decoded or
        # written at all. Extracting them and then discarding them would waste
        # the majority of the time and disk a large deck costs.
        self.include_media = include_media
        self.skipped_media = 0

    def note_skipped_media(self) -> None:
        """Count an image we deliberately did not extract."""
        self.skipped_media += 1

    def warn(self, message: str) -> None:
        """Record a non-fatal problem.

        Warnings are shown to the user, so they must never contain document
        text, absolute paths, or library internals (§39, §47).
        """
        if message not in self.warnings:
            self.warnings.append(message)

    @abstractmethod
    def convert(self, source_path: Path) -> ConversionResult:
        """Produce Markdown and media from `source_path`."""

    # -- helpers shared by the concrete converters -------------------------

    def _write_markdown(self, blocks: list[str]) -> Path:
        """Write the Markdown document per the §37 output contract.

        UTF-8, LF endings, no trailing whitespace runs.
        """
        markdown_path = self.workspace.markdown_path(self.output_stem)
        self.workspace.assert_within(markdown_path)
        markdown_path.parent.mkdir(parents=True, exist_ok=True)

        body = "\n\n".join(block.strip() for block in blocks if block.strip())
        if not body.endswith("\n"):
            body += "\n"

        # newline="\n" keeps LF endings even when running on Windows.
        with markdown_path.open("w", encoding="utf-8", newline="\n") as handle:
            handle.write(body)
        return markdown_path

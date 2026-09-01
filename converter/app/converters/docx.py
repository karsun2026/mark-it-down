"""DOCX -> Markdown via Pandoc (ENGINEERING_SPEC.md §33).

Pandoc runs as a subprocess with an argument array and its own timeout. §33 and
§45 forbid `shell=True` with user input, so no argument is ever interpolated
into a shell string; the source path is one the workspace generated, never the
uploaded filename.

Pandoc writes extracted media beneath `--extract-media`, using paths that are
relative but sometimes prefixed with the extraction root. `_normalise_media_paths`
rewrites them to the `media/...` form the §37 output contract requires.
"""

from __future__ import annotations

import logging
import re
import shutil
import subprocess
from pathlib import Path

from app.config import settings
from app.converters.base import BaseConverter, ConversionResult
from app.errors import ConversionError, ErrorCode

logger = logging.getLogger(__name__)

# Pandoc emits images in TWO forms when targeting gfm:
#   * Markdown - ![alt](target)
#   * raw HTML - <img src="target" style="width:1in;..." /> whenever the image
#     carries sizing attributes, which Word images almost always do.
# Handling only the Markdown form leaves absolute paths in the output and
# undercounts media, so both are rewritten.
_MEDIA_REFERENCE = re.compile(r"(!\[[^\]]*\]\()([^)]+)(\))")
_IMG_TAG = re.compile(r"<img\b[^>]*?>", re.IGNORECASE | re.DOTALL)
_IMG_SRC = re.compile(r"""\bsrc\s*=\s*["']([^"']+)["']""", re.IGNORECASE)
_IMG_ALT = re.compile(r"""\balt\s*=\s*["']([^"']*)["']""", re.IGNORECASE)


def pandoc_available() -> bool:
    """True when the configured Pandoc binary is on PATH."""
    return shutil.which(settings.pandoc_binary) is not None


def pandoc_version() -> str | None:
    """First line of `pandoc --version`, or None when unavailable."""
    if not pandoc_available():
        return None
    try:
        completed = subprocess.run(  # noqa: S603 - fixed argv, no shell
            [settings.pandoc_binary, "--version"],
            capture_output=True,
            text=True,
            timeout=15,
            check=False,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    if completed.returncode != 0:
        return None
    return completed.stdout.splitlines()[0].strip() if completed.stdout else None


class DocxConverter(BaseConverter):
    source_label = "docx"

    def convert(self, source_path: Path) -> ConversionResult:
        if not pandoc_available():
            raise ConversionError(
                ErrorCode.SERVICE_UNAVAILABLE,
                internal_detail="pandoc binary not found",
            )

        markdown_path = self.workspace.markdown_path(self.output_stem)
        self.workspace.assert_within(markdown_path)
        markdown_path.parent.mkdir(parents=True, exist_ok=True)

        self._run_pandoc(source_path, markdown_path)
        media_count = self._normalise_media_paths(markdown_path)

        return ConversionResult(
            markdown_path=markdown_path,
            media_dir=self.workspace.media_dir,
            pages_or_slides=None,  # DOCX has no reliable page count without layout
            media_count=media_count,
            warnings=self.warnings,
        )

    # -- pandoc ------------------------------------------------------------

    def _run_pandoc(self, source_path: Path, markdown_path: Path) -> None:
        # Argument array only. Never a shell string (§33, §45).
        argv = [
            settings.pandoc_binary,
            "--from=docx",
            "--to=gfm",
            "--wrap=none",
            # A RELATIVE extraction root, resolved against cwd below. Passing an
            # absolute path makes Pandoc emit absolute src attributes, which
            # §37 forbids outright.
            "--extract-media=.",
            f"--output={markdown_path}",
            str(source_path),
        ]

        try:
            completed = subprocess.run(  # noqa: S603 - fixed argv, no shell
                argv,
                capture_output=True,
                text=True,
                timeout=settings.pandoc_timeout_seconds,
                check=False,
                cwd=str(self.workspace.output_dir),
            )
        except subprocess.TimeoutExpired as exc:
            raise ConversionError(
                ErrorCode.CONVERSION_TIMEOUT,
                internal_detail="pandoc timed out",
            ) from exc
        except OSError as exc:
            raise ConversionError(
                ErrorCode.SERVICE_UNAVAILABLE,
                internal_detail=f"pandoc could not be started: {exc.errno}",
            ) from exc

        if completed.returncode != 0:
            # stderr may quote document content, so it is never returned to the
            # client and only its shape is logged.
            logger.info(
                "pandoc failed rc=%s stderr_len=%s",
                completed.returncode,
                len(completed.stderr or ""),
            )
            raise ConversionError(
                ErrorCode.CONVERSION_FAILED,
                internal_detail=f"pandoc rc={completed.returncode}",
            )

        if not markdown_path.exists():
            raise ConversionError(
                ErrorCode.CONVERSION_FAILED,
                internal_detail="pandoc produced no output file",
            )

    # -- media -------------------------------------------------------------

    def _normalise_media_paths(self, markdown_path: Path) -> int:
        """Rewrite Pandoc's media references to relative `media/...` paths.

        Pandoc emits references like `media/image1.png` but, depending on
        version and extraction root, may emit an absolute path or one prefixed
        with the output directory. Any of those would violate §37, which
        forbids absolute paths and requires forward slashes.
        """
        text = markdown_path.read_text(encoding="utf-8")
        referenced: set[str] = set()

        def rewrite_markdown(match: re.Match[str]) -> str:
            prefix, target, suffix = match.groups()
            normalised = self._normalise_one(target)
            if normalised is None:
                return match.group(0)
            referenced.add(normalised)
            return f"{prefix}{normalised}{suffix}"

        def rewrite_img_tag(match: re.Match[str]) -> str:
            tag = match.group(0)
            src_match = _IMG_SRC.search(tag)
            if src_match is None:
                return tag
            normalised = self._normalise_one(src_match.group(1))
            if normalised is None:
                return tag
            referenced.add(normalised)

            alt_match = _IMG_ALT.search(tag)
            alt = (alt_match.group(1).strip() if alt_match else "") or "Image"
            # Replace the tag entirely: portable Markdown beats inline HTML, and
            # the dropped style attributes carry no meaning in Markdown anyway.
            return f"![{alt}]({normalised})"

        rewritten = _IMG_TAG.sub(rewrite_img_tag, text)
        rewritten = _MEDIA_REFERENCE.sub(rewrite_markdown, rewritten)

        with markdown_path.open("w", encoding="utf-8", newline="\n") as handle:
            handle.write(rewritten)

        # Count what actually exists on disk rather than what is referenced, so
        # a dangling link cannot inflate the conversion report.
        return sum(
            1
            for name in referenced
            if (self.workspace.output_dir / name).is_file()
        )

    def _normalise_one(self, target: str) -> str | None:
        """Return a workspace-relative `media/...` path, or None to leave as-is."""
        if target.startswith(("http://", "https://", "data:", "#")):
            return None

        candidate = target.replace("\\", "/")

        # Absolute or output-dir-prefixed paths: keep only the media/ tail.
        # Match a whole path SEGMENT - a substring search treats "notmedia/x.png"
        # as a media reference and silently rewrites an unrelated link.
        segments = [part for part in candidate.split("/") if part not in ("", ".")]
        try:
            index = len(segments) - 1 - segments[::-1].index("media")
        except ValueError:
            return None
        return "/".join(segments[index:])

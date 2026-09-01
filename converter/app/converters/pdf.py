"""PDF -> Markdown (ENGINEERING_SPEC.md §35, §36).

PyMuPDF and PyMuPDF4LLM are excluded by §35 and §51 (AGPL). Per DEVIATIONS.md
D-003 this uses two permissively licensed libraries together:

  * pdfplumber (MIT, on pdfminer.six) - text with layout awareness, and table
    detection, which pypdf does not provide at all;
  * pypdf (BSD) - page count, encryption detection and image XObjects.

Text is extracted verbatim. Nothing is rewritten, reordered beyond reading
order, or summarised - there is no model in this path.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import pdfplumber
import pypdf

from app.converters.base import BaseConverter, ConversionResult, sniff_image_extension
from app.errors import ConversionError, ErrorCode

logger = logging.getLogger(__name__)

# §36 scanned-page heuristic. BOTH conditions must hold: almost no extractable
# text, AND imagery covering most of the page. Testing text alone flags any
# short page that happens to contain a small figure.
MIN_CHARS_FOR_TEXT_PAGE = 40
MIN_IMAGE_COVERAGE_FOR_SCAN = 0.5


@dataclass(frozen=True)
class PageExtract:
    """What one page yielded, plus the signal the scan heuristic needs."""

    text: str
    tables: list[str]
    image_coverage: float


def _image_coverage(page: Any) -> float:
    """Fraction of the page area covered by image objects, clamped to 1.0.

    Overlapping images are summed rather than unioned; that only ever
    overstates coverage, and the heuristic requires a high value anyway.
    """
    try:
        width = float(page.width)
        height = float(page.height)
        images = page.images or []
    except (AttributeError, TypeError, ValueError):
        return 0.0

    page_area = width * height
    if page_area <= 0:
        return 0.0

    covered = 0.0
    for image in images:
        try:
            image_width = abs(float(image["x1"]) - float(image["x0"]))
            image_height = abs(float(image["bottom"]) - float(image["top"]))
        except (KeyError, TypeError, ValueError):
            continue
        covered += image_width * image_height

    return min(covered / page_area, 1.0)


def _clean_text(raw: str) -> str:
    """Normalise whitespace without altering wording."""
    lines = [line.rstrip() for line in raw.splitlines()]
    cleaned: list[str] = []
    blank_run = 0
    for line in lines:
        if line.strip():
            blank_run = 0
            cleaned.append(line)
        else:
            blank_run += 1
            if blank_run == 1:
                cleaned.append("")
    return "\n".join(cleaned).strip()


def _escape_cell(value: str | None) -> str:
    if not value:
        return ""
    return value.replace("|", "\\|").replace("\n", " ").strip()


def _table_to_markdown(table: list[list[str | None]]) -> str:
    rows = [row for row in table if row and any(cell for cell in row)]
    if not rows:
        return ""

    width = max(len(row) for row in rows)
    normalised = [
        [_escape_cell(cell) for cell in row] + [""] * (width - len(row))
        for row in rows
    ]

    header, *body = normalised
    # A table whose first row is empty reads better with a placeholder header.
    if not any(header):
        header = [f"Column {i + 1}" for i in range(width)]

    lines = [
        "| " + " | ".join(header) + " |",
        "| " + " | ".join(["---"] * width) + " |",
    ]
    lines.extend("| " + " | ".join(row) + " |" for row in body)
    return "\n".join(lines)


class PdfConverter(BaseConverter):
    source_label = "pdf"

    def convert(self, source_path: Path) -> ConversionResult:
        reader = self._open_reader(source_path)
        page_count = len(reader.pages)

        blocks: list[str] = []
        # Open the document once. Opening per page would reparse the whole file
        # for every page, which is quadratic on a large PDF.
        try:
            with pdfplumber.open(str(source_path)) as document:
                for index in range(page_count):
                    blocks.extend(self._convert_page(document, reader, index))
        except ConversionError:
            raise
        except Exception as exc:  # noqa: BLE001 - pdfminer raises many types
            raise ConversionError(
                ErrorCode.CONVERSION_FAILED,
                internal_detail=f"pdfplumber open failed: {type(exc).__name__}",
            ) from exc

        markdown_path = self._write_markdown(blocks)

        return ConversionResult(
            markdown_path=markdown_path,
            media_dir=self.workspace.media_dir,
            pages_or_slides=page_count,
            media_count=self.media.count,
            warnings=self.warnings,
        )

    # -- opening -----------------------------------------------------------

    def _open_reader(self, source_path: Path) -> pypdf.PdfReader:
        try:
            reader = pypdf.PdfReader(str(source_path))
        except Exception as exc:  # noqa: BLE001 - pypdf raises many types
            raise ConversionError(
                ErrorCode.INVALID_FILE_FORMAT,
                internal_detail=f"pypdf open failed: {type(exc).__name__}",
            ) from exc

        if reader.is_encrypted:
            # An empty user password is common and legitimately decryptable;
            # anything else needs a password we do not have.
            try:
                if reader.decrypt("") == 0:
                    raise ConversionError(ErrorCode.PASSWORD_PROTECTED)
            except ConversionError:
                raise
            except Exception as exc:  # noqa: BLE001
                raise ConversionError(
                    ErrorCode.PASSWORD_PROTECTED,
                    internal_detail=f"decrypt failed: {type(exc).__name__}",
                ) from exc

        return reader

    # -- per page ----------------------------------------------------------

    def _convert_page(
        self,
        document: Any,
        reader: pypdf.PdfReader,
        index: int,
    ) -> list[str]:
        number = index + 1
        blocks: list[str] = []
        if index > 0:
            blocks.append("---")
        blocks.append(f"## Page {number}")

        extract = self._extract_text_and_tables(document, index)
        if extract.text:
            blocks.append(extract.text)
        blocks.extend(extract.tables)

        images = self._extract_images(reader, index)
        blocks.extend(images)

        if self._looks_scanned(extract, images):
            self.warn(
                f"Page {number} may be scanned or image-based. Text extraction "
                "may be incomplete."
            )

        return blocks

    def _extract_text_and_tables(self, document: Any, index: int) -> PageExtract:
        try:
            page = document.pages[index]
            raw_text = page.extract_text() or ""
            raw_tables = page.extract_tables() or []
            coverage = _image_coverage(page)
            # pdfplumber caches per-page layout objects; release them so peak
            # memory stays flat across a long document.
            page.flush_cache()
        except Exception as exc:  # noqa: BLE001 - continue with what we have
            self.warn(
                f"Page {index + 1} text could not be fully extracted."
            )
            logger.info("pdfplumber failed on page: %s", type(exc).__name__)
            return PageExtract(text="", tables=[], image_coverage=0.0)

        tables = [
            markdown
            for markdown in (_table_to_markdown(table) for table in raw_tables)
            if markdown
        ]
        return PageExtract(
            text=_clean_text(raw_text),
            tables=tables,
            image_coverage=coverage,
        )

    def _extract_images(self, reader: pypdf.PdfReader, index: int) -> list[str]:
        number = index + 1
        blocks: list[str] = []
        try:
            page_images = list(reader.pages[index].images)
        except Exception as exc:  # noqa: BLE001 - malformed XObject tables
            self.warn(f"Page {number} images could not be read.")
            logger.info("pypdf image listing failed: %s", type(exc).__name__)
            return []

        for position, image in enumerate(page_images, start=1):
            try:
                data = image.data
            except Exception as exc:  # noqa: BLE001 - unsupported codec
                # §35: one bad image warns and continues, it does not fail the job.
                self.warn(
                    f"Page {number} contains an image that could not be extracted."
                )
                logger.info("image decode failed: %s", type(exc).__name__)
                continue

            if not data:
                continue

            extension = sniff_image_extension(data)
            name = f"page-{number:03d}-image-{position:03d}{extension}"
            relative = self.media.write(data, name)
            blocks.append(f"![Page {number} image]({relative})")

        return blocks

    def _looks_scanned(self, extract: PageExtract, image_blocks: list[str]) -> bool:
        """§36 heuristic - very little text AND imagery dominating the page."""
        if not image_blocks:
            return False
        if len(extract.text.strip()) >= MIN_CHARS_FOR_TEXT_PAGE:
            return False
        return extract.image_coverage >= MIN_IMAGE_COVERAGE_FOR_SCAN

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

import contextlib
import logging
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import pdfplumber
import pypdf

from app.config import settings
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

    # A2.3 table budget state, reset per document in convert().
    _tables_enabled: bool = True
    _table_seconds_used: float = 0.0
    _table_budget_seconds: float = 0.0

    def convert(self, source_path: Path) -> ConversionResult:
        reader = self._open_reader(source_path)
        page_count = len(reader.pages)

        # A2.3 budgets, established once per document.
        self._table_seconds_used = 0.0
        self._table_budget_seconds = float(
            max(
                0,
                settings.conversion_timeout_seconds
                - settings.pdf_table_deadline_reserve_seconds,
            )
        )
        self._tables_enabled = settings.pdf_table_extraction

        if self._tables_enabled and page_count > settings.pdf_table_max_pages:
            self._tables_enabled = False
            self.warn(
                "Table extraction was skipped because the document exceeds "
                "the page budget."
            )

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
            coverage = _image_coverage(page)
        except Exception as exc:  # noqa: BLE001 - continue with what we have
            self.warn(f"Page {index + 1} text could not be fully extracted.")
            logger.info("pdfplumber failed on page: %s", type(exc).__name__)
            return PageExtract(text="", tables=[], image_coverage=0.0)

        # A2.3: tables are the degradable feature. Text and images are never
        # skipped, so table extraction is attempted only within budget and
        # anything that goes wrong warns instead of failing the job.
        tables = self._extract_tables_within_budget(page, index)

        # pdfplumber caches per-page layout objects; release them so peak
        # memory stays flat across a long document. Best effort: a failure to
        # release cache must not fail a conversion that already succeeded.
        with contextlib.suppress(Exception):
            page.flush_cache()

        return PageExtract(
            text=_clean_text(raw_text),
            tables=tables,
            image_coverage=coverage,
        )

    def _extract_tables_within_budget(self, page: Any, index: int) -> list[str]:
        """Extract tables from one page, honouring the A2.3 budgets.

        Note on the per-page timeout: `extract_tables()` is a single blocking
        call, so it cannot be pre-empted from inside this process. The budget
        is therefore enforced by MEASURING each page and discarding the result
        of one that overran, rather than by interrupting it. The hard stop is
        the A1.6 child-process timeout wrapping the whole conversion.
        """
        if not self._tables_enabled:
            return []

        number = index + 1
        started = time.perf_counter()
        try:
            raw_tables = page.extract_tables() or []
        except Exception as exc:  # noqa: BLE001 - never fail a job for a table
            self.warn(f"Page {number} tables could not be extracted.")
            logger.info("table extraction failed: %s", type(exc).__name__)
            return []

        elapsed = time.perf_counter() - started
        self._table_seconds_used += elapsed

        if elapsed > settings.pdf_table_page_timeout_seconds:
            self.warn(
                f"Table extraction on page {number} exceeded its time budget "
                "and was skipped."
            )
            return []

        if self._table_seconds_used > self._table_budget_seconds:
            # Stop spending the §26 deadline on a degradable feature.
            self._tables_enabled = False
            self.warn(
                "Table extraction was stopped early to stay within the "
                "conversion time limit."
            )
            return []

        return [
            markdown
            for markdown in (_table_to_markdown(table) for table in raw_tables)
            if markdown
        ]

    def _extract_images(self, reader: pypdf.PdfReader, index: int) -> list[str]:
        number = index + 1
        blocks: list[str] = []

        if not self.include_media:
            # Markdown only: skip the XObject walk entirely. On an image-heavy
            # PDF this is most of the work.
            with contextlib.suppress(Exception):
                self.skipped_media += len(reader.pages[index].images)
            return []
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

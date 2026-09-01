"""PDF conversion tests (ENGINEERING_SPEC.md §35, §36, §56)."""

from __future__ import annotations

import pytest

from app.converters.pdf import (
    MIN_CHARS_FOR_TEXT_PAGE,
    MIN_IMAGE_COVERAGE_FOR_SCAN,
    PageExtract,
    PdfConverter,
    _table_to_markdown,
)


@pytest.fixture
def convert(workspace, fixture_path):
    def _convert(name: str):
        source = workspace.source_path(".pdf")
        source.write_bytes(fixture_path(name).read_bytes())
        converter = PdfConverter(workspace, output_stem="doc")
        result = converter.convert(source)
        return result, result.markdown_path.read_text(encoding="utf-8")

    return _convert


class TestPageStructure:
    def test_pages_are_numbered_headings(self, convert) -> None:
        result, text = convert("multipage.pdf")
        assert "## Page 1" in text
        assert "## Page 3" in text
        assert result.pages_or_slides == 3

    def test_pages_separated_by_rule(self, convert) -> None:
        _, text = convert("multipage.pdf")
        assert text.count("\n---\n") == 2

    def test_text_extracted_verbatim(self, convert) -> None:
        """§35 forbids rewriting or summarising extracted text."""
        _, text = convert("text.pdf")
        assert "This document describes the addressable market." in text
        assert "Growth is projected across three segments." in text

    def test_page_content_stays_with_its_page(self, convert) -> None:
        _, text = convert("multipage.pdf")
        page_two = text.split("## Page 2")[1].split("## Page 3")[0]
        assert "belonging to page 2" in page_two
        assert "belonging to page 3" not in page_two


class TestImages:
    def test_images_extracted_with_relative_paths(self, convert, workspace) -> None:
        result, text = convert("images.pdf")
        assert result.media_count == 1
        assert "](media/page-001-image-001" in text
        assert list(workspace.media_dir.glob("*"))


class TestScannedHeuristic:
    """§36 - flag likely scans without flagging ordinary illustrated pages."""

    def test_image_only_page_is_flagged(self, convert) -> None:
        result, _ = convert("scanned-like.pdf")
        assert any("scanned or image-based" in w for w in result.warnings)

    def test_text_page_with_small_image_is_not_flagged(self, convert) -> None:
        """Regression: testing text length alone false-positived here."""
        result, _ = convert("images.pdf")
        assert not any("scanned or image-based" in w for w in result.warnings)

    def test_plain_text_page_is_not_flagged(self, convert) -> None:
        result, _ = convert("text.pdf")
        assert result.warnings == []

    @pytest.mark.parametrize(
        ("chars", "coverage", "has_image", "expected"),
        [
            (0, 0.9, True, True),      # blank page dominated by one image
            (0, 0.1, True, False),     # tiny image, no text - not a scan
            (500, 0.9, True, False),   # full page image behind real text
            (0, 0.9, False, False),    # no image at all
        ],
    )
    def test_heuristic_requires_both_signals(
        self, workspace, chars, coverage, has_image, expected
    ) -> None:
        converter = PdfConverter(workspace, output_stem="doc")
        extract = PageExtract(
            text="x" * chars, tables=[], image_coverage=coverage
        )
        blocks = ["![img](media/a.png)"] if has_image else []
        assert converter._looks_scanned(extract, blocks) is expected

    def test_thresholds_are_sane(self) -> None:
        assert MIN_CHARS_FOR_TEXT_PAGE > 0
        assert 0 < MIN_IMAGE_COVERAGE_FOR_SCAN <= 1


class TestTableRendering:
    def test_table_becomes_github_markdown(self) -> None:
        markdown = _table_to_markdown([["A", "B"], ["1", "2"]])
        assert markdown.splitlines()[0] == "| A | B |"
        assert markdown.splitlines()[1] == "| --- | --- |"

    def test_pipes_in_cells_are_escaped(self) -> None:
        markdown = _table_to_markdown([["a|b", "c"], ["1", "2"]])
        assert "a\\|b" in markdown

    def test_ragged_rows_are_padded(self) -> None:
        markdown = _table_to_markdown([["A", "B", "C"], ["1"]])
        assert markdown.splitlines()[-1].count("|") == 4

    def test_none_cells_render_empty(self) -> None:
        markdown = _table_to_markdown([["A", None], ["1", "2"]])
        assert "| A |  |" in markdown

    def test_empty_table_returns_empty(self) -> None:
        assert _table_to_markdown([]) == ""
        assert _table_to_markdown([[None, None]]) == ""


class TestOutputContract:
    def test_markdown_is_utf8_lf_and_leaks_no_paths(self, convert, workspace) -> None:
        result, text = convert("multipage.pdf")
        raw = result.markdown_path.read_bytes()

        raw.decode("utf-8")
        assert b"\r\n" not in raw
        assert "/tmp" not in text
        assert "C:\\" not in text
        assert str(workspace.root) not in text

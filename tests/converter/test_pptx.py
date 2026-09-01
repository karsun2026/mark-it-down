"""PPTX conversion tests (ENGINEERING_SPEC.md §34, §37, §56)."""

from __future__ import annotations

import pytest

from app.converters.pptx import PptxConverter


@pytest.fixture
def convert(workspace, fixture_path):
    def _convert(name: str):
        source = workspace.source_path(".pptx")
        source.write_bytes(fixture_path(name).read_bytes())
        converter = PptxConverter(workspace, output_stem="deck")
        result = converter.convert(source)
        return result, result.markdown_path.read_text(encoding="utf-8")

    return _convert


class TestSlideStructure:
    def test_slides_are_numbered_headings(self, convert) -> None:
        result, text = convert("text-only.pptx")
        assert "## Slide 1 — Strategy Overview" in text
        assert "## Slide 2 — Next Steps" in text
        assert result.pages_or_slides == 2

    def test_slides_separated_by_rule(self, convert) -> None:
        _, text = convert("text-only.pptx")
        assert "\n---\n" in text

    def test_no_separator_before_first_slide(self, convert) -> None:
        _, text = convert("text-only.pptx")
        assert text.lstrip().startswith("## Slide 1")

    def test_title_not_repeated_in_body(self, convert) -> None:
        """The title becomes the heading; emitting it twice is a regression."""
        _, text = convert("text-only.pptx")
        assert text.count("Strategy Overview") == 1

    def test_bullet_levels_preserved(self, convert) -> None:
        _, text = convert("text-only.pptx")
        assert "- First top level point" in text
        assert "  - Supporting detail" in text


class TestTables:
    def test_native_table_becomes_markdown_table(self, convert) -> None:
        _, text = convert("tables.pptx")
        assert "| Option | Cost | Risk |" in text
        assert "| --- | --- | --- |" in text
        assert "| Build | High | Medium |" in text


class TestGroupedShapes:
    def test_group_children_are_walked(self, convert) -> None:
        """§34 requires recursing into grouped shapes."""
        _, text = convert("grouped-shapes.pptx")
        assert "Grouped child one" in text
        assert "Grouped child two" in text


class TestMedia:
    def test_images_extracted_with_relative_paths(self, convert, workspace) -> None:
        result, text = convert("images.pptx")
        assert result.media_count >= 1
        assert "](media/" in text
        assert list(workspace.media_dir.glob("*"))

    def test_identical_images_stored_once(self, convert, workspace) -> None:
        """The same logo on three slides must not write three files."""
        result, text = convert("images.pptx")
        files = list(workspace.media_dir.glob("*"))
        # Fixture: one logo repeated on 3 slides + 1 unique image.
        assert len(files) == 2
        assert result.media_count == 2
        assert text.count("media/slide-001-image-001.png") == 3

    def test_alt_text_is_not_the_source_filename(self, convert) -> None:
        """Author filenames must not leak into the output."""
        _, text = convert("images.pptx")
        assert "_pptx_logo.png]" not in text
        assert "![Slide 1 image]" in text


class TestOutputContract:
    """§37 / §56 assertions that apply to every format."""

    def test_markdown_is_utf8_lf_and_leaks_no_paths(self, convert, workspace) -> None:
        result, text = convert("text-only.pptx")
        raw = result.markdown_path.read_bytes()

        raw.decode("utf-8")  # raises if not valid UTF-8
        assert b"\r\n" not in raw
        assert not raw.startswith(b"\xef\xbb\xbf")
        assert "/tmp" not in text
        assert "C:\\" not in text
        assert str(workspace.root) not in text

    def test_uses_atx_headings(self, convert) -> None:
        _, text = convert("text-only.pptx")
        headings = [ln for ln in text.splitlines() if ln.startswith("#")]
        assert headings
        assert all(ln.startswith("## ") for ln in headings)

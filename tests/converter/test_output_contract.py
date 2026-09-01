"""Cross-format output-contract assertions (Amendment A8.2, §56, §37).

A8.2 extends §56 with assertions that must hold for *every* format. Running
them from one place means a new converter cannot quietly opt out of the
contract, and a regression in one engine fails here as well as in its own file.
"""

from __future__ import annotations

import re

import pytest

from app.converters.docx import pandoc_available
from app.converters.pdf import PdfConverter
from app.converters.pptx import PptxConverter
from app.security.validation import SourceType

# Markdown image links: ![alt](target)
_IMAGE_LINK = re.compile(r"!\[[^\]]*\]\(([^)]+)\)")
# Raw HTML tags. The output contract is GFM; §37 wants clean Markdown.
_HTML_TAG = re.compile(r"<(?!!--)(/?[a-zA-Z][a-zA-Z0-9]*)\b[^>]*>")

# (fixture, source type, extension, converter)
CASES = [
    ("text-only.pptx", SourceType.PPTX, ".pptx", PptxConverter),
    ("tables.pptx", SourceType.PPTX, ".pptx", PptxConverter),
    ("images.pptx", SourceType.PPTX, ".pptx", PptxConverter),
    ("merged-cells.pptx", SourceType.PPTX, ".pptx", PptxConverter),
    ("coloured-text.pptx", SourceType.PPTX, ".pptx", PptxConverter),
    ("charts.pptx", SourceType.PPTX, ".pptx", PptxConverter),
    ("text.pdf", SourceType.PDF, ".pdf", PdfConverter),
    ("multipage.pdf", SourceType.PDF, ".pdf", PdfConverter),
    ("images.pdf", SourceType.PDF, ".pdf", PdfConverter),
    ("tables.pdf", SourceType.PDF, ".pdf", PdfConverter),
    ("two-column.pdf", SourceType.PDF, ".pdf", PdfConverter),
]


@pytest.fixture
def run_case(workspace, fixture_path):
    def _run(name: str, extension: str, converter_class):
        source = workspace.source_path(extension)
        source.write_bytes(fixture_path(name).read_bytes())
        result = converter_class(workspace, output_stem="out").convert(source)
        return result, result.markdown_path.read_text(encoding="utf-8")

    return _run


@pytest.mark.parametrize(("name", "_type", "extension", "converter"), CASES)
class TestUniversalContract:
    """Assertions that hold for every format and every fixture."""

    def test_no_raw_html(self, run_case, name, _type, extension, converter) -> None:
        _, text = run_case(name, extension, converter)
        found = _HTML_TAG.findall(text)
        assert not found, f"raw HTML in output: {found[:5]}"

    def test_every_image_link_resolves(
        self, run_case, workspace, name, _type, extension, converter
    ) -> None:
        """A8.2 - no dangling media references."""
        _, text = run_case(name, extension, converter)
        for target in _IMAGE_LINK.findall(text):
            assert not target.startswith(("/", "http", "data:")), (
                f"non-relative media link: {target}"
            )
            assert (workspace.output_dir / target).is_file(), (
                f"link points at a missing file: {target}"
            )

    def test_no_unreferenced_media(
        self, run_case, workspace, name, _type, extension, converter
    ) -> None:
        """A8.2 - nothing extracted that the document never references.

        A1.4 makes this a hard failure; here it is an assertion on our own
        engines, which control both sides of the relationship.
        """
        _, text = run_case(name, extension, converter)
        referenced = {t.removeprefix("media/") for t in _IMAGE_LINK.findall(text)}
        on_disk = {p.name for p in workspace.media_dir.glob("*") if p.is_file()}
        assert on_disk - referenced == set(), (
            f"unreferenced media files: {sorted(on_disk - referenced)}"
        )

    def test_media_naming_convention(
        self, run_case, workspace, name, _type, extension, converter
    ) -> None:
        """§34/§35 naming, asserted exactly."""
        _, _text = run_case(name, extension, converter)
        pattern = re.compile(r"^(slide|page)-\d{3}-image-\d{3}\.[a-z0-9]+$")
        for media in workspace.media_dir.glob("*"):
            if media.is_file():
                assert pattern.match(media.name), f"bad media name: {media.name}"

    def test_utf8_lf_and_no_paths(
        self, run_case, workspace, name, _type, extension, converter
    ) -> None:
        result, text = run_case(name, extension, converter)
        raw = result.markdown_path.read_bytes()
        raw.decode("utf-8")
        assert b"\r\n" not in raw
        assert not raw.startswith(b"\xef\xbb\xbf")
        assert "/tmp" not in text
        assert "C:\\" not in text
        assert str(workspace.root) not in text

    def test_warnings_leak_nothing(
        self, run_case, workspace, name, _type, extension, converter
    ) -> None:
        """§39/§47 - warnings reach the user, so they must stay clean."""
        result, _ = run_case(name, extension, converter)
        for warning in result.warnings:
            assert "/tmp" not in warning
            assert "C:\\" not in warning
            assert str(workspace.root) not in warning


class TestPptxSpecific:
    """A8.2's PPTX assertions."""

    @pytest.fixture
    def convert(self, workspace, fixture_path):
        def _convert(name: str):
            source = workspace.source_path(".pptx")
            source.write_bytes(fixture_path(name).read_bytes())
            result = PptxConverter(workspace, output_stem="deck").convert(source)
            return result, result.markdown_path.read_text(encoding="utf-8")

        return _convert

    @pytest.mark.parametrize(
        "name", ["text-only.pptx", "images.pptx", "tables.pptx", "charts.pptx"]
    )
    def test_slide_headings_match_the_required_form(self, convert, name) -> None:
        _, text = convert(name)
        headings = [ln for ln in text.splitlines() if ln.startswith("## ")]
        assert headings
        for heading in headings:
            assert re.match(r"^## Slide \d+( — .+)?$", heading), heading

    def test_slide_numbering_is_contiguous_from_one(self, convert) -> None:
        _, text = convert("images.pptx")
        numbers = [
            int(m.group(1))
            for m in re.finditer(r"^## Slide (\d+)", text, re.MULTILINE)
        ]
        assert numbers == list(range(1, len(numbers) + 1))

    def test_speaker_notes_excluded_by_default(self, convert) -> None:
        """A1.3 - notes carry internal commentary and must not be published."""
        _, text = convert("speaker-notes.pptx")
        assert "CONFIDENTIAL" not in text
        assert "internal commentary" not in text
        # The public content still converts.
        assert "Body text that should appear." in text

    def test_notes_can_be_opted_in(self, convert, monkeypatch) -> None:
        import dataclasses

        from app.converters import pptx as pptx_module

        monkeypatch.setattr(
            pptx_module,
            "settings",
            dataclasses.replace(pptx_module.settings, pptx_include_notes=True),
        )
        _, text = convert("speaker-notes.pptx")
        assert "Speaker notes:" in text

    def test_chart_warns_but_still_succeeds(self, convert) -> None:
        """A8.2 - unsupported objects warn; they do not fail the job."""
        result, text = convert("charts.pptx")
        assert result.warnings
        assert any("chart" in w.lower() for w in result.warnings)
        # Conversion still produced a usable document.
        assert "## Slide 1" in text

    def test_merged_cell_table_is_valid_gfm(self, convert) -> None:
        _, text = convert("merged-cells.pptx")
        rows = [ln for ln in text.splitlines() if ln.startswith("|")]
        assert len(rows) >= 3
        # Every row must have the same column count as the delimiter row.
        widths = {row.count("|") for row in rows}
        assert len(widths) == 1, f"ragged table rows: {widths}"

    def test_coloured_text_produces_no_colour_markup(self, convert) -> None:
        _, text = convert("coloured-text.pptx")
        assert "Red warning text" in text
        assert "<font" not in text.lower()
        assert "color" not in text.lower()


class TestPdfSpecific:
    """A8.2's PDF assertions."""

    @pytest.fixture
    def convert(self, workspace, fixture_path):
        def _convert(name: str):
            source = workspace.source_path(".pdf")
            source.write_bytes(fixture_path(name).read_bytes())
            result = PdfConverter(workspace, output_stem="doc").convert(source)
            return result, result.markdown_path.read_text(encoding="utf-8")

        return _convert

    def test_table_fixture_produces_a_gfm_table(self, convert) -> None:
        _, text = convert("tables.pdf")
        assert "| --- |" in text or "| --- | --- |" in text
        assert "Enterprise" in text

    def test_page_headings_match_the_required_form(self, convert) -> None:
        _, text = convert("multipage.pdf")
        for heading in [ln for ln in text.splitlines() if ln.startswith("## ")]:
            assert re.match(r"^## Page \d+$", heading), heading

    def test_two_column_text_is_all_present(self, convert) -> None:
        """Reading order is a known limitation; losing content is not."""
        _, text = convert("two-column.pdf")
        assert "Left column line one." in text
        assert "Right column line one." in text


@pytest.mark.skipif(not pandoc_available(), reason="pandoc not installed")
class TestDocxContract:
    """DOCX shares the universal contract; it needs Pandoc so it is separate."""

    @pytest.fixture
    def convert(self, workspace, fixture_path):
        from app.converters.docx import DocxConverter

        def _convert(name: str):
            source = workspace.source_path(".docx")
            source.write_bytes(fixture_path(name).read_bytes())
            result = DocxConverter(workspace, output_stem="doc").convert(source)
            return result, result.markdown_path.read_text(encoding="utf-8")

        return _convert

    @pytest.mark.parametrize("name", ["headings.docx", "table.docx", "images.docx"])
    def test_no_raw_html(self, convert, name) -> None:
        _, text = convert(name)
        assert not _HTML_TAG.findall(text)

    def test_every_image_link_resolves(self, convert, workspace) -> None:
        _, text = convert("images.docx")
        targets = _IMAGE_LINK.findall(text)
        assert targets
        for target in targets:
            assert (workspace.output_dir / target).is_file()

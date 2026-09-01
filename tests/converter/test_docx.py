"""DOCX conversion tests (ENGINEERING_SPEC.md §33).

DOCX conversion shells out to Pandoc, which is a system package rather than a
Python dependency. It ships in the converter container (Dockerfile.vercel) but
may be absent on a developer machine, so the conversion tests skip rather than
fail when it is missing. The path-normalisation tests do not need Pandoc and
always run.

§70 makes "Pandoc present in production container" a release blocker, so a
skipped run here is never sufficient evidence for release.
"""

from __future__ import annotations

import pytest

from app.converters.docx import DocxConverter, pandoc_available, pandoc_version

requires_pandoc = pytest.mark.skipif(
    not pandoc_available(), reason="pandoc is not installed on this machine"
)


class TestPandocDetection:
    def test_detection_is_boolean(self) -> None:
        assert isinstance(pandoc_available(), bool)

    @requires_pandoc
    def test_version_reported_when_present(self) -> None:
        assert (pandoc_version() or "").lower().startswith("pandoc")


class TestMediaPathNormalisation:
    """§37 - media references must end up relative, with forward slashes.

    Pandoc's output varies by version and extraction root, so this is tested
    directly rather than only through a full conversion.
    """

    @pytest.fixture
    def converter(self, workspace) -> DocxConverter:
        return DocxConverter(workspace, output_stem="doc")

    @pytest.mark.parametrize(
        ("raw", "expected"),
        [
            ("media/image1.png", "media/image1.png"),
            ("./media/image1.png", "media/image1.png"),
            ("output/media/image1.png", "media/image1.png"),
            ("/tmp/doc2md/job/output/media/image1.png", "media/image1.png"),
            ("C:\\tmp\\job\\output\\media\\image1.png", "media/image1.png"),
            ("media/sub/image1.png", "media/sub/image1.png"),
        ],
    )
    def test_normalises_to_relative_media_path(
        self, converter: DocxConverter, raw: str, expected: str
    ) -> None:
        assert converter._normalise_one(raw) == expected

    @pytest.mark.parametrize(
        "raw",
        [
            "https://example.com/image.png",
            "http://example.com/image.png",
            "data:image/png;base64,AAAA",
            "#anchor",
            # Substring matching would wrongly treat this as a media reference.
            "notmedia/image.png",
        ],
    )
    def test_leaves_non_media_targets_alone(
        self, converter: DocxConverter, raw: str
    ) -> None:
        assert converter._normalise_one(raw) is None

    def test_rewrites_html_img_tags(
        self, converter: DocxConverter, workspace
    ) -> None:
        """Pandoc emits <img> tags for sized images; they must become Markdown.

        Regression: matching only the ![](...) form left raw HTML carrying
        absolute Windows paths in the output and reported a media count of zero.
        """
        markdown = workspace.markdown_path("doc")
        markdown.parent.mkdir(parents=True, exist_ok=True)
        markdown.write_text(
            '<img src="./media/image1.png" style="width:1in;height:0.7in" />\n\n'
            '<img alt="A chart" src="media/image2.png" />\n',
            encoding="utf-8",
        )
        workspace.media_dir.mkdir(parents=True, exist_ok=True)
        for name in ("image1.png", "image2.png"):
            (workspace.media_dir / name).write_bytes(b"\x89PNG\r\n\x1a\n")

        count = converter._normalise_media_paths(markdown)
        text = markdown.read_text(encoding="utf-8")

        assert "<img" not in text
        assert "![Image](media/image1.png)" in text
        assert "![A chart](media/image2.png)" in text
        assert "style=" not in text
        assert count == 2

    def test_rewrites_markdown_references(
        self, converter: DocxConverter, workspace
    ) -> None:
        markdown = workspace.markdown_path("doc")
        markdown.parent.mkdir(parents=True, exist_ok=True)
        markdown.write_text(
            "# Title\n\n"
            "![a](/tmp/doc2md/j/output/media/image1.png)\n\n"
            "![b](media/image2.png)\n",
            encoding="utf-8",
        )
        # Only image1 exists on disk, so only it should be counted.
        workspace.media_dir.mkdir(parents=True, exist_ok=True)
        (workspace.media_dir / "image1.png").write_bytes(b"\x89PNG\r\n\x1a\n")

        count = converter._normalise_media_paths(markdown)
        text = markdown.read_text(encoding="utf-8")

        assert "](media/image1.png)" in text
        assert "/tmp" not in text
        assert count == 1, "dangling references must not inflate the media count"


@requires_pandoc
class TestDocxConversion:
    @pytest.fixture
    def convert(self, workspace, fixture_path):
        def _convert(name: str):
            source = workspace.source_path(".docx")
            source.write_bytes(fixture_path(name).read_bytes())
            result = DocxConverter(workspace, output_stem="doc").convert(source)
            return result, result.markdown_path.read_text(encoding="utf-8")

        return _convert

    def test_headings_preserved(self, convert) -> None:
        _, text = convert("headings.docx")
        assert "# Top Level Heading" in text
        assert "## Second Level" in text
        assert "### Third Level" in text

    def test_emphasis_preserved(self, convert) -> None:
        _, text = convert("headings.docx")
        assert "**bold text**" in text
        assert "*italic text*" in text

    def test_lists_preserved(self, convert) -> None:
        _, text = convert("headings.docx")
        assert "First bullet" in text
        assert "Third bullet" in text

    def test_tables_preserved(self, convert) -> None:
        _, text = convert("table.docx")
        assert "Region" in text
        assert "North" in text
        assert "|" in text

    def test_images_extracted_relative(self, convert) -> None:
        result, text = convert("images.docx")
        assert result.media_count >= 1
        assert "](media/" in text
        assert "<img" not in text
        assert "/tmp" not in text
        assert "C:\\" not in text

    def test_repeated_image_referenced_twice(self, convert) -> None:
        """The fixture embeds one logo twice and a second distinct image."""
        result, text = convert("images.docx")
        assert result.media_count == 2
        assert text.count("](media/image1.png)") == 2

    def test_output_is_utf8_lf(self, convert) -> None:
        result, _ = convert("simple.docx")
        raw = result.markdown_path.read_bytes()
        raw.decode("utf-8")
        assert b"\r\n" not in raw
        assert not raw.startswith(b"\xef\xbb\xbf")

"""End-to-end local pipeline tests (§22, §38, §56; DEVIATIONS D-014, D-015).

The pipeline now produces one of two deliverables, chosen by the user before
the job starts:

  * **Markdown only** — a single `.md` file, handed over as-is.
  * **Markdown + media** — a `.zip` holding the `.md` and a `media/` folder.

Markdown-only must genuinely skip image extraction, not extract and discard.
On an image-heavy deck that work is most of the cost, and doing it anyway
would make the user's choice cosmetic.
"""

from __future__ import annotations

import zipfile

import pytest

from app.security.validation import SourceType
from app.services.pipeline import run_conversion


@pytest.fixture
def run(workspace, fixture_path):
    def _run(
        name: str,
        source_type: SourceType,
        stem: str = "Market Study",
        include_media: bool = True,
    ):
        source = workspace.source_path(f".{source_type}")
        source.write_bytes(fixture_path(name).read_bytes())
        return run_conversion(
            workspace=workspace,
            source_path=source,
            source_type=source_type,
            output_stem=stem,
            original_filename=name,
            include_media=include_media,
        )

    return _run


class TestPipelineOrdering:
    """§22 - the source is deleted before the deliverable is built."""

    def test_source_removed_before_packaging(self, run, workspace) -> None:
        run("text-only.pptx", SourceType.PPTX)
        assert not workspace.source_dir.exists()

    def test_reports_elapsed_time(self, run) -> None:
        outcome = run("text-only.pptx", SourceType.PPTX)
        assert outcome.elapsed_ms >= 0


class TestMarkdownWithMedia:
    """A document with images yields a ZIP."""

    def test_produces_a_zip(self, run) -> None:
        outcome = run("images.pptx", SourceType.PPTX)
        assert outcome.result_path.suffix == ".zip"
        assert outcome.result_content_type == "application/zip"
        assert outcome.result_bytes > 0

    def test_zip_layout(self, run) -> None:
        outcome = run("images.pptx", SourceType.PPTX)
        with zipfile.ZipFile(outcome.result_path) as archive:
            names = archive.namelist()

        assert "Market Study_markdown/Market Study.md" in names
        assert any(n.startswith("Market Study_markdown/media/") for n in names)

    def test_zip_excludes_the_source_document(self, run) -> None:
        outcome = run("images.pptx", SourceType.PPTX)
        with zipfile.ZipFile(outcome.result_path) as archive:
            names = archive.namelist()
        assert not any(n.endswith((".pptx", ".docx", ".pdf")) for n in names)

    def test_zip_carries_no_conversion_report(self, run) -> None:
        """D-014 - the report was dropped; nobody opened it."""
        outcome = run("images.pptx", SourceType.PPTX)
        with zipfile.ZipFile(outcome.result_path) as archive:
            names = archive.namelist()
        assert not any(n.endswith("conversion-report.json") for n in names)

    def test_zip_opens_and_every_member_is_valid(self, run) -> None:
        """A ZIP the user cannot open is worse than no ZIP at all.

        `testzip()` verifies every member's CRC, which is the check that
        actually catches a corrupt archive - the magic bytes alone do not.
        """
        outcome = run("images.pptx", SourceType.PPTX)
        with zipfile.ZipFile(outcome.result_path) as archive:
            assert archive.testzip() is None
            markdown = archive.read(
                "Market Study_markdown/Market Study.md"
            ).decode("utf-8")
        assert markdown.startswith("## Slide 1")

    def test_media_paths_are_relative(self, run) -> None:
        outcome = run("images.pptx", SourceType.PPTX)
        with zipfile.ZipFile(outcome.result_path) as archive:
            markdown = archive.read(
                "Market Study_markdown/Market Study.md"
            ).decode("utf-8")
        assert "](media/" in markdown
        assert "](/" not in markdown
        assert "\\" not in markdown


class TestMarkdownOnly:
    """The user asked for Markdown; give them a Markdown file."""

    def test_produces_a_bare_markdown_file(self, run) -> None:
        outcome = run("images.pptx", SourceType.PPTX, include_media=False)
        assert outcome.result_path.suffix == ".md"
        assert outcome.result_content_type.startswith("text/markdown")

    def test_the_file_is_readable_markdown(self, run) -> None:
        outcome = run("tables.pptx", SourceType.PPTX, include_media=False)
        text = outcome.result_path.read_text(encoding="utf-8")
        assert text.startswith("## Slide 1")
        assert "| Option | Cost | Risk |" in text

    def test_no_images_are_written_at_all(self, run, workspace) -> None:
        """Skipped, not extracted-then-discarded — that is the whole point."""
        outcome = run("images.pptx", SourceType.PPTX, include_media=False)
        assert outcome.media_count == 0
        assert list(workspace.media_dir.glob("*")) == []

    def test_no_image_links_are_left_dangling(self, run) -> None:
        """Markdown must not reference files that were never written."""
        outcome = run("images.pptx", SourceType.PPTX, include_media=False)
        text = outcome.result_path.read_text(encoding="utf-8")
        assert "](media/" not in text

    def test_text_and_tables_survive(self, run) -> None:
        outcome = run("tables.pptx", SourceType.PPTX, include_media=False)
        text = outcome.result_path.read_text(encoding="utf-8")
        assert "| Build | High | Medium |" in text

    def test_pdf_markdown_only(self, run) -> None:
        outcome = run("images.pdf", SourceType.PDF, include_media=False)
        assert outcome.result_path.suffix == ".md"
        assert outcome.media_count == 0
        text = outcome.result_path.read_text(encoding="utf-8")
        assert "Document with an embedded image" in text
        assert "](media/" not in text

    def test_a_document_with_no_images_needs_no_zip(self, run) -> None:
        """Even in media mode, nothing to package means no archive."""
        outcome = run("text-only.pptx", SourceType.PPTX, include_media=True)
        assert outcome.result_path.suffix == ".md"


class TestOutputContract:
    """§37 holds whichever shape is delivered."""

    @pytest.mark.parametrize("include_media", [True, False])
    def test_markdown_is_utf8_lf_and_leaks_no_paths(
        self, run, workspace, include_media
    ) -> None:
        outcome = run("images.pptx", SourceType.PPTX, include_media=include_media)

        if outcome.result_path.suffix == ".zip":
            with zipfile.ZipFile(outcome.result_path) as archive:
                raw = archive.read("Market Study_markdown/Market Study.md")
        else:
            raw = outcome.result_path.read_bytes()

        raw.decode("utf-8")
        assert b"\r\n" not in raw
        assert not raw.startswith(b"\xef\xbb\xbf")
        text = raw.decode("utf-8")
        assert "/tmp" not in text
        assert "C:\\" not in text
        assert str(workspace.root) not in text


class TestQuotaEnforcement:
    def test_oversized_result_rejected(self, run, monkeypatch) -> None:
        import dataclasses

        from app.errors import ConversionError, ErrorCode
        from app.services import pipeline as pipeline_module

        monkeypatch.setattr(
            pipeline_module,
            "settings",
            dataclasses.replace(pipeline_module.settings, max_result_zip_bytes=10),
        )
        with pytest.raises(ConversionError) as caught:
            run("images.pptx", SourceType.PPTX)
        assert caught.value.code is ErrorCode.RESULT_TOO_LARGE

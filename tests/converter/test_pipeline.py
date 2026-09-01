"""End-to-end local pipeline tests (ENGINEERING_SPEC.md §22, §38, §39, §56)."""

from __future__ import annotations

import json
import zipfile

import pytest

from app.security.validation import SourceType
from app.services.pipeline import run_conversion


@pytest.fixture
def run(workspace, fixture_path):
    def _run(name: str, source_type: SourceType, stem: str = "Market Study"):
        source = workspace.source_path(f".{source_type}")
        source.write_bytes(fixture_path(name).read_bytes())
        outcome = run_conversion(
            workspace=workspace,
            source_path=source,
            source_type=source_type,
            output_stem=stem,
            original_filename=name,
        )
        return outcome

    return _run


class TestPipelineOrdering:
    """§22 - the source is deleted before the ZIP is built."""

    def test_source_removed_before_packaging(self, run, workspace) -> None:
        run("text-only.pptx", SourceType.PPTX)
        assert not workspace.source_dir.exists()

    def test_produces_result_zip(self, run) -> None:
        outcome = run("text-only.pptx", SourceType.PPTX)
        assert outcome.zip_path.exists()
        assert outcome.zip_bytes > 0
        assert outcome.zip_path.name == "Market Study_markdown.zip"


class TestPackageContents:
    """§38 - fixed package layout, and no source document inside."""

    def test_zip_layout(self, run) -> None:
        outcome = run("images.pptx", SourceType.PPTX)
        with zipfile.ZipFile(outcome.zip_path) as archive:
            names = archive.namelist()

        assert "Market Study_markdown/Market Study.md" in names
        assert "Market Study_markdown/conversion-report.json" in names
        assert any(n.startswith("Market Study_markdown/media/") for n in names)

    def test_zip_excludes_source_document(self, run) -> None:
        outcome = run("images.pptx", SourceType.PPTX)
        with zipfile.ZipFile(outcome.zip_path) as archive:
            names = archive.namelist()
        assert not any(n.endswith((".pptx", ".docx", ".pdf")) for n in names)

    def test_zip_opens_and_members_readable(self, run) -> None:
        outcome = run("tables.pptx", SourceType.PPTX)
        with zipfile.ZipFile(outcome.zip_path) as archive:
            assert archive.testzip() is None
            markdown = archive.read(
                "Market Study_markdown/Market Study.md"
            ).decode("utf-8")
        assert markdown.startswith("## Slide 1")

    def test_media_paths_relative_and_forward_slashed(self, run) -> None:
        outcome = run("images.pptx", SourceType.PPTX)
        with zipfile.ZipFile(outcome.zip_path) as archive:
            markdown = archive.read(
                "Market Study_markdown/Market Study.md"
            ).decode("utf-8")
        assert "](media/" in markdown
        assert "\\" not in markdown
        assert "](/" not in markdown


class TestConversionReport:
    """§39 - the report carries no paths, URLs, tokens or document text."""

    def test_report_fields(self, run) -> None:
        outcome = run("multipage.pdf", SourceType.PDF, stem="doc")
        with zipfile.ZipFile(outcome.zip_path) as archive:
            report = json.loads(
                archive.read("doc_markdown/conversion-report.json")
            )

        assert report["source_filename"] == "multipage.pdf"
        assert report["source_type"] == "pdf"
        assert report["source_size_bytes"] > 0
        assert report["markdown_filename"] == "doc.md"
        assert report["pages_or_slides"] == 3
        assert report["conversion_status"] == "success"
        assert report["elapsed_ms"] >= 0

    def test_report_states_zero_ai_tokens(self, run) -> None:
        """§64 / §73 - the zero-AI guarantee is asserted, not assumed."""
        outcome = run("text.pdf", SourceType.PDF, stem="doc")
        with zipfile.ZipFile(outcome.zip_path) as archive:
            report = json.loads(
                archive.read("doc_markdown/conversion-report.json")
            )
        assert report["ai_tokens_used"] == 0

    def test_report_leaks_no_paths(self, run, workspace) -> None:
        outcome = run("text.pdf", SourceType.PDF, stem="doc")
        with zipfile.ZipFile(outcome.zip_path) as archive:
            raw = archive.read("doc_markdown/conversion-report.json").decode("utf-8")

        assert "/tmp" not in raw
        assert "C:\\" not in raw
        assert "http://" not in raw
        assert "https://" not in raw
        assert str(workspace.root) not in raw


class TestReportSafetyGuard:
    """The §39 guard must actually reject unsafe values."""

    @pytest.mark.parametrize(
        "bad_value",
        [
            "C:\\Users\\me\\secret.docx",
            "/tmp/doc2md/abc/source/input.pdf",
            "https://blob.example.com/signed?token=abc",
            "Bearer eyJhbGciOi",
        ],
    )
    def test_unsafe_values_rejected(self, bad_value: str) -> None:
        from app.services.report import _assert_safe

        with pytest.raises(ValueError):
            _assert_safe({"warnings": [bad_value]})

    def test_safe_payload_accepted(self) -> None:
        from app.services.report import _assert_safe

        _assert_safe(
            {
                "source_filename": "Market Study.pdf",
                "warnings": ["Page 4 may be scanned or image-based."],
                "media_count": 3,
            }
        )


class TestQuotaEnforcement:
    def test_oversized_result_rejected(self, run, workspace, monkeypatch) -> None:
        import dataclasses

        from app.services import packager as packager_module

        monkeypatch.setattr(
            packager_module,
            "settings",
            dataclasses.replace(packager_module.settings, max_result_zip_bytes=10),
        )
        from app.errors import ConversionError, ErrorCode

        with pytest.raises(ConversionError) as caught:
            run("images.pptx", SourceType.PPTX)
        assert caught.value.code is ErrorCode.RESULT_TOO_LARGE

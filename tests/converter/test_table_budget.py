"""PDF table-extraction budgets (Amendment A2.3, A8.2).

A2.3's governing rule: text and images are never skipped; tables are the
degradable feature. Skipping tables must never turn a success into a failure.
"""

from __future__ import annotations

import dataclasses

import pytest

from app.converters import pdf as pdf_module
from app.converters.pdf import PdfConverter


def with_settings(monkeypatch, **overrides):
    monkeypatch.setattr(
        pdf_module,
        "settings",
        dataclasses.replace(pdf_module.settings, **overrides),
    )


@pytest.fixture
def convert(workspace, fixture_path):
    def _convert(name: str):
        source = workspace.source_path(".pdf")
        source.write_bytes(fixture_path(name).read_bytes())
        result = PdfConverter(workspace, output_stem="doc").convert(source)
        return result, result.markdown_path.read_text(encoding="utf-8")

    return _convert


class TestPageBudget:
    def test_document_over_page_budget_skips_tables(
        self, convert, monkeypatch
    ) -> None:
        with_settings(monkeypatch, pdf_table_max_pages=1)
        result, _ = convert("multipage.pdf")  # 3 pages

        assert any("exceeds the page budget" in w for w in result.warnings)

    def test_skipping_tables_is_still_a_success(self, convert, monkeypatch) -> None:
        """A2.3 - the absence of tables is not a failed conversion."""
        with_settings(monkeypatch, pdf_table_max_pages=1)
        result, text = convert("multipage.pdf")

        assert result.pages_or_slides == 3
        assert "## Page 1" in text
        # Text is never the degradable part.
        assert "belonging to page 1" in text

    def test_within_budget_emits_no_skip_warning(self, convert, monkeypatch) -> None:
        with_settings(monkeypatch, pdf_table_max_pages=300)
        result, _ = convert("multipage.pdf")
        assert not any("page budget" in w for w in result.warnings)


class TestFeatureToggle:
    def test_extraction_can_be_disabled_entirely(
        self, convert, monkeypatch
    ) -> None:
        with_settings(monkeypatch, pdf_table_extraction=False)
        result, text = convert("multipage.pdf")

        # Still a complete, successful conversion.
        assert result.pages_or_slides == 3
        assert "## Page 3" in text
        # Disabling is deliberate, so it is silent rather than a warning.
        assert not any("page budget" in w for w in result.warnings)

    def test_text_and_images_survive_disabled_tables(
        self, convert, monkeypatch
    ) -> None:
        """Text and images are never skipped, whatever the table budget."""
        with_settings(monkeypatch, pdf_table_extraction=False)
        result, text = convert("images.pdf")

        assert result.media_count == 1
        assert "](media/" in text
        assert "Document with an embedded image" in text


class TestPerPageTimeout:
    def test_overrunning_page_discards_its_tables_and_warns(
        self, convert, monkeypatch
    ) -> None:
        """A zero budget makes every page overrun, exercising the path."""
        with_settings(monkeypatch, pdf_table_page_timeout_seconds=0.0)
        result, text = convert("multipage.pdf")

        assert any("exceeded its time budget" in w for w in result.warnings)
        # Still a success; text intact.
        assert "## Page 1" in text

    def test_exhausted_global_budget_stops_extraction_once(
        self, convert, monkeypatch
    ) -> None:
        """The stop warning is emitted once, not once per remaining page."""
        with_settings(
            monkeypatch,
            pdf_table_page_timeout_seconds=999.0,
            conversion_timeout_seconds=0,
            pdf_table_deadline_reserve_seconds=0,
        )
        result, _ = convert("multipage.pdf")

        stops = [w for w in result.warnings if "stopped early" in w]
        assert len(stops) == 1


class TestWarningHygiene:
    def test_budget_warnings_leak_nothing(self, convert, monkeypatch, workspace) -> None:
        """§39/§47 apply to warnings the user reads."""
        with_settings(monkeypatch, pdf_table_max_pages=1)
        result, _ = convert("multipage.pdf")

        for warning in result.warnings:
            assert "/tmp" not in warning
            assert "C:\\" not in warning
            assert str(workspace.root) not in warning

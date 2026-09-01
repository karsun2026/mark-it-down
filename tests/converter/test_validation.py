"""Security and validation tests (ENGINEERING_SPEC.md §29, §30, §31, §55)."""

from __future__ import annotations

import dataclasses

import pytest

from app.errors import ConversionError, ErrorCode
from app.security.validation import (
    MAX_STEM_LENGTH,
    SourceType,
    inspect_office_archive,
    safe_extension,
    sanitize_filename_stem,
    source_type_for_filename,
    validate_source_file,
)


class TestFilenameSanitisation:
    """§31 - a raw uploaded filename is never a trusted path."""

    @pytest.mark.parametrize(
        ("raw", "expected"),
        [
            ("report.docx", "report"),
            ("Market Study.pdf", "Market Study"),
            ("../../etc/passwd", "passwd"),
            ("..\\..\\windows\\system32", "system32"),
            ("/absolute/path/deck.pptx", "deck"),
            ("C:\\Users\\me\\deck.pptx", "deck"),
            ("with<illegal>chars.pdf", "with_illegal_chars"),
            ("trailing dots...pdf", "trailing dots"),
            ("   spaced   out   .pdf", "spaced out"),
            ("", "document"),
            ("...", "document"),
            (".pdf", "pdf"),
        ],
    )
    def test_produces_safe_stem(self, raw: str, expected: str) -> None:
        assert sanitize_filename_stem(raw) == expected

    def test_strips_traversal_sequences(self) -> None:
        assert ".." not in sanitize_filename_stem("a..b..c.pdf")

    def test_rejects_control_characters(self) -> None:
        assert sanitize_filename_stem("bad\x00name\x1f.pdf") == "bad_name_"

    def test_truncates_long_names(self) -> None:
        stem = sanitize_filename_stem("x" * 500 + ".pdf")
        assert len(stem) <= MAX_STEM_LENGTH

    @pytest.mark.parametrize("reserved", ["CON", "PRN", "NUL", "COM1", "LPT9"])
    def test_avoids_windows_reserved_names(self, reserved: str) -> None:
        assert sanitize_filename_stem(f"{reserved}.pdf") != reserved

    def test_preserves_useful_unicode(self) -> None:
        assert sanitize_filename_stem("Übersicht Ø 2026.docx") == "Übersicht Ø 2026"

    def test_never_returns_empty(self) -> None:
        for raw in ("", "   ", "///", "..", "\x00"):
            assert sanitize_filename_stem(raw)


class TestExtensionRouting:
    """§9 - supported types accepted, everything else refused by code."""

    @pytest.mark.parametrize(
        ("filename", "expected"),
        [
            ("a.docx", SourceType.DOCX),
            ("a.DOCX", SourceType.DOCX),
            ("a.pptx", SourceType.PPTX),
            ("a.pdf", SourceType.PDF),
        ],
    )
    def test_supported(self, filename: str, expected: SourceType) -> None:
        assert source_type_for_filename(filename) is expected

    @pytest.mark.parametrize(
        "filename",
        ["a.doc", "a.docm", "a.ppt", "a.pptm", "a.xlsx", "a.rtf", "a.key", "a"],
    )
    def test_rejected(self, filename: str) -> None:
        with pytest.raises(ConversionError) as caught:
            source_type_for_filename(filename)
        assert caught.value.code is ErrorCode.UNSUPPORTED_FILE_TYPE

    def test_extension_ignores_directory_portion(self) -> None:
        assert safe_extension("/some.dir/file.PDF") == ".pdf"


class TestContentValidation:
    """§29 - the extension alone is never trusted."""

    def test_real_pdf_accepted(self, fixture_path) -> None:
        validate_source_file(fixture_path("text.pdf"), SourceType.PDF)

    def test_real_docx_accepted(self, fixture_path) -> None:
        validate_source_file(fixture_path("simple.docx"), SourceType.DOCX)

    def test_real_pptx_accepted(self, fixture_path) -> None:
        validate_source_file(fixture_path("text-only.pptx"), SourceType.PPTX)

    def test_text_file_named_pdf_rejected(self, fixture_path) -> None:
        with pytest.raises(ConversionError) as caught:
            validate_source_file(fixture_path("fake-pdf.pdf"), SourceType.PDF)
        assert caught.value.code is ErrorCode.INVALID_FILE_FORMAT

    def test_plain_zip_named_docx_rejected(self, fixture_path) -> None:
        with pytest.raises(ConversionError) as caught:
            validate_source_file(fixture_path("renamed-zip.docx"), SourceType.DOCX)
        assert caught.value.code is ErrorCode.INVALID_FILE_FORMAT

    def test_pptx_content_rejected_when_declared_docx(self, fixture_path) -> None:
        """A real PPTX must not pass validation as a DOCX."""
        with pytest.raises(ConversionError) as caught:
            validate_source_file(fixture_path("text-only.pptx"), SourceType.DOCX)
        assert caught.value.code is ErrorCode.INVALID_FILE_FORMAT

    def test_encrypted_office_reports_password_protected(self, fixture_path) -> None:
        """The gap the spec left: encrypted OOXML is OLE2, not a ZIP.

        Without the CFB magic check this would surface as INVALID_FILE_FORMAT
        and §46's PASSWORD_PROTECTED code would be unreachable.
        """
        with pytest.raises(ConversionError) as caught:
            validate_source_file(fixture_path("encrypted.docx"), SourceType.DOCX)
        assert caught.value.code is ErrorCode.PASSWORD_PROTECTED


class TestOfficeArchiveSafety:
    """§30 - reject hostile archives before extracting anything."""

    def test_normal_archive_passes(self, fixture_path) -> None:
        stats = inspect_office_archive(fixture_path("headings.docx"))
        assert stats.member_count > 0
        assert stats.uncompressed_bytes > 0

    def test_traversal_member_rejected(self, fixture_path) -> None:
        with pytest.raises(ConversionError) as caught:
            inspect_office_archive(fixture_path("unsafe-office-archive.docx"))
        assert caught.value.code is ErrorCode.OFFICE_ARCHIVE_UNSAFE

    def test_zip_bomb_rejected(self, fixture_path) -> None:
        with pytest.raises(ConversionError) as caught:
            inspect_office_archive(fixture_path("zip-bomb.docx"))
        assert caught.value.code in {
            ErrorCode.OFFICE_ARCHIVE_UNSAFE,
            ErrorCode.DOCUMENT_EXPANDS_TOO_LARGE,
        }

    def test_member_count_ceiling_enforced(self, fixture_path, monkeypatch) -> None:
        from app.security import validation as validation_module

        monkeypatch.setattr(
            validation_module,
            "settings",
            dataclasses.replace(validation_module.settings, max_archive_members=1),
        )
        with pytest.raises(ConversionError) as caught:
            inspect_office_archive(fixture_path("headings.docx"))
        assert caught.value.code is ErrorCode.OFFICE_ARCHIVE_UNSAFE

    def test_uncompressed_ceiling_enforced(self, fixture_path, monkeypatch) -> None:
        from app.security import validation as validation_module

        monkeypatch.setattr(
            validation_module,
            "settings",
            dataclasses.replace(
                validation_module.settings, max_office_uncompressed_bytes=10
            ),
        )
        with pytest.raises(ConversionError) as caught:
            inspect_office_archive(fixture_path("headings.docx"))
        assert caught.value.code is ErrorCode.DOCUMENT_EXPANDS_TOO_LARGE


class TestErrorContract:
    """§45 - no internal detail reaches the client."""

    def test_payload_omits_internal_detail(self) -> None:
        error = ConversionError(
            ErrorCode.CONVERSION_FAILED,
            internal_detail="/tmp/doc2md/secret/path pandoc rc=1",
        )
        payload = error.to_payload()
        assert set(payload) == {"code", "message"}
        assert "/tmp" not in payload["message"]
        assert "pandoc" not in payload["message"]

    def test_every_code_has_message_and_status(self) -> None:
        for code in ErrorCode:
            error = ConversionError(code)
            assert error.message
            assert 400 <= error.http_status <= 599

"""True file-format validation and Office archive safety checks.

ENGINEERING_SPEC.md §29 forbids trusting the extension, §30 requires archive
inspection before any Office conversion, and §31 governs filename handling.

One addition to the spec: an encrypted DOCX/PPTX is not a ZIP at all — Office
wraps it in an OLE2/CFB compound file. Without an explicit check for that magic
number, a password-protected document fails the "valid ZIP" test and is
reported as INVALID_FILE_FORMAT, leaving the spec's own PASSWORD_PROTECTED code
unreachable. `_detect_encrypted_office` closes that gap.
"""

from __future__ import annotations

import re
import unicodedata
import zipfile
from dataclasses import dataclass
from enum import StrEnum
from pathlib import Path, PurePosixPath

from app.config import settings
from app.errors import ConversionError, ErrorCode


class SourceType(StrEnum):
    DOCX = "docx"
    PPTX = "pptx"
    PDF = "pdf"


SUPPORTED_EXTENSIONS: dict[str, SourceType] = {
    ".docx": SourceType.DOCX,
    ".pptx": SourceType.PPTX,
    ".pdf": SourceType.PDF,
}

# §9 - explicitly rejected, listed so the user gets UNSUPPORTED_FILE_TYPE
# rather than a vague format error. Macro-enabled formats are never executed.
KNOWN_REJECTED_EXTENSIONS = frozenset(
    {
        ".doc", ".docm", ".dotm", ".dot",
        ".ppt", ".pptm", ".potm", ".pot",
        ".xls", ".xlsx", ".xlsm",
        ".rtf", ".pages", ".key", ".odt", ".odp",
    }
)

PDF_MAGIC = b"%PDF-"
ZIP_MAGIC = b"PK\x03\x04"
# OLE2 / Compound File Binary - what an encrypted OOXML file actually is.
CFB_MAGIC = b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1"

# Required members proving an archive really is the OOXML type it claims.
_REQUIRED_MEMBERS: dict[SourceType, tuple[str, ...]] = {
    SourceType.DOCX: ("[Content_Types].xml", "word/document.xml"),
    SourceType.PPTX: ("[Content_Types].xml", "ppt/presentation.xml"),
}

_WINDOWS_RESERVED = frozenset(
    {
        "CON", "PRN", "AUX", "NUL",
        *(f"COM{i}" for i in range(1, 10)),
        *(f"LPT{i}" for i in range(1, 10)),
    }
)

# Characters illegal on Windows plus the separators we never want in a stem.
_INVALID_CHARS = re.compile(r'[<>:"/\\|?*\x00-\x1f\x7f]')
_WHITESPACE_RUN = re.compile(r"\s+")
_DOT_RUN = re.compile(r"\.{2,}")

MAX_STEM_LENGTH = 120

# The ratio guard is gated on how much the archive EXPANDS, not on how many
# compressed bytes it occupies. Gating on compressed size lets the classic
# bomb through: 40 MB of zeros deflates to ~40 KB, below any sane floor.
MIN_EXPANDED_BYTES_FOR_RATIO_CHECK = 4 * 1024 * 1024


# --------------------------------------------------------------------------
# Filename sanitisation (§31)
# --------------------------------------------------------------------------


def sanitize_filename_stem(raw: str) -> str:
    """Reduce an untrusted filename to a safe, human-readable stem.

    Returns the stem only (no extension). Never returns an empty string, and
    never returns a value usable for path traversal.
    """
    # Strip any directory portion, for both separator conventions.
    candidate = raw.replace("\\", "/").split("/")[-1]

    # Drop the extension if present; callers supply their own.
    candidate = PurePosixPath(candidate).stem

    # Normalise so visually-identical Unicode collapses to one form.
    candidate = unicodedata.normalize("NFC", candidate)

    candidate = _INVALID_CHARS.sub("_", candidate)
    # The directory portion is already gone, so a dot run cannot traverse.
    # Collapse it rather than substituting, which mangles ordinary names.
    candidate = _DOT_RUN.sub(".", candidate)
    candidate = _WHITESPACE_RUN.sub(" ", candidate).strip(" .")

    if len(candidate) > MAX_STEM_LENGTH:
        candidate = candidate[:MAX_STEM_LENGTH].rstrip(" .")

    if candidate.upper() in _WINDOWS_RESERVED:
        candidate = f"{candidate}_file"

    return candidate or "document"


def safe_extension(raw_filename: str) -> str:
    """Lowercased extension including the dot, or '' when absent."""
    return PurePosixPath(raw_filename.replace("\\", "/").split("/")[-1]).suffix.lower()


# --------------------------------------------------------------------------
# Declared-type validation (cheap, pre-download)
# --------------------------------------------------------------------------


def source_type_for_filename(filename: str) -> SourceType:
    """Map a filename to a SourceType, raising the right code when unsupported."""
    extension = safe_extension(filename)
    if extension in SUPPORTED_EXTENSIONS:
        return SUPPORTED_EXTENSIONS[extension]
    raise ConversionError(
        ErrorCode.UNSUPPORTED_FILE_TYPE,
        internal_detail=f"extension={extension or '<none>'}",
    )


# --------------------------------------------------------------------------
# Real content validation (§29)
# --------------------------------------------------------------------------


def _read_magic(path: Path, length: int = 8) -> bytes:
    with path.open("rb") as handle:
        return handle.read(length)


def _detect_encrypted_office(magic: bytes) -> bool:
    return magic.startswith(CFB_MAGIC)


def validate_pdf(path: Path) -> None:
    """A PDF must begin with %PDF-. Encryption is checked by the converter."""
    magic = _read_magic(path, len(PDF_MAGIC))
    if not magic.startswith(PDF_MAGIC):
        raise ConversionError(
            ErrorCode.INVALID_FILE_FORMAT,
            internal_detail="pdf magic mismatch",
        )


def validate_office(path: Path, source_type: SourceType) -> None:
    """Confirm an OOXML file is a real ZIP containing the expected parts."""
    magic = _read_magic(path)

    if _detect_encrypted_office(magic):
        # Encrypted OOXML is an OLE2 container, not a ZIP. Report it honestly.
        raise ConversionError(
            ErrorCode.PASSWORD_PROTECTED,
            internal_detail="ole2/cfb container - encrypted ooxml",
        )

    if not magic.startswith(ZIP_MAGIC):
        raise ConversionError(
            ErrorCode.INVALID_FILE_FORMAT,
            internal_detail="not a zip archive",
        )

    try:
        with zipfile.ZipFile(path) as archive:
            names = set(archive.namelist())
    except zipfile.BadZipFile as exc:
        raise ConversionError(
            ErrorCode.INVALID_FILE_FORMAT,
            internal_detail=f"bad zip: {exc}",
        ) from exc

    missing = [m for m in _REQUIRED_MEMBERS[source_type] if m not in names]
    if missing:
        raise ConversionError(
            ErrorCode.INVALID_FILE_FORMAT,
            internal_detail=f"missing ooxml parts: {missing}",
        )


def validate_source_file(path: Path, source_type: SourceType) -> None:
    """Validate real file content against the declared type."""
    if source_type is SourceType.PDF:
        validate_pdf(path)
    else:
        validate_office(path, source_type)


# --------------------------------------------------------------------------
# Office archive safety (§30)
# --------------------------------------------------------------------------


@dataclass(frozen=True)
class ArchiveStats:
    member_count: int
    uncompressed_bytes: int
    compressed_bytes: int

    @property
    def compression_ratio(self) -> float:
        if self.compressed_bytes <= 0:
            return 0.0
        return self.uncompressed_bytes / self.compressed_bytes


def _is_unsafe_member_name(name: str) -> bool:
    if not name or name.endswith("/"):
        return False  # directory entries carry no payload
    normalised = name.replace("\\", "/")
    if normalised.startswith("/"):
        return True
    if re.match(r"^[A-Za-z]:", normalised):
        return True
    return any(part == ".." for part in PurePosixPath(normalised).parts)


def inspect_office_archive(path: Path) -> ArchiveStats:
    """Reject ZIP bombs and traversal before any extraction happens.

    Reads only the central directory - no member is decompressed here.
    """
    try:
        with zipfile.ZipFile(path) as archive:
            infos = archive.infolist()
    except zipfile.BadZipFile as exc:
        raise ConversionError(
            ErrorCode.INVALID_FILE_FORMAT,
            internal_detail=f"bad zip during inspection: {exc}",
        ) from exc

    if len(infos) > settings.max_archive_members:
        raise ConversionError(
            ErrorCode.OFFICE_ARCHIVE_UNSAFE,
            internal_detail=f"member count {len(infos)}",
        )

    uncompressed = 0
    compressed = 0
    for info in infos:
        if _is_unsafe_member_name(info.filename):
            raise ConversionError(
                ErrorCode.OFFICE_ARCHIVE_UNSAFE,
                internal_detail="unsafe member path",
            )
        uncompressed += info.file_size
        compressed += info.compress_size

    if uncompressed > settings.max_office_uncompressed_bytes:
        raise ConversionError(
            ErrorCode.DOCUMENT_EXPANDS_TOO_LARGE,
            internal_detail=f"uncompressed {uncompressed}",
        )

    stats = ArchiveStats(
        member_count=len(infos),
        uncompressed_bytes=uncompressed,
        compressed_bytes=compressed,
    )

    # Only meaningful once the archive expands enough for the ratio to matter;
    # small files routinely compress extremely well without being hostile.
    if (
        uncompressed > MIN_EXPANDED_BYTES_FOR_RATIO_CHECK
        and stats.compression_ratio > settings.max_compression_ratio
    ):
        raise ConversionError(
            ErrorCode.OFFICE_ARCHIVE_UNSAFE,
            internal_detail=f"compression ratio {stats.compression_ratio:.1f}",
        )

    return stats

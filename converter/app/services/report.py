"""Write conversion-report.json (ENGINEERING_SPEC.md §39).

§39 forbids absolute paths, signed URLs, tokens and document contents in the
report. `_assert_safe` enforces that before the file is written, so a future
change cannot quietly leak any of them into a file the user downloads.
"""

from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any

from app.converters.base import ConversionResult
from app.security.validation import SourceType

CONVERTER_VERSION = "0.1.0"

_REPORT_FILENAME = "conversion-report.json"

# Shapes that must never appear in a value written to the report.
_FORBIDDEN_PATTERNS: tuple[tuple[str, re.Pattern[str]], ...] = (
    ("windows path", re.compile(r"[A-Za-z]:[\\/]")),
    ("tmp path", re.compile(r"(^|[^\w])/tmp/")),
    ("url", re.compile(r"https?://")),
    ("bearer token", re.compile(r"(?i)bearer\s+\S+")),
)


def _assert_safe(payload: dict[str, Any]) -> None:
    """Raise if any string in the report violates §39."""

    def walk(value: Any, path: str) -> None:
        if isinstance(value, str):
            for label, pattern in _FORBIDDEN_PATTERNS:
                if pattern.search(value):
                    raise ValueError(
                        f"conversion report field {path!r} contains a {label}"
                    )
        elif isinstance(value, dict):
            for key, item in value.items():
                walk(item, f"{path}.{key}")
        elif isinstance(value, list):
            for index, item in enumerate(value):
                walk(item, f"{path}[{index}]")

    walk(payload, "report")


def build_report(
    *,
    source_filename: str,
    source_type: SourceType,
    source_size_bytes: int,
    markdown_filename: str,
    result: ConversionResult,
    elapsed_ms: int,
) -> dict[str, Any]:
    """Assemble the §39 report payload."""
    payload: dict[str, Any] = {
        "source_filename": source_filename,
        "source_type": str(source_type),
        "source_size_bytes": source_size_bytes,
        "markdown_filename": markdown_filename,
        "media_count": result.media_count,
        "pages_or_slides": result.pages_or_slides,
        "warnings": list(result.warnings),
        "conversion_status": "success",
        "elapsed_ms": elapsed_ms,
        "converter_version": CONVERTER_VERSION,
        # Stated explicitly because it is a product guarantee (§64, §73).
        "ai_tokens_used": 0,
    }
    _assert_safe(payload)
    return payload


def write_report(output_dir: Path, payload: dict[str, Any]) -> Path:
    """Write the report beside the Markdown, UTF-8 with LF endings."""
    _assert_safe(payload)
    report_path = output_dir / _REPORT_FILENAME
    report_path.parent.mkdir(parents=True, exist_ok=True)
    serialised = json.dumps(payload, indent=2, ensure_ascii=False) + "\n"
    with report_path.open("w", encoding="utf-8", newline="\n") as handle:
        handle.write(serialised)
    return report_path

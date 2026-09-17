"""Ad-hoc smoke run of the DOCX converter against the generated fixtures.

    .venv/Scripts/python.exe scripts/smoke_docx.py

Prints the produced Markdown so the output contract can be eyeballed, and
exits non-zero if a fixture is missing or a conversion raises — this is the
DOCX smoke step of the release gate (AGENTS.md). DOCX conversion shells out to
pandoc, so a missing pandoc fails here loudly rather than silently.
"""

from __future__ import annotations

import os
import sys
import tempfile
import time
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
CONVERTER = REPO / "converter"
sys.path.insert(0, str(CONVERTER))

os.environ.setdefault(
    "WORKSPACE_ROOT", str(Path(tempfile.gettempdir()) / "doc2md-smoke-docx")
)

from app.converters.docx import DocxConverter  # noqa: E402
from app.security.validation import SourceType, validate_source_file  # noqa: E402
from app.services.workspace import JobWorkspace  # noqa: E402

FIXTURES = REPO / "tests" / "converter" / "fixtures" / "generated"


def run(fixture: Path) -> None:
    print("=" * 70)
    print(fixture.name)
    print("=" * 70)

    validate_source_file(fixture, SourceType.DOCX)

    with JobWorkspace(f"smoke-{fixture.stem}") as workspace:
        target = workspace.source_path(".docx")
        target.write_bytes(fixture.read_bytes())

        started = time.perf_counter()
        result = DocxConverter(workspace, output_stem=fixture.stem).convert(target)
        elapsed = (time.perf_counter() - started) * 1000

        print(result.markdown_path.read_text(encoding="utf-8"))
        print(
            f"-- pages={result.pages_or_slides} media={result.media_count} "
            f"elapsed={elapsed:.0f}ms"
        )
        for warning in result.warnings:
            print(f"-- warning: {warning}")
        print(f"-- media files: {sorted(p.name for p in workspace.media_dir.glob('*'))}")
        print()


def main() -> int:
    for name in ("simple.docx", "headings.docx", "table.docx", "images.docx"):
        fixture = FIXTURES / name
        if not fixture.exists():
            print(f"missing fixture: {name}")
            return 1
        run(fixture)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

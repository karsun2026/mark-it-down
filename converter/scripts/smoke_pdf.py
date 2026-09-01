"""Ad-hoc smoke run of the PDF converter against the generated fixtures.

    .venv/Scripts/python.exe scripts/smoke_pdf.py
"""

from __future__ import annotations

import os
import sys
import tempfile
import time
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO / "converter"))
os.environ.setdefault(
    "WORKSPACE_ROOT", str(Path(tempfile.gettempdir()) / "doc2md-smoke-pdf")
)

from app.converters.pdf import PdfConverter  # noqa: E402
from app.security.validation import SourceType, validate_source_file  # noqa: E402
from app.services.workspace import JobWorkspace  # noqa: E402

FIXTURES = REPO / "tests" / "converter" / "fixtures" / "generated"


def run(fixture: Path) -> None:
    print("=" * 70)
    print(fixture.name)
    print("=" * 70)

    validate_source_file(fixture, SourceType.PDF)

    with JobWorkspace(f"smoke-{fixture.stem}") as workspace:
        target = workspace.source_path(".pdf")
        target.write_bytes(fixture.read_bytes())

        started = time.perf_counter()
        result = PdfConverter(workspace, output_stem=fixture.stem).convert(target)
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
    for name in ("text.pdf", "multipage.pdf", "images.pdf", "scanned-like.pdf"):
        fixture = FIXTURES / name
        if not fixture.exists():
            print(f"missing fixture: {name}")
            return 1
        run(fixture)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

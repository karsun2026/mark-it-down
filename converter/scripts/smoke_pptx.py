"""Ad-hoc smoke run of the PPTX converter against the generated fixtures.

    .venv/Scripts/python.exe scripts/smoke_pptx.py

Prints the produced Markdown so the output contract can be eyeballed before
the assertions in tests/converter/test_pptx.py are trusted.
"""

from __future__ import annotations

import os
import sys
import tempfile
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
CONVERTER = REPO / "converter"
sys.path.insert(0, str(CONVERTER))

# Point the workspace at a real temp dir before app.config is imported.
os.environ.setdefault(
    "WORKSPACE_ROOT", str(Path(tempfile.gettempdir()) / "doc2md-smoke")
)

from app.converters.pptx import PptxConverter  # noqa: E402
from app.security.validation import SourceType, validate_source_file  # noqa: E402
from app.services.workspace import JobWorkspace  # noqa: E402

FIXTURES = REPO / "tests" / "converter" / "fixtures" / "generated"


def run(fixture: Path) -> None:
    print("=" * 70)
    print(fixture.name)
    print("=" * 70)

    validate_source_file(fixture, SourceType.PPTX)

    with JobWorkspace(f"smoke-{fixture.stem}") as workspace:
        target = workspace.source_path(".pptx")
        target.write_bytes(fixture.read_bytes())

        converter = PptxConverter(workspace, output_stem=fixture.stem)
        result = converter.convert(target)

        print(result.markdown_path.read_text(encoding="utf-8"))
        print(f"-- slides={result.pages_or_slides} media={result.media_count}")
        if result.warnings:
            for warning in result.warnings:
                print(f"-- warning: {warning}")
        media = sorted(p.name for p in workspace.media_dir.glob("*"))
        print(f"-- media files: {media}")
        print()


def main() -> int:
    names = ["text-only.pptx", "tables.pptx", "images.pptx", "grouped-shapes.pptx"]
    for name in names:
        fixture = FIXTURES / name
        if not fixture.exists():
            print(f"missing fixture: {name}")
            return 1
        run(fixture)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

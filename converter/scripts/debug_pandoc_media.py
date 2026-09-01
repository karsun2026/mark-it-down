"""Inspect exactly what Pandoc emits for a DOCX with images.

    .venv/Scripts/python.exe scripts/debug_pandoc_media.py

Prints the raw Markdown and the resulting output tree so the media-path
normalisation can be matched against Pandoc's real behaviour rather than an
assumption about it.
"""

from __future__ import annotations

import os
import subprocess
import sys
import tempfile
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO / "converter"))
os.environ.setdefault(
    "WORKSPACE_ROOT", str(Path(tempfile.gettempdir()) / "doc2md-debug")
)

from app.config import settings  # noqa: E402
from app.services.workspace import JobWorkspace  # noqa: E402

FIXTURE = REPO / "tests" / "converter" / "fixtures" / "generated" / "images.docx"


def main() -> int:
    with JobWorkspace("pandoc-debug") as workspace:
        source = workspace.source_path(".docx")
        source.write_bytes(FIXTURE.read_bytes())
        markdown_path = workspace.markdown_path("doc")
        markdown_path.parent.mkdir(parents=True, exist_ok=True)

        argv = [
            settings.pandoc_binary,
            "--from=docx",
            "--to=gfm",
            "--wrap=none",
            f"--extract-media={os.environ.get('EXTRACT_MEDIA', workspace.output_dir)}",
            f"--output={markdown_path}",
            str(source),
        ]
        print("argv:", argv, "\n")

        completed = subprocess.run(  # noqa: S603
            argv,
            capture_output=True,
            text=True,
            timeout=120,
            check=False,
            cwd=str(workspace.output_dir),
        )
        print("returncode:", completed.returncode)
        if completed.stderr:
            print("stderr:", completed.stderr[:2000])

        print("\n--- RAW MARKDOWN ---")
        print(markdown_path.read_text(encoding="utf-8"))

        print("--- OUTPUT TREE ---")
        for path in sorted(workspace.output_dir.rglob("*")):
            kind = "dir " if path.is_dir() else "file"
            rel = path.relative_to(workspace.output_dir).as_posix()
            size = path.stat().st_size if path.is_file() else ""
            print(f"  {kind} {rel} {size}")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())

"""Verify the §37 Markdown output contract on a real conversion.

    .venv/Scripts/python.exe scripts/check_encoding.py

Checks UTF-8, LF-only line endings, and that the em dash survives as U+2014
rather than being mangled by the platform's console codepage.
"""

from __future__ import annotations

import os
import sys
import tempfile
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO / "converter"))
os.environ.setdefault(
    "WORKSPACE_ROOT", str(Path(tempfile.gettempdir()) / "doc2md-encoding")
)

from app.converters.pptx import PptxConverter  # noqa: E402
from app.services.workspace import JobWorkspace  # noqa: E402

FIXTURE = REPO / "tests" / "converter" / "fixtures" / "generated" / "text-only.pptx"


def main() -> int:
    with JobWorkspace("encoding-check") as workspace:
        target = workspace.source_path(".pptx")
        target.write_bytes(FIXTURE.read_bytes())
        result = PptxConverter(workspace, output_stem="text-only").convert(target)
        raw = result.markdown_path.read_bytes()

    checks: list[tuple[str, bool, str]] = []

    try:
        text = raw.decode("utf-8")
        checks.append(("decodes as UTF-8", True, ""))
    except UnicodeDecodeError as exc:
        checks.append(("decodes as UTF-8", False, str(exc)))
        text = ""

    checks.append(("no CRLF line endings", b"\r\n" not in raw, ""))
    checks.append(("no UTF-8 BOM", not raw.startswith(b"\xef\xbb\xbf"), ""))
    checks.append(
        ("em dash stored as U+2014 (e2 80 94)", b"\xe2\x80\x94" in raw, "")
    )
    checks.append(("no replacement char U+FFFD", "\ufffd" not in text, ""))
    checks.append(("no /tmp path leaked", "/tmp" not in text, ""))
    checks.append(("no Windows path leaked", "C:\\" not in text, ""))

    failed = 0
    for label, ok, detail in checks:
        if ok:
            print(f"  ok    {label}")
        else:
            failed += 1
            print(f"  FAIL  {label} {detail}")

    heading = text.splitlines()[0] if text else ""
    print(f"\nfirst heading bytes: {heading.encode('utf-8')!r}")
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())

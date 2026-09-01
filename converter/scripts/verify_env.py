"""Verify the converter's runtime dependencies import and report their versions.

Run after any dependency change:

    .venv/Scripts/python.exe scripts/verify_env.py

Exits non-zero if any runtime import fails, so CI can gate on it.
"""

from __future__ import annotations

import importlib
import sys

# (import name, distribution label)
RUNTIME_MODULES = [
    ("fastapi", "fastapi"),
    ("uvicorn", "uvicorn"),
    ("httpx", "httpx"),
    ("pptx", "python-pptx"),
    ("pypdf", "pypdf"),
    ("pdfplumber", "pdfplumber"),
    ("PIL", "Pillow"),
]

DEV_MODULES = [
    ("pytest", "pytest"),
    ("docx", "python-docx (fixtures only)"),
    ("fpdf", "fpdf2 (fixtures only)"),
]


def _report(modules: list[tuple[str, str]]) -> list[str]:
    failures: list[str] = []
    for import_name, label in modules:
        try:
            module = importlib.import_module(import_name)
        except Exception as exc:  # noqa: BLE001 - we want the reason verbatim
            failures.append(f"{label}: {exc}")
            print(f"  FAIL  {label:<28} {exc}")
            continue
        version = getattr(module, "__version__", "unknown")
        print(f"  ok    {label:<28} {version}")
    return failures


def main() -> int:
    print(f"Python {sys.version.split()[0]}")
    print("\nRuntime dependencies:")
    failures = _report(RUNTIME_MODULES)

    print("\nDev/test dependencies:")
    _report(DEV_MODULES)

    if failures:
        print(f"\n{len(failures)} runtime dependency failure(s).")
        return 1

    print("\nAll runtime dependencies import cleanly.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

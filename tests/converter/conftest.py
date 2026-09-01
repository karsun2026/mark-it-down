"""Shared test fixtures.

The workspace root is redirected to a pytest tmp dir before `app.config` is
imported, so no test ever writes to a real /tmp/doc2md.
"""

from __future__ import annotations

import dataclasses
import os
import sys
import tempfile
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[2]
CONVERTER_ROOT = REPO_ROOT / "converter"
FIXTURE_DIR = Path(__file__).parent / "fixtures" / "generated"

if str(CONVERTER_ROOT) not in sys.path:
    sys.path.insert(0, str(CONVERTER_ROOT))

os.environ.setdefault(
    "WORKSPACE_ROOT", str(Path(tempfile.gettempdir()) / "doc2md-pytest")
)


def pytest_configure(config: pytest.Config) -> None:
    """Fail fast with a clear message if fixtures were never generated."""
    if not FIXTURE_DIR.is_dir() or not any(FIXTURE_DIR.iterdir()):
        raise pytest.UsageError(
            "Test fixtures are missing. Generate them with:\n"
            "  .venv/Scripts/python.exe "
            "../tests/converter/fixtures/build_fixtures.py"
        )


@pytest.fixture
def fixture_dir() -> Path:
    return FIXTURE_DIR


@pytest.fixture
def fixture_path(fixture_dir: Path):
    def _get(name: str) -> Path:
        path = fixture_dir / name
        if not path.exists():
            pytest.skip(f"fixture not generated: {name}")
        return path

    return _get


@pytest.fixture
def workspace(tmp_path, monkeypatch):
    """A JobWorkspace rooted inside pytest's tmp_path."""
    from app import config as config_module
    from app.services import workspace as workspace_module

    # Settings is a frozen dataclass: replace the object, not a field.
    rooted = dataclasses.replace(config_module.settings, workspace_root=tmp_path)
    monkeypatch.setattr(config_module, "settings", rooted)
    monkeypatch.setattr(workspace_module, "settings", rooted)

    job = workspace_module.JobWorkspace("test-job", reservation_bytes=0)
    with job:
        yield job

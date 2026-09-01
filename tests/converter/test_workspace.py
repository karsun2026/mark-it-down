"""Workspace and quota tests (ENGINEERING_SPEC.md §21, §22, §23; DEVIATIONS D-001)."""

from __future__ import annotations

import dataclasses

import pytest

from app.errors import ConversionError, ErrorCode
from app.services import workspace as workspace_module
from app.services.workspace import (
    JobWorkspace,
    WorkspaceBudget,
    directory_size,
    probe_disk,
)


class TestLayout:
    """§21 - the fixed directory layout, and nothing outside it."""

    def test_creates_expected_directories(self, workspace) -> None:
        assert workspace.source_dir.is_dir()
        assert workspace.media_dir.is_dir()
        assert workspace.result_dir.is_dir()
        assert workspace.media_dir.parent == workspace.output_dir

    def test_contains_accepts_internal_paths(self, workspace) -> None:
        assert workspace.contains(workspace.output_dir / "a.md")
        assert workspace.contains(workspace.media_dir / "img.png")

    def test_contains_rejects_external_paths(self, workspace) -> None:
        assert not workspace.contains(workspace.root.parent / "escape.md")

    def test_assert_within_rejects_traversal(self, workspace) -> None:
        with pytest.raises(ConversionError) as caught:
            workspace.assert_within(workspace.output_dir / ".." / ".." / "x.md")
        assert caught.value.code is ErrorCode.CONVERSION_FAILED

    def test_cleanup_removes_tree(self, tmp_path, monkeypatch) -> None:
        monkeypatch.setattr(
            workspace_module,
            "settings",
            dataclasses.replace(workspace_module.settings, workspace_root=tmp_path),
        )
        job = JobWorkspace("disposable", reservation_bytes=0)
        with job:
            (job.output_dir).mkdir(parents=True, exist_ok=True)
            (job.output_dir / "f.md").write_text("x", encoding="utf-8")
            root = job.root
            assert root.exists()
        assert not root.exists()

    def test_tree_removed_even_when_job_raises(self, tmp_path, monkeypatch) -> None:
        monkeypatch.setattr(
            workspace_module,
            "settings",
            dataclasses.replace(workspace_module.settings, workspace_root=tmp_path),
        )
        job = JobWorkspace("failing", reservation_bytes=0)
        root = None
        with pytest.raises(RuntimeError), job:
            root = job.root
            raise RuntimeError("conversion blew up")
        assert root is not None and not root.exists()


class TestGlobalBudget:
    """D-001 - the budget is global, so concurrency cannot oversubscribe /tmp."""

    def test_reserves_and_releases(self) -> None:
        budget = WorkspaceBudget(1000)
        budget.reserve(600)
        assert budget.available_bytes == 400
        budget.release(600)
        assert budget.available_bytes == 1000

    def test_second_job_refused_when_budget_exhausted(self) -> None:
        """The exact condition the spec's 2 x 425MB pairing would create."""
        budget = WorkspaceBudget(1000)
        budget.reserve(700)
        with pytest.raises(ConversionError) as caught:
            budget.reserve(700)
        assert caught.value.code is ErrorCode.SERVICE_UNAVAILABLE
        # The refused reservation must not be counted.
        assert budget.available_bytes == 300

    def test_release_never_goes_negative(self) -> None:
        budget = WorkspaceBudget(1000)
        budget.reserve(100)
        budget.release(500)
        assert budget.reserved_bytes == 0

    def test_failed_entry_releases_reservation(self, tmp_path, monkeypatch) -> None:
        monkeypatch.setattr(
            workspace_module,
            "settings",
            dataclasses.replace(workspace_module.settings, workspace_root=tmp_path),
        )
        budget = WorkspaceBudget(100)
        monkeypatch.setattr(workspace_module, "budget", budget)

        job = JobWorkspace("too-big", reservation_bytes=500)
        with pytest.raises(ConversionError):
            job.__enter__()
        assert budget.reserved_bytes == 0


class TestOutputQuota:
    """§22, §23 - refuse to expand past the budget rather than filling /tmp."""

    def test_within_quota_returns_size(self, workspace) -> None:
        (workspace.output_dir).mkdir(parents=True, exist_ok=True)
        (workspace.output_dir / "a.md").write_bytes(b"x" * 1000)
        assert workspace.enforce_output_quota() >= 1000

    def test_over_quota_raises_expansion_error(self, workspace, monkeypatch) -> None:
        (workspace.output_dir).mkdir(parents=True, exist_ok=True)
        (workspace.output_dir / "big.bin").write_bytes(b"x" * 5000)
        monkeypatch.setattr(
            workspace_module,
            "settings",
            dataclasses.replace(
                workspace_module.settings, max_output_tree_bytes=1000
            ),
        )
        with pytest.raises(ConversionError) as caught:
            workspace.enforce_output_quota()
        assert caught.value.code is ErrorCode.DOCUMENT_EXPANDS_TOO_LARGE

    def test_directory_size_counts_nested_files(self, workspace) -> None:
        workspace.media_dir.mkdir(parents=True, exist_ok=True)
        (workspace.media_dir / "a.png").write_bytes(b"x" * 10)
        (workspace.media_dir / "b.png").write_bytes(b"y" * 20)
        assert directory_size(workspace.output_dir) == 30

    def test_directory_size_of_missing_dir_is_zero(self, tmp_path) -> None:
        assert directory_size(tmp_path / "nope") == 0

    def test_delete_local_source_frees_space(self, workspace) -> None:
        """§22 - the source goes before the ZIP is written."""
        source = workspace.source_path(".pdf")
        source.write_bytes(b"x" * 4096)
        assert workspace.source_dir.exists()
        workspace.delete_local_source()
        assert not workspace.source_dir.exists()


class TestDiskProbe:
    """§4's ~500MB /tmp is undocumented, so it is measured, not assumed."""

    def test_probe_reports_positive_capacity(self, tmp_path) -> None:
        probe = probe_disk(tmp_path)
        assert probe.total_bytes > 0
        assert probe.free_bytes >= 0

    def test_probe_walks_up_to_existing_ancestor(self, tmp_path) -> None:
        probe = probe_disk(tmp_path / "does" / "not" / "exist")
        assert probe.total_bytes > 0

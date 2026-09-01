"""Killable child-process conversion (Amendment A1.6, A8.2).

A8.2 requires: a conversion that exceeds the timeout returns CONVERSION_TIMEOUT,
leaves no workspace residue, and does not leak the child process.

These run real child processes, so they are slower than the rest of the suite.
That is the point — the mechanism cannot be verified with a mock, because what
is being tested is that an OS process actually dies.
"""

from __future__ import annotations

import multiprocessing
import time

import pytest

from app.errors import ConversionError, ErrorCode
from app.services.child_runner import run_conversion_in_child


@pytest.fixture
def pptx_source(workspace, fixture_path):
    source = workspace.source_path(".pptx")
    source.write_bytes(fixture_path("text-only.pptx").read_bytes())
    return source


class TestSuccessfulChildConversion:
    """The happy path must be indistinguishable from running in-process."""

    def test_returns_a_complete_result(self, workspace, pptx_source) -> None:
        result = run_conversion_in_child(
            workspace=workspace,
            source_path=pptx_source,
            source_type="pptx",
            output_stem="deck",
            timeout_seconds=120,
        )

        assert result.pages_or_slides == 2
        assert result.markdown_path.is_file()
        assert result.markdown_path.name == "deck.md"

    def test_child_output_lands_in_the_parent_workspace(
        self, workspace, pptx_source
    ) -> None:
        """The child must write into the workspace the parent budgeted."""
        result = run_conversion_in_child(
            workspace=workspace,
            source_path=pptx_source,
            source_type="pptx",
            output_stem="deck",
            timeout_seconds=120,
        )
        assert workspace.contains(result.markdown_path)
        text = result.markdown_path.read_text(encoding="utf-8")
        assert "## Slide 1" in text

    def test_pdf_also_runs_in_a_child(self, workspace, fixture_path) -> None:
        source = workspace.source_path(".pdf")
        source.write_bytes(fixture_path("multipage.pdf").read_bytes())

        result = run_conversion_in_child(
            workspace=workspace,
            source_path=source,
            source_type="pdf",
            output_stem="doc",
            timeout_seconds=120,
        )
        assert result.pages_or_slides == 3

    def test_no_child_process_is_left_behind(self, workspace, pptx_source) -> None:
        run_conversion_in_child(
            workspace=workspace,
            source_path=pptx_source,
            source_type="pptx",
            output_stem="deck",
            timeout_seconds=120,
        )
        # Give the OS a moment to reap, then assert nothing lingers.
        deadline = time.time() + 5
        while multiprocessing.active_children() and time.time() < deadline:
            time.sleep(0.1)
        assert multiprocessing.active_children() == []


class TestTimeout:
    """A8.2's timeout requirement, verified against a real process."""

    def test_timeout_raises_conversion_timeout(
        self, workspace, pptx_source
    ) -> None:
        """No new error code: §46 stands as written (A1.6)."""
        with pytest.raises(ConversionError) as caught:
            run_conversion_in_child(
                workspace=workspace,
                source_path=pptx_source,
                source_type="pptx",
                output_stem="deck",
                # Shorter than a spawn can possibly complete in.
                timeout_seconds=0.01,
            )
        assert caught.value.code is ErrorCode.CONVERSION_TIMEOUT

    def test_timeout_kills_the_child(self, workspace, pptx_source) -> None:
        """The whole point of A1.6: the process is actually terminated."""
        with pytest.raises(ConversionError):
            run_conversion_in_child(
                workspace=workspace,
                source_path=pptx_source,
                source_type="pptx",
                output_stem="deck",
                timeout_seconds=0.01,
            )

        deadline = time.time() + 10
        while multiprocessing.active_children() and time.time() < deadline:
            time.sleep(0.1)
        assert multiprocessing.active_children() == [], (
            "a timed-out child must not survive its parent's give-up"
        )

    def test_timeout_message_leaks_nothing(self, workspace, pptx_source) -> None:
        with pytest.raises(ConversionError) as caught:
            run_conversion_in_child(
                workspace=workspace,
                source_path=pptx_source,
                source_type="pptx",
                output_stem="deck",
                timeout_seconds=0.01,
            )
        payload = caught.value.to_payload()
        assert set(payload) == {"code", "message"}
        assert "/tmp" not in payload["message"]
        assert str(workspace.root) not in payload["message"]


class TestFailurePropagation:
    """A ConversionError raised in the child keeps its code in the parent."""

    def test_invalid_source_keeps_its_error_code(self, workspace) -> None:
        source = workspace.source_path(".pptx")
        source.write_bytes(b"this is not a presentation")

        with pytest.raises(ConversionError) as caught:
            run_conversion_in_child(
                workspace=workspace,
                source_path=source,
                source_type="pptx",
                output_stem="deck",
                timeout_seconds=120,
            )
        # Crossed a process boundary and survived as the same stable code.
        assert caught.value.code is ErrorCode.CONVERSION_FAILED

    def test_missing_source_does_not_hang(self, workspace) -> None:
        """A child that cannot start work must still report, not block."""
        with pytest.raises(ConversionError):
            run_conversion_in_child(
                workspace=workspace,
                source_path=workspace.source_dir / "absent.pptx",
                source_type="pptx",
                output_stem="deck",
                timeout_seconds=120,
            )

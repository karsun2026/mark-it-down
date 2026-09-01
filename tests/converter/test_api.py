"""API surface tests (ENGINEERING_SPEC.md §28, §45)."""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from app.api import app


@pytest.fixture
def client() -> TestClient:
    return TestClient(app)


class TestHealth:
    def test_health_ok(self, client: TestClient) -> None:
        response = client.get("/converter/health")
        assert response.status_code == 200
        assert response.json() == {"status": "ok"}


class TestReadiness:
    def test_reports_all_required_checks(self, client: TestClient) -> None:
        body = client.get("/converter/ready").json()
        assert set(body["checks"]) == {
            "pandoc",
            "python_pptx",
            "pypdf",
            "pdfplumber",
            "tmp_writable",
        }

    def test_python_dependencies_present(self, client: TestClient) -> None:
        checks = client.get("/converter/ready").json()["checks"]
        assert checks["python_pptx"] is True
        assert checks["pypdf"] is True
        assert checks["pdfplumber"] is True
        assert checks["tmp_writable"] is True

    def test_status_code_matches_readiness(self, client: TestClient) -> None:
        response = client.get("/converter/ready")
        body = response.json()
        expected = 200 if all(body["checks"].values()) else 503
        assert response.status_code == expected

    def test_reveals_no_filesystem_paths(self, client: TestClient) -> None:
        """§28 - readiness must not expose paths or secrets."""
        raw = client.get("/converter/ready").text
        assert "/tmp" not in raw
        assert "C:\\" not in raw
        assert "Users" not in raw

    def test_reports_capacity_numbers(self, client: TestClient) -> None:
        body = client.get("/converter/ready").json()
        assert isinstance(body["workspace_free_mb"], int)
        assert body["workspace_budget_mb"] > 0
        assert body["max_concurrent_conversions"] >= 1


class TestDocsDisabled:
    """An internal service should not publish an interactive schema."""

    @pytest.mark.parametrize("path", ["/docs", "/redoc", "/openapi.json"])
    def test_docs_endpoints_absent(self, client: TestClient, path: str) -> None:
        assert client.get(path).status_code == 404

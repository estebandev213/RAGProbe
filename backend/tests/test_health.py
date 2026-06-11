"""Tests for the app factory and the /api/health endpoint."""

import pytest
from app.config import get_settings
from app.main import create_app
from fastapi.testclient import TestClient


@pytest.fixture
def client(monkeypatch: pytest.MonkeyPatch) -> TestClient:
    monkeypatch.setenv("GROQ_API_KEY", "test-key")
    get_settings.cache_clear()
    return TestClient(create_app())


def test_health_returns_ok_and_version(client: TestClient) -> None:
    resp = client.get("/api/health")
    assert resp.status_code == 200
    body = resp.json()
    assert body["ok"] is True
    assert body["version"]


def test_unknown_route_uses_error_envelope(client: TestClient) -> None:
    resp = client.get("/api/does-not-exist")
    assert resp.status_code == 404
    body = resp.json()
    assert set(body) == {"detail", "code"}
    assert body["code"] == "http_error"

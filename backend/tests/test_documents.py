"""API tests for document upload and listing."""

from collections.abc import Iterator
from pathlib import Path

import pytest
from app.config import get_settings
from app.main import create_app
from fastapi.testclient import TestClient

from tests.test_ingestion import _make_pdf


@pytest.fixture
def client(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> Iterator[TestClient]:
    db_path = str(tmp_path / "test.db")
    monkeypatch.setenv("GROQ_API_KEY", "test-key")
    monkeypatch.setenv("DATABASE_PATH", db_path)
    get_settings.cache_clear()
    yield TestClient(create_app())
    get_settings.cache_clear()


def test_upload_markdown_stores_document(client: TestClient) -> None:
    resp = client.post(
        "/api/documents",
        files={"file": ("notes.md", b"# Title\n\nBody.", "text/markdown")},
    )
    assert resp.status_code == 201
    body = resp.json()
    assert body["name"] == "notes.md"
    assert body["mime"] == "text/markdown"
    assert body["char_count"] == len("# Title\n\nBody.")
    assert body["id"]


def test_upload_pdf_stores_text(client: TestClient) -> None:
    resp = client.post(
        "/api/documents",
        files={"file": ("doc.pdf", _make_pdf("Meridian stores documents"), "application/pdf")},
    )
    assert resp.status_code == 201
    body = resp.json()
    assert body["mime"] == "application/pdf"
    assert body["char_count"] > 0


def test_upload_rejects_bad_mime_with_422(client: TestClient) -> None:
    resp = client.post(
        "/api/documents",
        files={"file": ("data.csv", b"a,b,c", "text/csv")},
    )
    assert resp.status_code == 422
    body = resp.json()
    assert set(body) == {"detail", "code"}


def test_upload_rejects_oversized_file_with_413(client: TestClient) -> None:
    oversized = b"x" * (2 * 1024 * 1024 + 1)
    resp = client.post(
        "/api/documents",
        files={"file": ("big.txt", oversized, "text/plain")},
    )
    assert resp.status_code == 413


def test_list_documents_returns_uploaded(client: TestClient) -> None:
    assert client.get("/api/documents").json() == []

    client.post(
        "/api/documents",
        files={"file": ("a.txt", b"first", "text/plain")},
    )
    client.post(
        "/api/documents",
        files={"file": ("b.txt", b"second", "text/plain")},
    )

    listed = client.get("/api/documents").json()
    assert len(listed) == 2
    assert {d["name"] for d in listed} == {"a.txt", "b.txt"}

"""Tests for embedding storage (sqlite-vec) and the BM25 builder.

The real fastembed model is never loaded here: ``index_document`` takes an
injectable embedder, so tests supply deterministic synthetic vectors and stay
offline and fast.
"""

import sqlite3
from collections.abc import Sequence

import pytest
import sqlite_vec
from app.core.chunking import CHUNK_SIZES
from app.core.indexing import (
    EMBED_DIM,
    build_bm25_index,
    index_document,
    tokenize_for_bm25,
)
from app.db import connect, run_migrations


def _one_hot(dim: int) -> list[float]:
    """A 384-dim unit vector with a single nonzero component at ``dim``."""
    return [1.0 if i == dim else 0.0 for i in range(EMBED_DIM)]


def _fake_embedder(texts: Sequence[str]) -> list[list[float]]:
    """Map the i-th text to the i-th one-hot basis vector (distinct, predictable)."""
    return [_one_hot(i) for i, _ in enumerate(texts)]


@pytest.fixture
def conn() -> sqlite3.Connection:
    connection = connect(":memory:")
    run_migrations(connection)
    connection.execute(
        "INSERT INTO documents (id, name, mime, text, char_count, created_at) "
        "VALUES (?, ?, ?, ?, ?, ?)",
        ("doc1", "d.md", "text/markdown", "x", 1, "2026-01-01T00:00:00+00:00"),
    )
    return connection


def test_index_document_stores_chunks_and_matching_vectors(conn: sqlite3.Connection) -> None:
    text = "Meridian stores data as collections of JSON documents. " * 50
    total = index_document(conn, "doc1", text, embed=_fake_embedder)

    chunk_count = conn.execute("SELECT COUNT(*) FROM chunks").fetchone()[0]
    vec_count = conn.execute("SELECT COUNT(*) FROM vec_chunks").fetchone()[0]
    sizes = {row[0] for row in conn.execute("SELECT DISTINCT chunk_size FROM chunks")}

    assert total == chunk_count > 0
    assert vec_count == chunk_count  # one vector per chunk
    assert sizes == set(CHUNK_SIZES)  # every configured chunk size indexed


def test_index_document_is_idempotent(conn: sqlite3.Connection) -> None:
    text = "Meridian stores data as collections of JSON documents. " * 50
    first = index_document(conn, "doc1", text, embed=_fake_embedder)
    second = index_document(conn, "doc1", text, embed=_fake_embedder)

    assert first == second
    assert conn.execute("SELECT COUNT(*) FROM chunks").fetchone()[0] == second


def test_vectors_are_queryable_by_knn(conn: sqlite3.Connection) -> None:
    conn.executemany(
        "INSERT INTO vec_chunks (chunk_id, embedding) VALUES (?, ?)",
        [
            ("near", sqlite_vec.serialize_float32(_one_hot(0))),
            ("far", sqlite_vec.serialize_float32(_one_hot(7))),
        ],
    )
    rows = conn.execute(
        "SELECT chunk_id FROM vec_chunks WHERE embedding MATCH ? ORDER BY distance LIMIT 1",
        (sqlite_vec.serialize_float32(_one_hot(0)),),
    ).fetchall()

    assert rows[0]["chunk_id"] == "near"


def test_bm25_ranks_matching_chunk_first() -> None:
    chunk_ids = ["c0", "c1", "c2"]
    texts = [
        "rebalancing moves whole partitions between nodes",
        "snapshot reads are served from any replica",
        "incremental backups ship the replication log",
    ]
    index = build_bm25_index(chunk_ids, texts)

    scores = index.bm25.get_scores(tokenize_for_bm25("how does rebalancing move partitions"))
    best = index.chunk_ids[max(range(len(scores)), key=lambda i: scores[i])]

    assert best == "c0"

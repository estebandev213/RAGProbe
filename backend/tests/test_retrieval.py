"""Tests for the vector, BM25, and hybrid (RRF) retrievers (§6.2)."""

import sqlite3
from collections.abc import Sequence

import pytest
import sqlite_vec
from app.core.indexing import EMBED_DIM, Embedder
from app.core.retrieval import (
    BM25Retriever,
    HybridRetriever,
    ScoredChunk,
    VectorRetriever,
    make_retriever,
    reciprocal_rank_fusion,
)
from app.db import connect, run_migrations


def _vec(*head: float) -> list[float]:
    """A 384-dim vector with the given leading components, zero-padded."""
    v = [0.0] * EMBED_DIM
    for i, x in enumerate(head):
        v[i] = x
    return v


def _const_embedder(vector: Sequence[float]) -> Embedder:
    def embed(texts: Sequence[str]) -> list[list[float]]:
        return [list(vector) for _ in texts]

    return embed


def _insert_doc(conn: sqlite3.Connection, doc_id: str) -> None:
    conn.execute(
        "INSERT OR IGNORE INTO documents (id, name, mime, text, char_count, created_at) "
        "VALUES (?, ?, ?, ?, ?, ?)",
        (doc_id, f"{doc_id}.md", "text/markdown", "x", 1, "2026-01-01T00:00:00+00:00"),
    )


def _insert_chunk(
    conn: sqlite3.Connection,
    chunk_id: str,
    document_id: str,
    chunk_size: int,
    idx: int,
    text: str,
    embedding: Sequence[float] | None = None,
) -> None:
    _insert_doc(conn, document_id)
    conn.execute(
        "INSERT INTO chunks (id, document_id, chunk_size, idx, text, start_char, end_char) "
        "VALUES (?, ?, ?, ?, ?, ?, ?)",
        (chunk_id, document_id, chunk_size, idx, text, 0, len(text)),
    )
    if embedding is not None:
        conn.execute(
            "INSERT INTO vec_chunks (chunk_id, embedding) VALUES (?, ?)",
            (chunk_id, sqlite_vec.serialize_float32(list(embedding))),
        )
    conn.commit()


@pytest.fixture
def conn() -> sqlite3.Connection:
    connection = connect(":memory:")
    run_migrations(connection)
    return connection


def _sc(chunk_id: str, score: float = 0.0) -> ScoredChunk:
    return ScoredChunk(
        chunk_id=chunk_id,
        document_id="d1",
        chunk_size=400,
        idx=0,
        text="",
        start_char=0,
        end_char=0,
        score=score,
    )


# ---------------------------------------------------------------------------
# RRF — hand-computed fixture (primary acceptance criterion)
# ---------------------------------------------------------------------------


def test_rrf_matches_hand_computed_fixture() -> None:
    # list 1 ranks: a(1), b(2), c(3); list 2 ranks: b(1), d(2), a(3); k=60.
    vector = [_sc("a"), _sc("b"), _sc("c")]
    bm25 = [_sc("b"), _sc("d"), _sc("a")]

    fused = reciprocal_rank_fusion((vector, bm25), k=60)

    expected = {
        "a": 1 / 61 + 1 / 63,
        "b": 1 / 62 + 1 / 61,
        "c": 1 / 63,
        "d": 1 / 62,
    }
    # b > a > d > c by the values above.
    assert [c.chunk_id for c in fused] == ["b", "a", "d", "c"]
    for chunk in fused:
        assert chunk.score == pytest.approx(expected[chunk.chunk_id])


def test_rrf_respects_top_k() -> None:
    fused = reciprocal_rank_fusion(([_sc("a"), _sc("b")], [_sc("b"), _sc("c")]), top_k=2)
    assert [c.chunk_id for c in fused] == ["b", "a"]


def test_rrf_ties_break_on_chunk_id() -> None:
    # Symmetric input → equal scores → deterministic alphabetical order.
    fused = reciprocal_rank_fusion(([_sc("y"), _sc("x")], [_sc("x"), _sc("y")]))
    assert [c.chunk_id for c in fused] == ["x", "y"]


# ---------------------------------------------------------------------------
# Vector retriever
# ---------------------------------------------------------------------------


def test_vector_ranks_nearest_and_respects_top_k(conn: sqlite3.Connection) -> None:
    # Distances to query [1,0]: c1=0 < c2=0.63 < c3=0.89 < c4=1.41.
    _insert_chunk(conn, "c1", "d1", 400, 0, "c1", _vec(1.0, 0.0))
    _insert_chunk(conn, "c2", "d1", 400, 1, "c2", _vec(0.8, 0.6))
    _insert_chunk(conn, "c3", "d1", 400, 2, "c3", _vec(0.6, 0.8))
    _insert_chunk(conn, "c4", "d1", 400, 3, "c4", _vec(0.0, 1.0))

    retriever = VectorRetriever(conn, ["d1"], embed=_const_embedder(_vec(1.0, 0.0)))
    hits = retriever.retrieve("q", 400, top_k=2)

    assert [h.chunk_id for h in hits] == ["c1", "c2"]
    assert hits[0].score > hits[1].score


def test_vector_scopes_by_document(conn: sqlite3.Connection) -> None:
    # c_other is the nearest (identical vector) but lives in an out-of-scope doc.
    _insert_chunk(conn, "c_in", "d1", 400, 0, "in", _vec(1.0, 0.0))
    _insert_chunk(conn, "c_other", "d2", 400, 0, "other", _vec(1.0, 0.0))

    retriever = VectorRetriever(conn, ["d1"], embed=_const_embedder(_vec(1.0, 0.0)))
    hits = retriever.retrieve("q", 400, top_k=5)

    assert [h.chunk_id for h in hits] == ["c_in"]


def test_vector_filters_by_chunk_size(conn: sqlite3.Connection) -> None:
    _insert_chunk(conn, "small", "d1", 400, 0, "s", _vec(1.0, 0.0))
    _insert_chunk(conn, "big", "d1", 800, 0, "b", _vec(1.0, 0.0))

    retriever = VectorRetriever(conn, ["d1"], embed=_const_embedder(_vec(1.0, 0.0)))
    assert [h.chunk_id for h in retriever.retrieve("q", 400, 5)] == ["small"]
    assert [h.chunk_id for h in retriever.retrieve("q", 800, 5)] == ["big"]


def test_vector_empty_scope_returns_empty(conn: sqlite3.Connection) -> None:
    retriever = VectorRetriever(conn, [], embed=_const_embedder(_vec(1.0)))
    assert retriever.retrieve("q", 400, 5) == []


# ---------------------------------------------------------------------------
# BM25 retriever
# ---------------------------------------------------------------------------


def test_bm25_ranks_keyword_match_first(conn: sqlite3.Connection) -> None:
    _insert_chunk(conn, "c1", "d1", 400, 0, "rebalancing moves whole partitions between nodes")
    _insert_chunk(conn, "c2", "d1", 400, 1, "snapshot reads are served from any replica")
    _insert_chunk(conn, "c3", "d1", 400, 2, "incremental backups ship the replication log")

    retriever = BM25Retriever(conn, ["d1"])
    hits = retriever.retrieve("how does rebalancing move partitions", 400, top_k=3)

    assert hits[0].chunk_id == "c1"
    assert len(hits) <= 3


def test_bm25_filters_by_chunk_size_and_scope(conn: sqlite3.Connection) -> None:
    _insert_chunk(conn, "small", "d1", 400, 0, "partitions rebalancing")
    _insert_chunk(conn, "big", "d1", 800, 0, "partitions rebalancing")
    _insert_chunk(conn, "other", "d2", 400, 0, "partitions rebalancing")

    retriever = BM25Retriever(conn, ["d1"])
    hits = retriever.retrieve("partitions", 400, top_k=5)

    assert [h.chunk_id for h in hits] == ["small"]


def test_bm25_empty_scope_returns_empty(conn: sqlite3.Connection) -> None:
    assert BM25Retriever(conn, []).retrieve("q", 400, 5) == []


# ---------------------------------------------------------------------------
# Hybrid retriever
# ---------------------------------------------------------------------------


def test_hybrid_merges_both_sources(conn: sqlite3.Connection) -> None:
    # c_vec wins on vectors (near the query), c_bm25 wins on keywords.
    _insert_chunk(conn, "c_vec", "d1", 400, 0, "unrelated filler text", _vec(1.0, 0.0))
    _insert_chunk(conn, "c_bm25", "d1", 400, 1, "partitions rebalancing nodes", _vec(0.0, 1.0))

    retriever = make_retriever("hybrid", conn, ["d1"], embed=_const_embedder(_vec(1.0, 0.0)))
    hits = retriever.retrieve("partitions rebalancing", 400, top_k=2)

    assert {h.chunk_id for h in hits} == {"c_vec", "c_bm25"}


# ---------------------------------------------------------------------------
# Factory
# ---------------------------------------------------------------------------


def test_make_retriever_returns_expected_types(conn: sqlite3.Connection) -> None:
    assert isinstance(make_retriever("vector", conn, ["d1"]), VectorRetriever)
    assert isinstance(make_retriever("bm25", conn, ["d1"]), BM25Retriever)
    assert isinstance(make_retriever("hybrid", conn, ["d1"]), HybridRetriever)


def test_make_retriever_rejects_unknown_strategy(conn: sqlite3.Connection) -> None:
    with pytest.raises(ValueError, match="Unknown strategy"):
        make_retriever("bogus", conn, ["d1"])

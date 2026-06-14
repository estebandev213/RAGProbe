"""Retrieval strategies behind one interface: vector, BM25, hybrid (§6.2).

All three retrievers are scoped to a run's documents at construction and expose
the same ``retrieve(query, chunk_size, top_k)`` method:

* **vector** — embeds the query and runs a KNN search over ``vec_chunks``. The
  ``sqlite-vec`` ``k`` constraint is applied *before* SQL joins, so a join that
  filters by ``chunk_size``/``document_id`` would silently drop valid hits. We
  therefore over-fetch (``k`` = total vectors), then let the join + ``LIMIT``
  pick the in-scope top_k. At demo scale this is cheap and exact. The table uses
  the default L2 metric; for fastembed's normalized embeddings L2 ranking is
  equivalent to cosine.
* **bm25** — an in-memory BM25 index per chunk size, built once per run from the
  scoped chunks (reuses the builder from :mod:`app.core.indexing`).
* **hybrid** — Reciprocal Rank Fusion of the vector and BM25 rankings.
"""

from __future__ import annotations

import sqlite3
from collections import defaultdict
from collections.abc import Sequence
from dataclasses import dataclass, replace
from typing import Protocol

import sqlite_vec

from app.core.chunking import CHUNK_SIZES
from app.core.indexing import (
    BM25Index,
    Embedder,
    build_bm25_index,
    embed_texts,
    tokenize_for_bm25,
)

STRATEGIES: tuple[str, ...] = ("vector", "bm25", "hybrid")

# Reciprocal Rank Fusion constant (§6.2): score = Σ 1 / (RRF_K + rank).
RRF_K = 60


@dataclass(frozen=True)
class ScoredChunk:
    """A retrieved chunk with its retrieval score.

    Carries the full chunk payload (text + offsets) so downstream answer
    generation and span-overlap scoring need no second lookup.
    """

    chunk_id: str
    document_id: str
    chunk_size: int
    idx: int
    text: str
    start_char: int
    end_char: int
    score: float


class Retriever(Protocol):
    """Common retrieval interface (§6.2)."""

    def retrieve(self, query: str, chunk_size: int, top_k: int) -> list[ScoredChunk]: ...


def _scored_from_row(row: sqlite3.Row, score: float) -> ScoredChunk:
    return ScoredChunk(
        chunk_id=row["id"],
        document_id=row["document_id"],
        chunk_size=row["chunk_size"],
        idx=row["idx"],
        text=row["text"],
        start_char=row["start_char"],
        end_char=row["end_char"],
        score=score,
    )


class VectorRetriever:
    """Dense retrieval via KNN over the ``vec_chunks`` sqlite-vec table."""

    def __init__(
        self,
        conn: sqlite3.Connection,
        doc_ids: Sequence[str],
        embed: Embedder = embed_texts,
    ) -> None:
        self._conn = conn
        self._doc_ids = list(doc_ids)
        self._embed = embed

    def retrieve(self, query: str, chunk_size: int, top_k: int) -> list[ScoredChunk]:
        if not self._doc_ids or top_k <= 0:
            return []
        total = int(self._conn.execute("SELECT COUNT(*) FROM vec_chunks").fetchone()[0])
        if total == 0:
            return []

        query_vec = self._embed([query])[0]
        placeholders = ",".join("?" for _ in self._doc_ids)
        # k is over-fetched to the full vector count (a trusted integer, not user
        # input) so the scope filters below cannot starve the result.
        sql = (
            "SELECT c.id, c.document_id, c.chunk_size, c.idx, c.text, "
            "c.start_char, c.end_char, v.distance "
            "FROM vec_chunks v JOIN chunks c ON c.id = v.chunk_id "
            f"WHERE v.embedding MATCH ? AND k = {total} "
            "AND c.chunk_size = ? "
            f"AND c.document_id IN ({placeholders}) "
            "ORDER BY v.distance LIMIT ?"
        )
        params = [sqlite_vec.serialize_float32(query_vec), chunk_size, *self._doc_ids, top_k]
        rows = self._conn.execute(sql, params).fetchall()
        # Map distance to a (0, 1] similarity; monotonic decreasing in distance.
        return [_scored_from_row(row, score=1.0 / (1.0 + row["distance"])) for row in rows]


class BM25Retriever:
    """Sparse keyword retrieval via in-memory BM25 indexes, one per chunk size."""

    def __init__(self, conn: sqlite3.Connection, doc_ids: Sequence[str]) -> None:
        self._doc_ids = list(doc_ids)
        self._indexes: dict[int, BM25Index] = {}
        self._rows: dict[str, sqlite3.Row] = {}
        if not self._doc_ids:
            return

        placeholders = ",".join("?" for _ in self._doc_ids)
        for chunk_size in CHUNK_SIZES:
            rows = conn.execute(
                "SELECT id, document_id, chunk_size, idx, text, start_char, end_char "
                f"FROM chunks WHERE chunk_size = ? AND document_id IN ({placeholders}) "
                "ORDER BY document_id, idx",
                [chunk_size, *self._doc_ids],
            ).fetchall()
            if not rows:
                continue
            ids = [row["id"] for row in rows]
            self._indexes[chunk_size] = build_bm25_index(ids, [row["text"] for row in rows])
            for row in rows:
                self._rows[row["id"]] = row

    def retrieve(self, query: str, chunk_size: int, top_k: int) -> list[ScoredChunk]:
        index = self._indexes.get(chunk_size)
        if index is None or top_k <= 0:
            return []
        scores = index.bm25.get_scores(tokenize_for_bm25(query))
        # Stable sort: equal BM25 scores keep corpus (document, idx) order.
        ranked = sorted(
            zip(index.chunk_ids, scores, strict=True),
            key=lambda pair: pair[1],
            reverse=True,
        )[:top_k]
        return [_scored_from_row(self._rows[cid], score=float(score)) for cid, score in ranked]


class HybridRetriever:
    """Reciprocal Rank Fusion of a vector and a BM25 retriever."""

    def __init__(self, vector: VectorRetriever, bm25: BM25Retriever) -> None:
        self._vector = vector
        self._bm25 = bm25

    def retrieve(self, query: str, chunk_size: int, top_k: int) -> list[ScoredChunk]:
        if top_k <= 0:
            return []
        vector_hits = self._vector.retrieve(query, chunk_size, top_k)
        bm25_hits = self._bm25.retrieve(query, chunk_size, top_k)
        return reciprocal_rank_fusion((vector_hits, bm25_hits), k=RRF_K, top_k=top_k)


def reciprocal_rank_fusion(
    ranked_lists: Sequence[Sequence[ScoredChunk]],
    k: int = RRF_K,
    top_k: int | None = None,
) -> list[ScoredChunk]:
    """Fuse ranked lists by ``score = Σ 1 / (k + rank)`` with 1-based ranks.

    Ties break deterministically on ``chunk_id``. The returned chunks carry the
    fused score; payloads come from the first list each chunk appears in.
    """
    fused: dict[str, float] = defaultdict(float)
    chunk_by_id: dict[str, ScoredChunk] = {}
    for ranked in ranked_lists:
        for rank, chunk in enumerate(ranked, start=1):
            fused[chunk.chunk_id] += 1.0 / (k + rank)
            chunk_by_id.setdefault(chunk.chunk_id, chunk)

    ordered = sorted(chunk_by_id, key=lambda cid: (-fused[cid], cid))
    result = [replace(chunk_by_id[cid], score=fused[cid]) for cid in ordered]
    return result if top_k is None else result[:top_k]


def make_retriever(
    strategy: str,
    conn: sqlite3.Connection,
    doc_ids: Sequence[str],
    embed: Embedder = embed_texts,
) -> Retriever:
    """Build the retriever for a strategy, constructing only what it needs."""
    if strategy == "vector":
        return VectorRetriever(conn, doc_ids, embed)
    if strategy == "bm25":
        return BM25Retriever(conn, doc_ids)
    if strategy == "hybrid":
        return HybridRetriever(
            VectorRetriever(conn, doc_ids, embed),
            BM25Retriever(conn, doc_ids),
        )
    raise ValueError(f"Unknown strategy {strategy!r}; expected one of {STRATEGIES}.")

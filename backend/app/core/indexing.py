"""Indexing: chunk a document, embed the chunks, and store both indexes.

Two indexes are built per document:

* **Vectors** — chunk texts are embedded locally with ``fastembed``
  (``BAAI/bge-small-en-v1.5``, 384 dims) and stored in the ``sqlite-vec``
  virtual table ``vec_chunks`` for cosine/KNN search.
* **BM25** — a keyword index built in memory from chunk texts.

The retrievers that *consume* these indexes (vector / bm25 / hybrid RRF) arrive
in the next commit (§6.2); this module only *builds* them. The embedder is
injectable so tests can supply deterministic vectors without downloading the
model.
"""

from __future__ import annotations

import logging
import re
import sqlite3
import uuid
from collections.abc import Callable, Sequence
from dataclasses import dataclass
from functools import lru_cache

import sqlite_vec
from rank_bm25 import BM25Okapi

from app.core.chunking import CHUNK_SIZES, chunk_document

logger = logging.getLogger("ragprobe")

# Local embedding model (§3). bge-small-en-v1.5 produces 384-dim vectors.
EMBED_MODEL = "BAAI/bge-small-en-v1.5"
EMBED_DIM = 384

# An embedder maps a batch of texts to a batch of vectors. The default is the
# real fastembed model; tests inject a fake.
Embedder = Callable[[Sequence[str]], list[list[float]]]


@lru_cache(maxsize=1)
def _model() -> object:
    """Load (once) and cache the fastembed model. Heavy: downloads on first use."""
    from fastembed import TextEmbedding

    logger.info("embedding_model_loading", extra={"model": EMBED_MODEL})
    return TextEmbedding(model_name=EMBED_MODEL)


def embed_texts(texts: Sequence[str]) -> list[list[float]]:
    """Embed a batch of texts into 384-dim float vectors using fastembed."""
    if not texts:
        return []
    model = _model()
    return [[float(x) for x in vector] for vector in model.embed(list(texts))]  # type: ignore[attr-defined]


def index_document(
    conn: sqlite3.Connection,
    document_id: str,
    text: str,
    embed: Embedder = embed_texts,
) -> int:
    """Chunk, embed, and store a document at every configured chunk size.

    Idempotent per document: existing chunks and vectors for ``document_id`` are
    removed first, so re-indexing replaces rather than duplicates. Returns the
    total number of chunks stored across all chunk sizes.
    """
    _delete_existing(conn, document_id)

    total = 0
    for chunk_size in CHUNK_SIZES:
        chunks = chunk_document(text, chunk_size)
        if not chunks:
            continue

        chunk_ids = [uuid.uuid4().hex for _ in chunks]
        conn.executemany(
            "INSERT INTO chunks (id, document_id, chunk_size, idx, text, start_char, end_char) "
            "VALUES (?, ?, ?, ?, ?, ?, ?)",
            [
                (cid, document_id, chunk_size, c.idx, c.text, c.start_char, c.end_char)
                for cid, c in zip(chunk_ids, chunks, strict=True)
            ],
        )

        vectors = embed([c.text for c in chunks])
        for vec in vectors:
            if len(vec) != EMBED_DIM:
                # vec_chunks is declared float[EMBED_DIM] in the db.py migration;
                # a mismatched embedder must fail loudly, not at INSERT time.
                raise ValueError(
                    f"Embedder returned a {len(vec)}-dim vector, expected {EMBED_DIM} "
                    f"(model {EMBED_MODEL!r}; vec_chunks schema in app/db.py must match)."
                )
        conn.executemany(
            "INSERT INTO vec_chunks (chunk_id, embedding) VALUES (?, ?)",
            [
                (cid, sqlite_vec.serialize_float32(vec))
                for cid, vec in zip(chunk_ids, vectors, strict=True)
            ],
        )
        total += len(chunks)

    conn.commit()
    logger.info("document_indexed", extra={"document_id": document_id, "chunks": total})
    return total


def _delete_existing(conn: sqlite3.Connection, document_id: str) -> None:
    """Remove any previously stored chunks and vectors for a document."""
    conn.execute(
        "DELETE FROM vec_chunks WHERE chunk_id IN (SELECT id FROM chunks WHERE document_id = ?)",
        (document_id,),
    )
    conn.execute("DELETE FROM chunks WHERE document_id = ?", (document_id,))


# ---------------------------------------------------------------------------
# BM25 keyword index
# ---------------------------------------------------------------------------

_TOKEN = re.compile(r"[a-z0-9]+")


@dataclass
class BM25Index:
    """An in-memory BM25 index plus the chunk ids it ranks (same order)."""

    bm25: BM25Okapi
    chunk_ids: list[str]


def tokenize_for_bm25(text: str) -> list[str]:
    """Lowercase alphanumeric tokenization for BM25."""
    return _TOKEN.findall(text.lower())


def build_bm25_index(chunk_ids: Sequence[str], texts: Sequence[str]) -> BM25Index:
    """Build an in-memory BM25 index over the given chunk texts."""
    if len(chunk_ids) != len(texts):
        # A silent mismatch would make scores point at the wrong chunk ids.
        raise ValueError(f"chunk_ids ({len(chunk_ids)}) and texts ({len(texts)}) must align.")
    corpus = [tokenize_for_bm25(t) for t in texts]
    return BM25Index(bm25=BM25Okapi(corpus), chunk_ids=list(chunk_ids))

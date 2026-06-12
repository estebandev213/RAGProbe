"""Tests for the offset-preserving chunker (§6.1)."""

from itertools import pairwise
from pathlib import Path

import pytest
from app.core.chunking import CHUNK_SIZES, chunk_document

_FIXTURES = Path(__file__).parent.parent / "fixtures" / "sample_docs"

# A long, varied body of text so both chunk sizes produce several chunks.
_LONG_TEXT = (
    "Meridian stores data as collections of JSON documents. "
    "Every document is assigned an immutable handle when first written. "
) * 40


def _fixture_texts() -> list[str]:
    return [p.read_text(encoding="utf-8") for p in sorted(_FIXTURES.glob("*.md"))]


@pytest.mark.parametrize("chunk_size", CHUNK_SIZES)
@pytest.mark.parametrize("text", [_LONG_TEXT, *_fixture_texts()])
def test_chunk_text_matches_offsets(text: str, chunk_size: int) -> None:
    """The defining invariant: chunk.text is exactly the sliced source text."""
    for chunk in chunk_document(text, chunk_size):
        assert text[chunk.start_char : chunk.end_char] == chunk.text


@pytest.mark.parametrize("chunk_size", CHUNK_SIZES)
def test_idx_is_sequential_from_zero(chunk_size: int) -> None:
    chunks = chunk_document(_LONG_TEXT, chunk_size)
    assert [c.idx for c in chunks] == list(range(len(chunks)))


@pytest.mark.parametrize("chunk_size", CHUNK_SIZES)
def test_consecutive_chunks_overlap(chunk_size: int) -> None:
    chunks = chunk_document(_LONG_TEXT, chunk_size)
    assert len(chunks) > 1
    for prev, nxt in pairwise(chunks):
        assert nxt.start_char < prev.end_char


def test_empty_text_yields_no_chunks() -> None:
    assert chunk_document("", 400) == []
    assert chunk_document("   \n  \t ", 400) == []


def test_smaller_chunk_size_produces_more_chunks() -> None:
    assert len(chunk_document(_LONG_TEXT, 400)) > len(chunk_document(_LONG_TEXT, 800))


def test_chunk_records_its_size() -> None:
    for chunk in chunk_document(_LONG_TEXT, 400):
        assert chunk.chunk_size == 400

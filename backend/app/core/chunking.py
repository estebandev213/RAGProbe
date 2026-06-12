"""Offset-preserving, token-approximate document chunking (§6.1).

A sliding window walks the document word by word, growing each chunk until it
fills a character budget derived from the target token size (tokens are
approximated as characters / 4, which the build plan accepts as dependency-light
tokenization). Consecutive chunks overlap by ~15% of their words.

The load-bearing invariant: a chunk's text is *sliced from the original document
text*, so ``document_text[chunk.start_char:chunk.end_char] == chunk.text`` always
holds. Every downstream char offset (retrieval span-overlap scoring, exam gold
spans) depends on this, and ``test_chunking.py`` asserts it for both sizes.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

# Config matrix chunk sizes (§6.2). Window sizes are in approximate tokens.
CHUNK_SIZES: tuple[int, ...] = (400, 800)

# Approximate tokens as characters / 4 (build plan §6.1).
CHARS_PER_TOKEN = 4
# Fraction of each window's words shared with the next window.
OVERLAP_RATIO = 0.15

# A "word" is any run of non-whitespace characters; we keep each word's
# character span so chunk boundaries always land on real offsets.
_WORD = re.compile(r"\S+")


@dataclass(frozen=True)
class Chunk:
    """One chunk of a document, with offsets into the normalized document text."""

    idx: int
    start_char: int
    end_char: int
    text: str
    chunk_size: int


def chunk_document(text: str, chunk_size: int) -> list[Chunk]:
    """Split ``text`` into overlapping chunks of ~``chunk_size`` tokens.

    Returns chunks in document order with sequential ``idx`` starting at 0.
    Empty or whitespace-only input yields an empty list.
    """
    spans = [(m.start(), m.end()) for m in _WORD.finditer(text)]
    if not spans:
        return []

    budget = chunk_size * CHARS_PER_TOKEN
    chunks: list[Chunk] = []
    start = 0
    idx = 0
    while start < len(spans):
        # Grow the window from `start` until adding another word would exceed
        # the character budget; always include at least one word.
        end = start
        while end < len(spans) and spans[end][1] - spans[start][0] <= budget:
            end += 1
        end = max(end, start + 1)

        start_char = spans[start][0]
        end_char = spans[end - 1][1]
        chunks.append(
            Chunk(
                idx=idx,
                start_char=start_char,
                end_char=end_char,
                text=text[start_char:end_char],
                chunk_size=chunk_size,
            )
        )
        idx += 1

        if end >= len(spans):
            break

        # Advance the window start, leaving ~OVERLAP_RATIO of the words behind
        # as overlap. The step is always >= 1 so the loop terminates.
        window_words = end - start
        overlap_words = max(1, int(window_words * OVERLAP_RATIO))
        step = max(1, window_words - overlap_words)
        start += step

    return chunks

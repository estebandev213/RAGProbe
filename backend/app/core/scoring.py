"""Span-overlap retrieval scoring and the composite score (§6.5).

This module is deliberately pure: no LLM, no I/O, just the math the judge leans
on. Two things live here:

* **Retrieval hit** — a gold span counts as *hit* when some retrieved chunk
  overlaps at least :data:`MIN_OVERLAP` of it. Because the test is "does the
  retrieved range cover the gold range", scores are directly comparable across
  chunk sizes — a 400-token and an 800-token config are judged on whether they
  surfaced the *same source passage*, not on how they happened to slice it. This
  is the property the README calls out.
* **Composite** — the weighted blend of the three metrics. Unanswerable
  questions have no retrieval metric (nothing to retrieve), so their composite
  renormalizes over the two metrics that do apply rather than penalizing an
  abstention for a dimension that cannot exist.
"""

from __future__ import annotations

from collections.abc import Sequence

from app.core.retrieval import ScoredChunk
from app.models import GoldSpan, QType, Question

# Fraction of a gold span a chunk must cover to count as a hit (§6.5).
MIN_OVERLAP = 0.5

# Composite weights (§6.5): correctness dominates, retrieval is the tie-breaker.
W_CORRECTNESS = 0.5
W_FAITHFULNESS = 0.3
W_RETRIEVAL = 0.2


def span_overlap_ratio(span: GoldSpan, chunk: ScoredChunk) -> float:
    """Fraction of ``span`` covered by ``chunk`` (0.0 if a different document).

    Both ranges are half-open ``[start_char, end_char)`` offsets into the same
    document text, so the overlap is the intersection length over the span
    length.
    """
    if chunk.document_id != span.doc_id:
        return 0.0
    span_len = span.end_char - span.start_char
    if span_len <= 0:
        return 0.0
    overlap = min(span.end_char, chunk.end_char) - max(span.start_char, chunk.start_char)
    if overlap <= 0:
        return 0.0
    return overlap / span_len


def span_is_hit(span: GoldSpan, chunks: Sequence[ScoredChunk]) -> bool:
    """Whether any retrieved chunk covers at least :data:`MIN_OVERLAP` of ``span``."""
    return any(span_overlap_ratio(span, chunk) >= MIN_OVERLAP for chunk in chunks)


def retrieval_hit_for_question(question: Question, chunks: Sequence[ScoredChunk]) -> float | None:
    """Question-level retrieval score from its gold spans and the retrieved chunks.

    Per §6.5: factual/paraphrase score 1.0 when their span is hit; multi-hop
    scores 1.0 only if *all* gold spans are hit, 0.5 if *some* are, 0.0 if none.
    Unanswerable questions are excluded from this metric and return ``None`` (so
    is any answerable question that somehow carries no gold span).
    """
    if question.qtype is QType.UNANSWERABLE or not question.gold_spans:
        return None

    hits = [span_is_hit(span, chunks) for span in question.gold_spans]
    if question.qtype is QType.MULTIHOP:
        if all(hits):
            return 1.0
        return 0.5 if any(hits) else 0.0
    # factual / paraphrase rest on a single supporting passage.
    return 1.0 if all(hits) else 0.0


def composite_score(correctness: float, faithfulness: float, retrieval_hit: float | None) -> float:
    """Blend the three metrics into one 0..1 score (§6.5).

    When ``retrieval_hit`` is ``None`` (unanswerable), the composite renormalizes
    over the correctness and faithfulness weights so abstention questions are
    judged only on the metrics that apply to them.
    """
    if retrieval_hit is None:
        return (W_CORRECTNESS * correctness + W_FAITHFULNESS * faithfulness) / (
            W_CORRECTNESS + W_FAITHFULNESS
        )
    return W_CORRECTNESS * correctness + W_FAITHFULNESS * faithfulness + W_RETRIEVAL * retrieval_hit

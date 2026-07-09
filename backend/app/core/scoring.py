"""Span-overlap retrieval scoring, the composite score, and report aggregation.

This module is deliberately pure: no LLM, no I/O, just the math the judge and the
report lean on (§6.5). Three things live here:

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
* **Aggregation** — folding per-answer grades into the leaderboard and the
  per-question-type breakdown, plus picking the winning config and its one-line
  recommendation. Pure functions over plain rows so the report route just feeds
  them DB results.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass

from app.core.retrieval import ScoredChunk
from app.models import (
    ConfigBreakdown,
    ConfigScore,
    GoldSpan,
    QType,
    QTypeScore,
    Question,
    SpanRange,
)

# Fraction of a gold span a chunk must cover to count as a hit (§6.5).
MIN_OVERLAP = 0.5

# Composite weights (§6.5): correctness dominates, retrieval is the tie-breaker.
W_CORRECTNESS = 0.5
W_FAITHFULNESS = 0.3
W_RETRIEVAL = 0.2

# Composite margin below which two configs are statistically indistinguishable
# at exam-sized n. With coarse {0, 0.5, 1} per-question scores and ~20 answers
# per config, a few hundredths of composite is noise, not a verdict — the
# recommendation says so instead of crowning a winner on it.
TIE_MARGIN = 0.05


def span_overlap_ratio(span: GoldSpan | SpanRange, chunk: ScoredChunk) -> float:
    """Fraction of ``span`` covered by ``chunk`` (0.0 if a different document).

    Both ranges are half-open ``[start_char, end_char)`` offsets into the same
    document text, so the overlap is the intersection length over the span
    length. Accepts a primary :class:`GoldSpan` or one of its alternate
    :class:`SpanRange` occurrences — only the range fields are read.
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
    """Whether retrieval covered ≥ :data:`MIN_OVERLAP` of *any occurrence* of the quote.

    The gold quote may appear at several places in the corpus (``alternates``);
    a retriever that surfaced any identical occurrence found the evidence, so
    every occurrence is checked — repeated text must not cause false misses.
    """
    occurrences: list[GoldSpan | SpanRange] = [span, *span.alternates]
    return any(
        span_overlap_ratio(occurrence, chunk) >= MIN_OVERLAP
        for occurrence in occurrences
        for chunk in chunks
    )


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


# ---------------------------------------------------------------------------
# Report aggregation (§7, §8)
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class GradedAnswer:
    """One answer's grade joined with the config and question it belongs to.

    The neutral input to aggregation — the report route maps a DB join onto these
    so this module never touches SQL.
    """

    config_id: str
    config_label: str
    chunk_size: int
    strategy: str
    qtype: QType
    latency_ms: int
    correctness: float
    faithfulness: float
    retrieval_hit: float | None


def _mean(values: Sequence[float]) -> float:
    """Arithmetic mean, or 0.0 for an empty sequence."""
    return sum(values) / len(values) if values else 0.0


def _mean_optional(values: Sequence[float | None]) -> float | None:
    """Mean of the non-``None`` values, or ``None`` if there are none.

    Used for retrieval_hit, which is ``None`` on unanswerable questions: those
    are excluded from the average rather than counted as zero.
    """
    present = [value for value in values if value is not None]
    return _mean(present) if present else None


def build_leaderboard(rows: Sequence[GradedAnswer]) -> list[ConfigScore]:
    """Aggregate graded answers into per-config scores, ranked by composite (§7).

    Each answer's composite is computed first, then averaged per config. Configs
    are ordered by composite descending, ties broken by label for determinism.
    """
    by_config: dict[str, list[GradedAnswer]] = {}
    for row in rows:
        by_config.setdefault(row.config_id, []).append(row)

    scores = [
        ConfigScore(
            config_id=config_id,
            label=group[0].config_label,
            chunk_size=group[0].chunk_size,
            strategy=group[0].strategy,
            composite=_mean(
                [composite_score(a.correctness, a.faithfulness, a.retrieval_hit) for a in group]
            ),
            correctness=_mean([a.correctness for a in group]),
            faithfulness=_mean([a.faithfulness for a in group]),
            retrieval_hit=_mean_optional([a.retrieval_hit for a in group]),
            mean_latency_ms=_mean([float(a.latency_ms) for a in group]),
            n_answers=len(group),
        )
        for config_id, group in by_config.items()
    ]
    scores.sort(key=lambda score: (-score.composite, score.label))
    return scores


def build_breakdown(rows: Sequence[GradedAnswer], order: Sequence[str]) -> list[ConfigBreakdown]:
    """Mean composite per (config, question type), for the grouped bar chart (§8).

    Configs follow ``order`` (the leaderboard ranking); within each, question
    types follow the taxonomy's declaration order.
    """
    by_config: dict[str, list[GradedAnswer]] = {}
    for row in rows:
        by_config.setdefault(row.config_id, []).append(row)

    breakdowns: list[ConfigBreakdown] = []
    for config_id in order:
        group = by_config.get(config_id)
        if not group:
            continue
        per_type = {qtype: [a for a in group if a.qtype is qtype] for qtype in QType}
        breakdowns.append(
            ConfigBreakdown(
                config_id=config_id,
                label=group[0].config_label,
                by_qtype=[
                    QTypeScore(
                        qtype=qtype,
                        composite=_mean(
                            [
                                composite_score(a.correctness, a.faithfulness, a.retrieval_hit)
                                for a in answers
                            ]
                        ),
                        n=len(answers),
                    )
                    for qtype, answers in per_type.items()
                    if answers
                ],
            )
        )
    return breakdowns


def recommend(leaderboard: Sequence[ConfigScore]) -> tuple[str | None, str]:
    """The winning config's label and a concise analyst recommendation (§8).

    Returns ``(None, "...")`` when there is nothing graded yet. The sentence
    states the sample size, and when the runner-up is within :data:`TIE_MARGIN`
    it says so — a margin inside the noise floor is a tie, not a verdict.
    """
    if not leaderboard:
        return None, "No graded answers yet."
    winner = leaderboard[0]
    latency_s = winner.mean_latency_ms / 1000.0
    sentence = (
        f"RAG analyst conclusion: Select {winner.label}. It produced the strongest "
        f"composite score ({winner.composite:.2f}) across {winner.n_answers} graded "
        f"answers, with {latency_s:.1f}s average latency."
    )
    if len(leaderboard) > 1:
        runner_up = leaderboard[1]
        margin = winner.composite - runner_up.composite
        if margin < TIE_MARGIN:
            sentence += (
                f" Caveat: {runner_up.label} is within {margin:.2f}, so treat the "
                "result as a practical tie until more questions are evaluated."
            )
    return winner.label, sentence

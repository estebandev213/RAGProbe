"""Tests for span-overlap retrieval scoring, composite, and the judge (§6.5, #9).

The span-overlap math, composite blend, and abstention rules are pure or
deterministic, so they are tested without any network. The grade-override route
is exercised through a seeded SQLite database and a ``TestClient``; the LLM
judges' parse/repair path is already covered in ``test_llm_client``.
"""

import json
from collections.abc import Iterator
from pathlib import Path

import pytest
from app.config import get_settings
from app.core.judge import is_abstention, judge_correctness, judge_faithfulness
from app.core.retrieval import ScoredChunk
from app.core.scoring import (
    W_CORRECTNESS,
    W_FAITHFULNESS,
    composite_score,
    retrieval_hit_for_question,
    span_is_hit,
    span_overlap_ratio,
)
from app.db import connect
from app.main import create_app
from app.models import (
    NOT_IN_DOCUMENTS,
    GoldSpan,
    JudgeConfidence,
    JudgeVerdict,
    QType,
    Question,
    SpanRange,
)
from fastapi.testclient import TestClient

from tests.test_exam_parsing import _client


def _chunk(start: int, end: int, *, doc_id: str = "doc1") -> ScoredChunk:
    """A retrieved chunk spanning ``[start, end)`` of ``doc_id`` (text is irrelevant)."""
    return ScoredChunk(
        chunk_id=f"c{start}-{end}",
        document_id=doc_id,
        chunk_size=400,
        idx=0,
        text="x",
        start_char=start,
        end_char=end,
        score=0.0,
    )


def _span(start: int, end: int, *, doc_id: str = "doc1") -> GoldSpan:
    return GoldSpan(doc_id=doc_id, start_char=start, end_char=end)


def _question(qtype: QType, spans: list[GoldSpan]) -> Question:
    return Question(
        id="q1",
        run_id="run1",
        qtype=qtype,
        question="q?",
        gold_answer=NOT_IN_DOCUMENTS if qtype is QType.UNANSWERABLE else "a",
        gold_spans=spans,
        source_doc_id=None if qtype is QType.UNANSWERABLE else "doc1",
    )


# ---------------------------------------------------------------------------
# Span overlap ratio + the >= 50% hit rule
# ---------------------------------------------------------------------------


def test_overlap_ratio_full_containment_is_one() -> None:
    assert span_overlap_ratio(_span(10, 20), _chunk(0, 100)) == 1.0


def test_overlap_ratio_disjoint_is_zero() -> None:
    assert span_overlap_ratio(_span(10, 20), _chunk(30, 40)) == 0.0


def test_overlap_ratio_different_document_is_zero() -> None:
    assert span_overlap_ratio(_span(10, 20), _chunk(0, 100, doc_id="other")) == 0.0


def test_overlap_ratio_partial() -> None:
    # span [10,20) (len 10); chunk covers [15,100) → overlap [15,20) = 5 → 0.5.
    assert span_overlap_ratio(_span(10, 20), _chunk(15, 100)) == 0.5


def test_hit_exactly_at_threshold() -> None:
    # Exactly 50% overlap counts as a hit (>= rule).
    assert span_is_hit(_span(10, 20), [_chunk(15, 100)]) is True


def test_miss_just_under_threshold() -> None:
    # span [10,20) (len 10); chunk [16,100) → overlap 4 → 0.4 < 0.5.
    assert span_is_hit(_span(10, 20), [_chunk(16, 100)]) is False


def test_hit_across_multiple_chunks() -> None:
    # No single chunk reaches 50%, but the best one does → hit.
    assert span_is_hit(_span(0, 10), [_chunk(0, 3), _chunk(3, 9)]) is True


def test_hit_on_alternate_occurrence() -> None:
    # The quote also appears at [500, 510); retrieval covered that copy, not
    # the primary — identical text found elsewhere must count as a hit.
    span = GoldSpan(
        doc_id="doc1",
        start_char=10,
        end_char=20,
        alternates=[SpanRange(doc_id="doc1", start_char=500, end_char=510)],
    )
    assert span_is_hit(span, [_chunk(490, 600)]) is True
    # Neither the primary nor any alternate covered → still a miss.
    assert span_is_hit(span, [_chunk(700, 800)]) is False


def test_alternate_in_other_document_counts() -> None:
    span = GoldSpan(
        doc_id="doc1",
        start_char=10,
        end_char=20,
        alternates=[SpanRange(doc_id="doc2", start_char=0, end_char=10)],
    )
    assert span_is_hit(span, [_chunk(0, 50, doc_id="doc2")]) is True


# ---------------------------------------------------------------------------
# Question-level retrieval hit, per type
# ---------------------------------------------------------------------------


def test_factual_hit_and_miss() -> None:
    q = _question(QType.FACTUAL, [_span(10, 20)])
    assert retrieval_hit_for_question(q, [_chunk(0, 100)]) == 1.0
    assert retrieval_hit_for_question(q, [_chunk(30, 40)]) == 0.0


def test_paraphrase_uses_single_span_rule() -> None:
    q = _question(QType.PARAPHRASE, [_span(10, 20)])
    assert retrieval_hit_for_question(q, [_chunk(0, 100)]) == 1.0


def test_multihop_all_some_none() -> None:
    q = _question(QType.MULTIHOP, [_span(0, 10), _span(100, 110)])
    both = [_chunk(0, 20), _chunk(95, 120)]
    one = [_chunk(0, 20)]
    neither = [_chunk(200, 210)]
    assert retrieval_hit_for_question(q, both) == 1.0
    assert retrieval_hit_for_question(q, one) == 0.5
    assert retrieval_hit_for_question(q, neither) == 0.0


def test_unanswerable_excluded_from_retrieval_metric() -> None:
    q = _question(QType.UNANSWERABLE, [])
    assert retrieval_hit_for_question(q, [_chunk(0, 100)]) is None


# ---------------------------------------------------------------------------
# Composite weighting (incl. unanswerable renormalization)
# ---------------------------------------------------------------------------


def test_composite_weighting() -> None:
    assert composite_score(1.0, 1.0, 1.0) == pytest.approx(1.0)
    assert composite_score(1.0, 0.0, 0.0) == pytest.approx(0.5)
    assert composite_score(0.0, 1.0, 0.5) == pytest.approx(0.3 + 0.1)


def test_composite_renormalizes_when_retrieval_absent() -> None:
    # Unanswerable: only correctness + faithfulness apply, normalized over 0.8.
    expected = (W_CORRECTNESS * 1.0 + W_FAITHFULNESS * 0.0) / (W_CORRECTNESS + W_FAITHFULNESS)
    assert composite_score(1.0, 0.0, None) == pytest.approx(expected)
    # A fully-correct, fully-faithful abstention still tops out at 1.0.
    assert composite_score(1.0, 1.0, None) == pytest.approx(1.0)


# ---------------------------------------------------------------------------
# Score snapping and override validation
# ---------------------------------------------------------------------------


def test_judge_verdict_snaps_off_grid_score() -> None:
    verdict = JudgeVerdict(score=0.7, rationale="r", confidence=JudgeConfidence.MEDIUM)
    assert verdict.score == 0.5


def test_judge_verdict_snaps_above_one() -> None:
    verdict = JudgeVerdict(score=5, rationale="r", confidence=JudgeConfidence.HIGH)
    assert verdict.score == 1.0


# ---------------------------------------------------------------------------
# Abstention scoring (deterministic — no LLM call)
# ---------------------------------------------------------------------------


def test_is_abstention_tolerates_punctuation() -> None:
    assert is_abstention("not_in_documents.") is True
    assert is_abstention("The answer is NOT_IN_DOCUMENTS.") is True
    assert is_abstention("The capital is Paris.") is False


def test_is_abstention_rejects_hedged_continuation() -> None:
    # A reply that abstains *and then answers anyway* asserts real claims — it
    # must be graded as an answer, not waved through as a perfect abstention.
    hedged = "NOT_IN_DOCUMENTS. However, based on general knowledge, the capital is Paris."
    assert is_abstention(hedged) is False


async def test_correctness_rewards_correct_abstention() -> None:
    q = _question(QType.UNANSWERABLE, [])
    async with _client() as client:
        verdict, usage = await judge_correctness(client, q, NOT_IN_DOCUMENTS)
    assert verdict.score == 1.0
    assert usage.prompt_tokens == 0  # deterministic verdicts cost no tokens


async def test_correctness_punishes_hallucinated_unanswerable() -> None:
    q = _question(QType.UNANSWERABLE, [])
    async with _client() as client:
        verdict, _usage = await judge_correctness(client, q, "Some confident made-up answer.")
    assert verdict.score == 0.0


async def test_correctness_punishes_abstention_on_answerable() -> None:
    q = _question(QType.FACTUAL, [_span(0, 10)])
    async with _client() as client:
        verdict, _usage = await judge_correctness(client, q, NOT_IN_DOCUMENTS)
    assert verdict.score == 0.0


async def test_faithfulness_rewards_abstention() -> None:
    async with _client() as client:
        verdict, _usage = await judge_faithfulness(client, NOT_IN_DOCUMENTS, [])
    assert verdict.score == 1.0


# ---------------------------------------------------------------------------
# Grade override route
# ---------------------------------------------------------------------------


@pytest.fixture
def api(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> Iterator[tuple[TestClient, str]]:
    db_path = str(tmp_path / "api.db")
    monkeypatch.setenv("GROQ_API_KEY", "test-key")
    monkeypatch.setenv("DATABASE_PATH", db_path)
    get_settings.cache_clear()
    client = TestClient(create_app())
    yield client, db_path
    get_settings.cache_clear()


def _seed_grade(db_path: str) -> None:
    """Seed the run→answer→grade chain so the FK-enforced grade row is insertable."""
    conn = connect(db_path)
    try:
        conn.execute(
            "INSERT INTO documents (id, name, mime, text, char_count, created_at) "
            "VALUES ('doc1', 'd', 'text/plain', 'hello world', 11, '2026-06-13')"
        )
        conn.execute(
            "INSERT INTO runs (id, status, doc_ids, settings, created_at) "
            "VALUES ('run1', 'done', ?, '{}', '2026-06-13')",
            (json.dumps(["doc1"]),),
        )
        conn.execute(
            "INSERT INTO questions (id, run_id, qtype, question, gold_answer, gold_spans, "
            "source_doc_id) VALUES ('q1', 'run1', 'factual', 'q?', 'a', '[]', 'doc1')"
        )
        conn.execute(
            "INSERT INTO configs (id, run_id, chunk_size, strategy, top_k, label) "
            "VALUES ('cfg1', 'run1', 400, 'vector', 5, '400/vector')"
        )
        conn.execute(
            "INSERT INTO answers (id, run_id, config_id, question_id, answer_text, "
            "retrieved_chunk_ids, latency_ms, prompt_tokens, completion_tokens) "
            "VALUES ('a1', 'run1', 'cfg1', 'q1', 'a', '[]', 5, 1, 1)"
        )
        conn.execute(
            "INSERT INTO grades (id, answer_id, correctness, faithfulness, retrieval_hit, "
            "judge_rationale, judge_confidence, overridden) "
            "VALUES ('g1', 'a1', 0.5, 0.5, 1.0, 'r', 'medium', 0)"
        )
        conn.commit()
    finally:
        conn.close()


def test_override_updates_grade_and_recomputes_composite(api: tuple[TestClient, str]) -> None:
    client, db_path = api
    _seed_grade(db_path)
    before = composite_score(0.5, 0.5, 1.0)

    resp = client.patch("/api/grades/g1", json={"correctness": 1.0})
    assert resp.status_code == 200
    body = resp.json()
    assert body["correctness"] == 1.0
    assert body["faithfulness"] == 0.5  # untouched
    assert body["overridden"] is True

    after = composite_score(body["correctness"], body["faithfulness"], body["retrieval_hit"])
    assert after > before


def test_override_rejects_off_grid_score(api: tuple[TestClient, str]) -> None:
    client, db_path = api
    _seed_grade(db_path)
    assert client.patch("/api/grades/g1", json={"correctness": 0.3}).status_code == 422


def test_override_rejects_empty_body(api: tuple[TestClient, str]) -> None:
    client, db_path = api
    _seed_grade(db_path)
    assert client.patch("/api/grades/g1", json={}).status_code == 422


def test_override_unknown_grade_returns_404(api: tuple[TestClient, str]) -> None:
    client, _ = api
    assert client.patch("/api/grades/missing", json={"correctness": 1.0}).status_code == 404

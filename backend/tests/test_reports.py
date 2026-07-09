"""Tests for report aggregation endpoints (§7, §8, commit #10).

The aggregation math is exercised directly as pure functions over
:class:`GradedAnswer` rows; the two read endpoints are driven through a seeded
SQLite database and a ``TestClient`` to prove the joins, filters, worst-first
ordering, and per-span hit/miss derivation. No network — there are no LLM calls
on the read path.
"""

import json
from collections.abc import Iterator
from pathlib import Path

import pytest
from app.config import get_settings
from app.core.scoring import (
    GradedAnswer,
    build_breakdown,
    build_leaderboard,
    recommend,
)
from app.db import connect
from app.main import create_app
from app.models import QType
from fastapi.testclient import TestClient


def _graded(
    config_id: str,
    label: str,
    qtype: QType,
    *,
    correctness: float,
    faithfulness: float,
    retrieval_hit: float | None,
    latency_ms: int = 100,
) -> GradedAnswer:
    return GradedAnswer(
        config_id=config_id,
        config_label=label,
        chunk_size=400,
        strategy="vector",
        qtype=qtype,
        latency_ms=latency_ms,
        correctness=correctness,
        faithfulness=faithfulness,
        retrieval_hit=retrieval_hit,
    )


# ---------------------------------------------------------------------------
# Aggregation math (pure)
# ---------------------------------------------------------------------------


def test_leaderboard_ranks_by_composite_desc() -> None:
    rows = [
        _graded(
            "weak",
            "400/vector",
            QType.FACTUAL,
            correctness=0.0,
            faithfulness=0.0,
            retrieval_hit=0.0,
        ),
        _graded(
            "strong",
            "800/hybrid",
            QType.FACTUAL,
            correctness=1.0,
            faithfulness=1.0,
            retrieval_hit=1.0,
        ),
    ]
    leaderboard = build_leaderboard(rows)
    assert [score.config_id for score in leaderboard] == ["strong", "weak"]
    assert leaderboard[0].composite == pytest.approx(1.0)
    assert leaderboard[1].composite == pytest.approx(0.0)


def test_leaderboard_averages_metrics_and_latency() -> None:
    rows = [
        _graded(
            "c",
            "400/vector",
            QType.FACTUAL,
            correctness=1.0,
            faithfulness=1.0,
            retrieval_hit=1.0,
            latency_ms=100,
        ),
        _graded(
            "c",
            "400/vector",
            QType.FACTUAL,
            correctness=0.0,
            faithfulness=0.0,
            retrieval_hit=0.0,
            latency_ms=300,
        ),
    ]
    (score,) = build_leaderboard(rows)
    assert score.correctness == pytest.approx(0.5)
    assert score.mean_latency_ms == pytest.approx(200.0)
    assert score.n_answers == 2


def test_leaderboard_excludes_none_retrieval_from_mean() -> None:
    rows = [
        _graded(
            "c", "400/vector", QType.FACTUAL, correctness=1.0, faithfulness=1.0, retrieval_hit=1.0
        ),
        _graded(
            "c",
            "400/vector",
            QType.UNANSWERABLE,
            correctness=1.0,
            faithfulness=1.0,
            retrieval_hit=None,
        ),
    ]
    (score,) = build_leaderboard(rows)
    # Only the answerable question contributes to the retrieval mean.
    assert score.retrieval_hit == pytest.approx(1.0)


def test_breakdown_groups_by_qtype_in_order() -> None:
    rows = [
        _graded(
            "c", "400/vector", QType.MULTIHOP, correctness=0.0, faithfulness=0.0, retrieval_hit=0.0
        ),
        _graded(
            "c", "400/vector", QType.FACTUAL, correctness=1.0, faithfulness=1.0, retrieval_hit=1.0
        ),
    ]
    (breakdown,) = build_breakdown(rows, ["c"])
    qtypes = [entry.qtype for entry in breakdown.by_qtype]
    assert qtypes == [QType.FACTUAL, QType.MULTIHOP]  # taxonomy declaration order
    factual = next(e for e in breakdown.by_qtype if e.qtype is QType.FACTUAL)
    multihop = next(e for e in breakdown.by_qtype if e.qtype is QType.MULTIHOP)
    assert factual.composite == pytest.approx(1.0)
    assert multihop.composite == pytest.approx(0.0)


def test_recommend_picks_winner_and_phrasing() -> None:
    rows = [
        _graded(
            "strong",
            "800/hybrid",
            QType.FACTUAL,
            correctness=1.0,
            faithfulness=1.0,
            retrieval_hit=1.0,
            latency_ms=1400,
        ),
    ]
    label, sentence = recommend(build_leaderboard(rows))
    assert label == "800/hybrid"
    assert "800/hybrid" in sentence and "1.4s" in sentence
    assert "—" not in sentence


def test_recommend_empty_leaderboard() -> None:
    label, sentence = recommend([])
    assert label is None
    assert sentence == "No graded answers yet."


def test_recommend_states_sample_size() -> None:
    rows = [
        _graded(
            "cfg", "400/hybrid", QType.FACTUAL, correctness=1.0, faithfulness=1.0, retrieval_hit=1.0
        ),
        _graded(
            "cfg", "400/hybrid", QType.FACTUAL, correctness=1.0, faithfulness=1.0, retrieval_hit=1.0
        ),
    ]
    _label, sentence = recommend(build_leaderboard(rows))
    assert "across 2 graded answers" in sentence


def test_recommend_flags_near_ties() -> None:
    # Two configs with identical composites: the margin is inside the noise
    # floor, so the recommendation must say "tie" rather than crown a winner.
    rows = [
        _graded(
            "a", "400/hybrid", QType.FACTUAL, correctness=1.0, faithfulness=1.0, retrieval_hit=1.0
        ),
        _graded(
            "b", "800/hybrid", QType.FACTUAL, correctness=1.0, faithfulness=1.0, retrieval_hit=1.0
        ),
    ]
    _label, sentence = recommend(build_leaderboard(rows))
    assert "practical tie" in sentence


# ---------------------------------------------------------------------------
# Endpoints (seeded DB)
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


def _seed_report(db_path: str) -> None:
    """Seed a run with two configs, three questions, answers, and graded results.

    Document text is 30 'a' chars; the one chunk covers [0,30), so a gold span
    inside it is a retrieval hit and a span outside it is a miss.
    """
    conn = connect(db_path)
    try:
        conn.execute(
            "INSERT INTO documents (id, name, mime, text, char_count, created_at) "
            "VALUES ('doc1', 'd', 'text/plain', ?, 30, '2026-06-13')",
            ("a" * 30,),
        )
        conn.execute(
            "INSERT INTO runs (id, status, doc_ids, settings, created_at) "
            "VALUES ('run1', 'done', ?, '{}', '2026-06-13')",
            (json.dumps(["doc1"]),),
        )
        conn.execute(
            "INSERT INTO chunks (id, document_id, chunk_size, idx, text, start_char, end_char) "
            "VALUES ('chk1', 'doc1', 400, 0, ?, 0, 30)",
            ("a" * 30,),
        )
        # Two questions: a factual whose span is inside the chunk, and a factual
        # whose span (200..210) is far outside it (a retrieval miss).
        conn.execute(
            "INSERT INTO questions (id, run_id, qtype, question, gold_answer, gold_spans, "
            "source_doc_id) "
            "VALUES ('qf', 'run1', 'factual', 'in?', 'a', ?, 'doc1')",
            (json.dumps([{"doc_id": "doc1", "start_char": 0, "end_char": 10}]),),
        )
        conn.execute(
            "INSERT INTO questions (id, run_id, qtype, question, gold_answer, gold_spans, "
            "source_doc_id) "
            "VALUES ('qm', 'run1', 'multihop', 'out?', 'a', ?, 'doc1')",
            (json.dumps([{"doc_id": "doc1", "start_char": 200, "end_char": 210}]),),
        )

        # Config 'good' nails both; config 'bad' fails both.
        for cfg, label, corr in (("good", "800/hybrid", 1.0), ("bad", "400/vector", 0.0)):
            conn.execute(
                "INSERT INTO configs (id, run_id, chunk_size, strategy, top_k, label) "
                "VALUES (?, 'run1', 400, 'vector', 5, ?)",
                (cfg, label),
            )
            for qid, ret in (("qf", 1.0), ("qm", 0.0)):
                ans_id = f"{cfg}-{qid}"
                conn.execute(
                    "INSERT INTO answers (id, run_id, config_id, question_id, answer_text, "
                    "retrieved_chunk_ids, latency_ms, prompt_tokens, completion_tokens) "
                    "VALUES (?, 'run1', ?, ?, 'ans', ?, 100, 1, 1)",
                    (ans_id, cfg, qid, json.dumps(["chk1"])),
                )
                conn.execute(
                    "INSERT INTO grades (id, answer_id, correctness, faithfulness, retrieval_hit, "
                    "judge_rationale, judge_confidence, overridden) "
                    "VALUES (?, ?, ?, ?, ?, 'r', 'high', 0)",
                    (f"g-{ans_id}", ans_id, corr, corr, ret),
                )
        conn.commit()
    finally:
        conn.close()


def test_report_ranks_configs_and_recommends(api: tuple[TestClient, str]) -> None:
    client, db_path = api
    _seed_report(db_path)

    body = client.get("/api/runs/run1/report").json()
    labels = [score["label"] for score in body["leaderboard"]]
    assert labels == ["800/hybrid", "400/vector"]  # good config first
    assert body["winner_label"] == "800/hybrid"
    assert "800/hybrid" in body["recommendation"]
    # Breakdown exposes the per-qtype split (multihop is the weak spot).
    good = next(b for b in body["breakdown"] if b["label"] == "800/hybrid")
    by_type = {entry["qtype"]: entry["composite"] for entry in good["by_qtype"]}
    assert by_type["factual"] > by_type["multihop"]


def test_report_unknown_run_404(api: tuple[TestClient, str]) -> None:
    client, _ = api
    assert client.get("/api/runs/missing/report").status_code == 404


def test_report_empty_run_has_no_winner(api: tuple[TestClient, str]) -> None:
    client, db_path = api
    conn = connect(db_path)
    try:
        conn.execute(
            "INSERT INTO runs (id, status, doc_ids, settings, created_at) "
            "VALUES ('empty', 'done', '[]', '{}', '2026-06-13')"
        )
        conn.commit()
    finally:
        conn.close()

    body = client.get("/api/runs/empty/report").json()
    assert body["leaderboard"] == []
    assert body["winner_label"] is None


def test_failures_ranked_worst_first_with_span_badges(api: tuple[TestClient, str]) -> None:
    client, db_path = api
    _seed_report(db_path)

    failures = client.get("/api/runs/run1/failures").json()["failures"]
    composites = [row["composite"] for row in failures]
    assert composites == sorted(composites)  # worst first

    # The factual question's span is inside the chunk → hit; multihop's is not.
    factual = next(r for r in failures if r["question_id"] == "qf")
    multihop = next(r for r in failures if r["question_id"] == "qm")
    assert factual["gold_span_hits"][0]["hit"] is True
    assert multihop["gold_span_hits"][0]["hit"] is False
    assert multihop["retrieval_failed"] is True


def test_failures_filter_by_config_and_qtype(api: tuple[TestClient, str]) -> None:
    client, db_path = api
    _seed_report(db_path)

    by_config = client.get("/api/runs/run1/failures?config_id=good").json()["failures"]
    assert {row["config_id"] for row in by_config} == {"good"}

    by_qtype = client.get("/api/runs/run1/failures?qtype=multihop").json()["failures"]
    assert {row["qtype"] for row in by_qtype} == {"multihop"}


def test_failures_only_failures_drops_perfect_rows(api: tuple[TestClient, str]) -> None:
    client, db_path = api
    _seed_report(db_path)

    every = client.get("/api/runs/run1/failures").json()["failures"]
    only = client.get("/api/runs/run1/failures?only_failures=true").json()["failures"]
    assert any(row["is_failure"] is False for row in every)  # good/qf is perfect
    assert all(row["is_failure"] is True for row in only)
    assert len(only) < len(every)

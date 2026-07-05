"""Report routes: leaderboard, breakdown, failure drill-down, and grade override.

Three read endpoints turn a run's grades into the report card (§7, §8):

* ``GET /api/runs/{id}/report`` — configs ranked by composite, plus the
  per-question-type breakdown and the winning recommendation.
* ``GET /api/runs/{id}/failures`` — every graded answer with its scores, ranked
  worst-first and labelled with per-metric failure flags; optionally filtered by
  ``config_id`` / ``qtype`` or narrowed to imperfect rows via ``only_failures``.
  The backend hides nothing — it ranks and labels, the UI decides what to show.

and ``PATCH /api/grades/{id}`` makes the LLM judge accountable: a human can
correct a metric, flagging the grade as overridden. The composite is computed on
read from the stored metrics, so any override re-aggregates with no cached value
to invalidate.
"""

from __future__ import annotations

import json
import logging
import sqlite3
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Query

from app.core.judge import load_chunks
from app.core.scoring import (
    GradedAnswer,
    build_breakdown,
    build_leaderboard,
    composite_score,
    recommend,
    span_is_hit,
)
from app.db import get_connection
from app.models import (
    FailureRow,
    FailuresResponse,
    GoldSpan,
    GoldSpanHit,
    Grade,
    GradeOverride,
    JudgeConfidence,
    QType,
    ReportResponse,
    RetrievedChunkView,
)

logger = logging.getLogger("ragprobe")

router = APIRouter(tags=["reports"])


def _require_run(conn: sqlite3.Connection, run_id: str) -> None:
    """Raise 404 if the run does not exist."""
    if conn.execute("SELECT 1 FROM runs WHERE id = ?", (run_id,)).fetchone() is None:
        raise HTTPException(status_code=404, detail=f"Run {run_id} not found.")


# The SQL join behind both read endpoints: one graded answer per row, with the
# config and question it belongs to. Failures select extra columns on top.
_GRADED_JOIN = (
    "FROM answers a "
    "JOIN grades g ON g.answer_id = a.id "
    "JOIN configs c ON c.id = a.config_id "
    "JOIN questions q ON q.id = a.question_id "
    "WHERE a.run_id = ?"
)


@router.get("/runs/{run_id}/report", response_model=ReportResponse)
async def get_report(
    run_id: str,
    conn: Annotated[sqlite3.Connection, Depends(get_connection)],
) -> ReportResponse:
    """Aggregate a run's grades into the leaderboard and breakdown (§7)."""
    _require_run(conn, run_id)
    rows = conn.execute(
        "SELECT a.config_id, a.latency_ms, c.label, c.chunk_size, c.strategy, q.qtype, "
        "g.correctness, g.faithfulness, g.retrieval_hit " + _GRADED_JOIN,
        (run_id,),
    ).fetchall()

    graded = [
        GradedAnswer(
            config_id=row["config_id"],
            config_label=row["label"],
            chunk_size=row["chunk_size"],
            strategy=row["strategy"],
            qtype=QType(row["qtype"]),
            latency_ms=row["latency_ms"],
            correctness=row["correctness"],
            faithfulness=row["faithfulness"],
            retrieval_hit=row["retrieval_hit"],
        )
        for row in rows
    ]

    leaderboard = build_leaderboard(graded)
    breakdown = build_breakdown(graded, [score.config_id for score in leaderboard])
    winner_label, recommendation = recommend(leaderboard)
    return ReportResponse(
        run_id=run_id,
        leaderboard=leaderboard,
        breakdown=breakdown,
        winner_label=winner_label,
        recommendation=recommendation,
    )


@router.get("/runs/{run_id}/failures", response_model=FailuresResponse)
async def get_failures(
    run_id: str,
    conn: Annotated[sqlite3.Connection, Depends(get_connection)],
    config_id: Annotated[str | None, Query()] = None,
    qtype: Annotated[QType | None, Query()] = None,
    only_failures: Annotated[bool, Query()] = False,
) -> FailuresResponse:
    """Graded answers for drill-down, ranked worst-first and labelled (§8).

    ``config_id`` and ``qtype`` narrow the set; ``only_failures`` keeps just the
    rows that lost points (composite < 1.0). Each row carries hit/miss per gold
    span and per-metric failure flags so the explorer needs no recomputation.
    """
    _require_run(conn, run_id)
    sql = (
        "SELECT a.id AS answer_id, a.config_id, a.answer_text, a.retrieved_chunk_ids, "
        "c.label AS config_label, q.id AS question_id, q.qtype, q.question, "
        "q.gold_answer, q.gold_spans, g.id AS grade_id, g.correctness, g.faithfulness, "
        "g.retrieval_hit, g.judge_rationale, g.judge_confidence, g.overridden " + _GRADED_JOIN
    )
    params: list[object] = [run_id]
    if config_id is not None:
        sql += " AND a.config_id = ?"
        params.append(config_id)
    if qtype is not None:
        sql += " AND q.qtype = ?"
        params.append(qtype.value)

    rows = conn.execute(sql, params).fetchall()
    failures = [_to_failure_row(conn, row) for row in rows]
    if only_failures:
        failures = [row for row in failures if row.is_failure]
    failures.sort(key=lambda row: row.composite)
    return FailuresResponse(run_id=run_id, failures=failures)


def _to_failure_row(conn: sqlite3.Connection, row: sqlite3.Row) -> FailureRow:
    """Build one drill-down row: load chunks, score span hits, derive flags."""
    chunk_ids = json.loads(row["retrieved_chunk_ids"])
    chunks = load_chunks(conn, chunk_ids)
    spans = [GoldSpan.model_validate(span) for span in json.loads(row["gold_spans"])]

    correctness = row["correctness"]
    faithfulness = row["faithfulness"]
    retrieval_hit = row["retrieval_hit"]
    composite = composite_score(correctness, faithfulness, retrieval_hit)

    return FailureRow(
        answer_id=row["answer_id"],
        grade_id=row["grade_id"],
        config_id=row["config_id"],
        config_label=row["config_label"],
        question_id=row["question_id"],
        qtype=QType(row["qtype"]),
        question=row["question"],
        gold_answer=row["gold_answer"],
        answer_text=row["answer_text"],
        gold_span_hits=[GoldSpanHit(span=span, hit=span_is_hit(span, chunks)) for span in spans],
        retrieved_chunks=[
            RetrievedChunkView(
                chunk_id=chunk.chunk_id,
                document_id=chunk.document_id,
                start_char=chunk.start_char,
                end_char=chunk.end_char,
                text=chunk.text,
            )
            for chunk in chunks
        ],
        correctness=correctness,
        faithfulness=faithfulness,
        retrieval_hit=retrieval_hit,
        composite=composite,
        is_failure=composite < 1.0,
        correctness_failed=correctness < 1.0,
        faithfulness_failed=faithfulness < 1.0,
        retrieval_failed=retrieval_hit is not None and retrieval_hit < 1.0,
        judge_rationale=row["judge_rationale"],
        judge_confidence=JudgeConfidence(row["judge_confidence"]),
        overridden=bool(row["overridden"]),
    )


def _row_to_grade(row: sqlite3.Row) -> Grade:
    return Grade(
        id=row["id"],
        answer_id=row["answer_id"],
        correctness=row["correctness"],
        faithfulness=row["faithfulness"],
        retrieval_hit=row["retrieval_hit"],
        judge_rationale=row["judge_rationale"],
        judge_confidence=JudgeConfidence(row["judge_confidence"]),
        overridden=bool(row["overridden"]),
        judge_prompt_tokens=row["judge_prompt_tokens"],
        judge_completion_tokens=row["judge_completion_tokens"],
    )


@router.patch("/grades/{grade_id}", response_model=Grade)
async def override_grade(
    grade_id: str,
    body: GradeOverride,
    conn: Annotated[sqlite3.Connection, Depends(get_connection)],
) -> Grade:
    """Manually correct a grade's correctness and/or faithfulness (§6.5)."""
    if body.correctness is None and body.faithfulness is None:
        raise HTTPException(
            status_code=422,
            detail="Provide at least one of correctness or faithfulness to override.",
        )

    row = conn.execute(
        "SELECT id, answer_id, correctness, faithfulness, retrieval_hit, judge_rationale, "
        "judge_confidence, overridden, judge_prompt_tokens, judge_completion_tokens "
        "FROM grades WHERE id = ?",
        (grade_id,),
    ).fetchone()
    if row is None:
        raise HTTPException(status_code=404, detail=f"Grade {grade_id} not found.")

    correctness = body.correctness if body.correctness is not None else row["correctness"]
    faithfulness = body.faithfulness if body.faithfulness is not None else row["faithfulness"]
    conn.execute(
        "UPDATE grades SET correctness = ?, faithfulness = ?, overridden = 1 WHERE id = ?",
        (correctness, faithfulness, grade_id),
    )
    conn.commit()
    logger.info("grade_overridden", extra={"grade_id": grade_id})

    updated = conn.execute(
        "SELECT id, answer_id, correctness, faithfulness, retrieval_hit, judge_rationale, "
        "judge_confidence, overridden, judge_prompt_tokens, judge_completion_tokens "
        "FROM grades WHERE id = ?",
        (grade_id,),
    ).fetchone()
    return _row_to_grade(updated)

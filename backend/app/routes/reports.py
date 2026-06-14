"""Report routes: judge accountability via manual grade override (§6.5, §7).

The leaderboard, per-question-type breakdown, and failure drill-down land in the
next commit. What ships here is the override that makes the LLM judge
accountable: ``PATCH /api/grades/{id}`` lets a human correct a metric and flags
the grade as overridden. The composite is computed on read from the stored
metrics, so an override re-aggregates the leaderboard with no cached value to
invalidate.
"""

from __future__ import annotations

import logging
import sqlite3
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException

from app.db import get_connection
from app.models import Grade, GradeOverride, JudgeConfidence

logger = logging.getLogger("ragprobe")

router = APIRouter(tags=["reports"])


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
        "SELECT id, answer_id, correctness, faithfulness, retrieval_hit, "
        "judge_rationale, judge_confidence, overridden FROM grades WHERE id = ?",
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
        "SELECT id, answer_id, correctness, faithfulness, retrieval_hit, "
        "judge_rationale, judge_confidence, overridden FROM grades WHERE id = ?",
        (grade_id,),
    ).fetchone()
    return _row_to_grade(updated)

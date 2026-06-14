"""LLM grading: correctness and faithfulness judges, plus grade assembly (§6.5).

Every persisted answer is graded on three independent metrics:

* **retrieval_hit** — pure span-overlap math (in :mod:`app.core.scoring`), no LLM;
* **correctness** — does the answer match the gold answer? Judged by the 70B
  model, except for the deterministic abstention cases below;
* **faithfulness** — is every claim grounded in the retrieved context? Also
  70B-judged, except abstentions (which assert nothing) score a free 1.0.

Abstention is the hinge of the design. An answerable question that abstains is
wrong (it should have answered); an *unanswerable* question that abstains is
right (it correctly refused to hallucinate). Both are decided here without an
LLM call — they are facts about the answer text, not judgment calls — which also
saves Groq quota.

The two judges each return a :class:`JudgeVerdict`; :func:`grade_answer` folds
them, plus the retrieval score, into one persisted :class:`Grade`, keeping the
lower of the two confidences and both rationales so the report can explain the
grade and let a human override it.
"""

from __future__ import annotations

import logging
import sqlite3
import uuid
from collections.abc import Sequence

from app.core.groq_client import GroqClient, GroqJSONError, ModelRole
from app.core.retrieval import ScoredChunk, build_context
from app.core.scoring import retrieval_hit_for_question
from app.models import (
    NOT_IN_DOCUMENTS,
    Grade,
    JudgeConfidence,
    JudgeVerdict,
    QType,
    Question,
)

logger = logging.getLogger("ragprobe")

# Confidence ordering for picking the more conservative (lower) of two verdicts.
_CONFIDENCE_RANK: dict[JudgeConfidence, int] = {
    JudgeConfidence.LOW: 0,
    JudgeConfidence.MEDIUM: 1,
    JudgeConfidence.HIGH: 2,
}

_CORRECTNESS_SYSTEM = (
    "You are a strict grader for a question-answering system. Compare a candidate "
    "answer against the reference answer and decide how correct the candidate is, "
    "ignoring wording differences. Score 1 if fully correct, 0.5 if partially "
    "correct, 0 if wrong or contradictory. Respond with JSON only."
)

_FAITHFULNESS_SYSTEM = (
    "You are a strict grader checking whether an answer is grounded in its source "
    "context. Consider ONLY the provided context — not outside knowledge. Score 1 "
    "if every claim in the answer is supported by the context, 0.5 if only some "
    "claims are supported, 0 if it makes unsupported claims. Respond with JSON only."
)


def is_abstention(answer_text: str) -> bool:
    """Whether the answer is the strict-grounding refusal sentinel (§6.4).

    The answer prompt instructs the model to reply with exactly
    ``NOT_IN_DOCUMENTS``; we match it case-insensitively anywhere in the reply to
    tolerate trailing punctuation or stray whitespace.
    """
    return NOT_IN_DOCUMENTS in answer_text.upper()


def _combine_confidence(a: JudgeConfidence, b: JudgeConfidence) -> JudgeConfidence:
    """The lower (more cautious) of two confidences."""
    return a if _CONFIDENCE_RANK[a] <= _CONFIDENCE_RANK[b] else b


def _deterministic(score: float, rationale: str) -> JudgeVerdict:
    """A verdict decided by rule rather than by the LLM (always high confidence)."""
    return JudgeVerdict(score=score, rationale=rationale, confidence=JudgeConfidence.HIGH)


async def _judge_one(client: GroqClient, system: str, prompt: str, *, metric: str) -> JudgeVerdict:
    """Run one LLM judge call, degrading to a low-confidence 0 if JSON can't parse."""
    try:
        return await client.json_mode(
            prompt, JudgeVerdict, role=ModelRole.GENERATION, system=system
        )
    except GroqJSONError:
        logger.warning("judge_invalid_json", extra={"metric": metric})
        return JudgeVerdict(
            score=0.0,
            rationale="Judge response could not be parsed.",
            confidence=JudgeConfidence.LOW,
        )


async def judge_correctness(
    client: GroqClient, question: Question, answer_text: str
) -> JudgeVerdict:
    """Grade an answer's correctness, short-circuiting the abstention cases (§6.5)."""
    abstained = is_abstention(answer_text)
    if question.qtype is QType.UNANSWERABLE:
        return (
            _deterministic(1.0, "Correctly abstained on an unanswerable question.")
            if abstained
            else _deterministic(0.0, "Answered a question the documents do not cover.")
        )
    if abstained:
        return _deterministic(0.0, "Abstained on a question the documents do answer.")

    prompt = (
        f"Question:\n{question.question}\n\n"
        f"Reference answer:\n{question.gold_answer}\n\n"
        f"Candidate answer:\n{answer_text}\n\n"
        "Score the candidate's correctness as 0, 0.5, or 1, with a one-sentence "
        "rationale and your confidence (low, medium, or high)."
    )
    return await _judge_one(client, _CORRECTNESS_SYSTEM, prompt, metric="correctness")


async def judge_faithfulness(
    client: GroqClient, answer_text: str, chunks: Sequence[ScoredChunk]
) -> JudgeVerdict:
    """Grade whether the answer is supported by its retrieved context (§6.5)."""
    if is_abstention(answer_text):
        return _deterministic(1.0, "Abstention asserts nothing to verify.")

    prompt = (
        f"Context:\n{build_context(chunks)}\n\n"
        f"Answer:\n{answer_text}\n\n"
        "Score whether every claim in the answer is supported by the context above "
        "as 0, 0.5, or 1, with a one-sentence rationale and your confidence (low, "
        "medium, or high)."
    )
    return await _judge_one(client, _FAITHFULNESS_SYSTEM, prompt, metric="faithfulness")


def load_chunks(conn: sqlite3.Connection, chunk_ids: Sequence[str]) -> list[ScoredChunk]:
    """Load chunks by id, preserving the retrieved order (score is irrelevant here)."""
    if not chunk_ids:
        return []
    placeholders = ",".join("?" for _ in chunk_ids)
    rows = conn.execute(
        "SELECT id, document_id, chunk_size, idx, text, start_char, end_char "
        f"FROM chunks WHERE id IN ({placeholders})",
        list(chunk_ids),
    ).fetchall()
    by_id = {row["id"]: row for row in rows}
    return [
        ScoredChunk(
            chunk_id=row["id"],
            document_id=row["document_id"],
            chunk_size=row["chunk_size"],
            idx=row["idx"],
            text=row["text"],
            start_char=row["start_char"],
            end_char=row["end_char"],
            score=0.0,
        )
        for chunk_id in chunk_ids
        if (row := by_id.get(chunk_id)) is not None
    ]


async def grade_answer(
    client: GroqClient,
    conn: sqlite3.Connection,
    question: Question,
    answer_id: str,
    answer_text: str,
    retrieved_chunk_ids: Sequence[str],
) -> Grade:
    """Grade one answer on all three metrics and assemble a persistable grade (§6.5)."""
    chunks = load_chunks(conn, retrieved_chunk_ids)
    retrieval_hit = retrieval_hit_for_question(question, chunks)
    correctness = await judge_correctness(client, question, answer_text)
    faithfulness = await judge_faithfulness(client, answer_text, chunks)

    return Grade(
        id=uuid.uuid4().hex,
        answer_id=answer_id,
        correctness=correctness.score,
        faithfulness=faithfulness.score,
        retrieval_hit=retrieval_hit,
        judge_rationale=(
            f"Correctness — {correctness.rationale} Faithfulness — {faithfulness.rationale}"
        ),
        judge_confidence=_combine_confidence(correctness.confidence, faithfulness.confidence),
        overridden=False,
    )


def insert_grade(conn: sqlite3.Connection, grade: Grade) -> None:
    """Persist one grade row."""
    conn.execute(
        "INSERT INTO grades (id, answer_id, correctness, faithfulness, retrieval_hit, "
        "judge_rationale, judge_confidence, overridden) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        (
            grade.id,
            grade.answer_id,
            grade.correctness,
            grade.faithfulness,
            grade.retrieval_hit,
            grade.judge_rationale,
            grade.judge_confidence.value,
            int(grade.overridden),
        ),
    )
    conn.commit()

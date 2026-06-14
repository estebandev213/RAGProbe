"""Exam generation: turn documents into a graded question set (§6.3).

The generator asks the 70B model (JSON mode) for a batch of questions across a
fixed taxonomy, then does the load-bearing work the LLM cannot be trusted with:
locating each *supporting quote* in the canonical document text to compute
``gold_spans`` (char ranges). Those spans are what later make retrieval scoring
comparable across chunk sizes (§6.5).

Per-question robustness, not all-or-nothing: a question is discarded when it is
semantically inconsistent (e.g. an "unanswerable" with quotes) or when any of
its quotes cannot be located. After each round the generator re-requests only
the *shortfall* per type, until the quota is met or :data:`MAX_ROUNDS` is hit.
Low-level JSON validity/repair is already handled by ``GroqClient.json_mode``.

Quote location is exact first, then a whitespace- and case-insensitive fuzzy
fallback that still returns offsets into the *original* text — so the
``document_text[start:end]`` slice round-trips (modulo that normalization).
"""

from __future__ import annotations

import json
import logging
import re
import sqlite3
import uuid
from collections import Counter
from collections.abc import Sequence
from dataclasses import dataclass

from app.core.groq_client import GroqClient, GroqJSONError, ModelRole
from app.models import (
    NOT_IN_DOCUMENTS,
    GeneratedExam,
    GeneratedQuestion,
    GoldSpan,
    QType,
    Question,
)

logger = logging.getLogger("ragprobe")

# Default exam sizes (§6.3): smaller in demo mode for free-tier rate limits.
EXAM_SIZE = 20
DEMO_EXAM_SIZE = 12

# Taxonomy mix (§6.3). Order matters only for deterministic remainder handling.
TAXONOMY: tuple[tuple[QType, float], ...] = (
    (QType.FACTUAL, 0.40),
    (QType.MULTIHOP, 0.25),
    (QType.PARAPHRASE, 0.20),
    (QType.UNANSWERABLE, 0.15),
)

# Cap how much of each document is shown to the model (§6.3: "sampled sections
# if large"). Quotes are still located against the *full* text, so truncating
# the prompt only limits what the model can quote — never what we can find.
MAX_DOC_CHARS = 12_000

# Bound on regeneration rounds so a stubborn model can't loop forever.
MAX_ROUNDS = 4

_WHITESPACE = re.compile(r"\s+")


class ExamGenerationError(RuntimeError):
    """Raised when the generator cannot assemble a full exam within the round budget."""


@dataclass(frozen=True)
class ExamDocument:
    """A document made available to the exam generator."""

    doc_id: str
    name: str
    text: str


def exam_size(demo_mode: bool) -> int:
    """Number of questions to generate for the given mode."""
    return DEMO_EXAM_SIZE if demo_mode else EXAM_SIZE


def taxonomy_counts(n_questions: int) -> dict[QType, int]:
    """Split ``n_questions`` across the taxonomy, summing to exactly ``n_questions``.

    Uses the largest-remainder method: floor each share, then hand the leftover
    questions to the types with the largest fractional parts. Deterministic.
    """
    if n_questions <= 0:
        return {qtype: 0 for qtype, _ in TAXONOMY}

    raw = {qtype: n_questions * ratio for qtype, ratio in TAXONOMY}
    counts = {qtype: int(value) for qtype, value in raw.items()}
    remainder = n_questions - sum(counts.values())
    # Largest fractional part first; ties broken by taxonomy order (stable sort).
    ordered = sorted(raw, key=lambda q: raw[q] - counts[q], reverse=True)
    for qtype in ordered[:remainder]:
        counts[qtype] += 1
    return counts


def _normalize_ws(text: str) -> str:
    """Collapse runs of whitespace to single spaces and trim; case-fold."""
    return _WHITESPACE.sub(" ", text).strip().lower()


def locate_quote(quote: str, text: str) -> tuple[int, int] | None:
    """Find ``quote`` in ``text``, returning a ``(start, end)`` char range or ``None``.

    Tries an exact substring match first, then a fuzzy fallback that ignores
    differences in whitespace and case while still reporting offsets into the
    original ``text``.
    """
    exact = text.find(quote)
    if exact != -1:
        return exact, exact + len(quote)

    needle = _normalize_ws(quote)
    if not needle:
        return None
    # Match the quote's tokens separated by arbitrary whitespace in the source.
    pattern = re.compile(
        r"\s+".join(re.escape(token) for token in needle.split(" ")),
        re.IGNORECASE,
    )
    match = pattern.search(text)
    if match:
        return match.start(), match.end()
    return None


def _locate_span(quote: str, documents: Sequence[ExamDocument]) -> GoldSpan | None:
    """Locate ``quote`` across all documents; return the first hit as a span."""
    for doc in documents:
        located = locate_quote(quote, doc.text)
        if located is not None:
            return GoldSpan(doc_id=doc.doc_id, start_char=located[0], end_char=located[1])
    return None


def resolve_question(
    run_id: str,
    generated: GeneratedQuestion,
    documents: Sequence[ExamDocument],
) -> Question | None:
    """Validate one generated question and resolve its gold spans.

    Returns a persistable :class:`Question`, or ``None`` if the question is
    semantically inconsistent or any supporting quote cannot be located (the
    caller discards it and regenerates).
    """
    is_abstention = generated.gold_answer.strip() == NOT_IN_DOCUMENTS

    if generated.qtype is QType.UNANSWERABLE:
        # Unanswerable must abstain and cite nothing; otherwise it is not what
        # the taxonomy intends.
        if not is_abstention or generated.supporting_quotes:
            return None
        return Question(
            id=uuid.uuid4().hex,
            run_id=run_id,
            qtype=QType.UNANSWERABLE,
            question=generated.question,
            gold_answer=NOT_IN_DOCUMENTS,
            gold_spans=[],
            source_doc_id=None,
        )

    # Answerable: needs a real answer and at least one locatable quote.
    if is_abstention or not generated.supporting_quotes:
        return None
    spans: list[GoldSpan] = []
    for quote in generated.supporting_quotes:
        span = _locate_span(quote, documents)
        if span is None:
            return None  # one unlocatable quote discards the whole question
        spans.append(span)

    return Question(
        id=uuid.uuid4().hex,
        run_id=run_id,
        qtype=generated.qtype,
        question=generated.question,
        gold_answer=generated.gold_answer,
        gold_spans=spans,
        source_doc_id=spans[0].doc_id,
    )


def _shortfall(target: dict[QType, int], collected: Sequence[Question]) -> dict[QType, int]:
    """How many questions of each type are still needed to meet ``target``."""
    have: Counter[QType] = Counter(q.qtype for q in collected)
    return {qtype: max(0, count - have[qtype]) for qtype, count in target.items()}


_SYSTEM_PROMPT = (
    "You are an exam author for a retrieval-augmented-generation benchmark. You "
    "read source documents and write questions that test whether a RAG system "
    "can retrieve the right passages and answer faithfully. Honor the requested "
    "question-type counts exactly and respond with JSON only."
)

_QTYPE_GUIDANCE: dict[QType, str] = {
    QType.FACTUAL: (
        "answerable from a single passage; include the one verbatim quote that supports the answer"
    ),
    QType.MULTIHOP: (
        "requires combining two passages from DIFFERENT sections; include a "
        "verbatim quote for EACH of the two passages"
    ),
    QType.PARAPHRASE: (
        "asks about a passage using DIFFERENT words (minimal vocabulary overlap "
        "with the source) to stress-test keyword search; include the verbatim "
        "quote it is based on"
    ),
    QType.UNANSWERABLE: (
        "plausible-sounding but NOT answered anywhere in the documents; set "
        f'gold_answer to exactly "{NOT_IN_DOCUMENTS}" and leave '
        "supporting_quotes empty"
    ),
}


def _build_prompt(documents: Sequence[ExamDocument], need: dict[QType, int]) -> str:
    """Render the generation prompt for the per-type counts still needed."""
    docs_block = "\n\n".join(
        f"[DOCUMENT {i + 1}: {doc.name}]\n{doc.text[:MAX_DOC_CHARS]}"
        for i, doc in enumerate(documents)
    )
    breakdown = "\n".join(
        f"- {count} {qtype.value} question(s): {_QTYPE_GUIDANCE[qtype]}"
        for qtype, count in need.items()
        if count > 0
    )
    total = sum(count for count in need.values() if count > 0)
    return (
        f"Source documents:\n\n{docs_block}\n\n"
        f"Write exactly {total} question(s) with this breakdown:\n{breakdown}\n\n"
        "For every answerable question, copy the supporting quote(s) "
        "character-for-character from the documents into `supporting_quotes` so "
        "they can be located in the source text. Each quote must be a contiguous "
        "substring of a single document."
    )


async def generate_exam(
    client: GroqClient,
    run_id: str,
    documents: Sequence[ExamDocument],
    n_questions: int,
) -> list[Question]:
    """Generate a full exam of ``n_questions`` with located gold spans (§6.3).

    Requests questions per the taxonomy, resolving and validating each; after
    every round only the remaining shortfall per type is re-requested. Raises
    :class:`ExamGenerationError` if the quota is unmet after :data:`MAX_ROUNDS`.
    """
    if not documents:
        raise ExamGenerationError("Cannot generate an exam from zero documents.")

    target = taxonomy_counts(n_questions)
    collected: list[Question] = []

    for round_index in range(1, MAX_ROUNDS + 1):
        short = _shortfall(target, collected)
        if sum(short.values()) == 0:
            break

        prompt = _build_prompt(documents, short)
        try:
            exam = await client.json_mode(
                prompt,
                GeneratedExam,
                role=ModelRole.GENERATION,
                system=_SYSTEM_PROMPT,
            )
        except GroqJSONError:
            logger.warning(
                "exam_round_invalid_json",
                extra={"run_id": run_id, "round": round_index},
            )
            continue

        accepted = 0
        for generated in exam.questions:
            question = resolve_question(run_id, generated, documents)
            if question is None:
                continue
            # Only accept a type we still need, so an over-eager batch can't
            # skew the final mix.
            if _shortfall(target, collected)[question.qtype] > 0:
                collected.append(question)
                accepted += 1

        logger.info(
            "exam_round",
            extra={
                "run_id": run_id,
                "round": round_index,
                "returned": len(exam.questions),
                "accepted": accepted,
                "collected": len(collected),
            },
        )

    remaining = sum(_shortfall(target, collected).values())
    if remaining > 0:
        raise ExamGenerationError(
            f"Exam generation fell short by {remaining} question(s) after "
            f"{MAX_ROUNDS} rounds (target {n_questions})."
        )
    return collected


def insert_questions(conn: sqlite3.Connection, questions: Sequence[Question]) -> None:
    """Persist a generated exam's questions, with gold spans stored as JSON."""
    conn.executemany(
        "INSERT INTO questions "
        "(id, run_id, qtype, question, gold_answer, gold_spans, source_doc_id) "
        "VALUES (?, ?, ?, ?, ?, ?, ?)",
        [
            (
                q.id,
                q.run_id,
                q.qtype.value,
                q.question,
                q.gold_answer,
                _spans_to_json(q.gold_spans),
                q.source_doc_id,
            )
            for q in questions
        ],
    )
    conn.commit()


def _spans_to_json(spans: Sequence[GoldSpan]) -> str:
    """Serialize gold spans to the JSON shape stored in ``questions.gold_spans``."""
    return json.dumps([span.model_dump() for span in spans])

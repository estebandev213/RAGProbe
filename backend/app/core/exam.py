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
Low-level JSON validity/repair is already handled by ``LLMClient.json_mode``.

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
from itertools import combinations

from app.core.llm_client import LLMClient, LLMJSONError, ModelRole
from app.models import (
    NOT_IN_DOCUMENTS,
    GeneratedExam,
    GeneratedQuestion,
    GoldSpan,
    QType,
    Question,
    RunTitle,
    SpanRange,
)

logger = logging.getLogger("ragprobe")

# Default exam sizes (§6.3): smaller in demo mode for free-tier rate limits.
EXAM_SIZE = 20
DEMO_EXAM_SIZE = 5

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

# Minimum character gap between a multi-hop question's gold spans (unless they
# sit in different documents). Without this check, two quotes from adjacent
# sentences pass as "multi-hop" — a factual question in disguise that one
# retrieved chunk covers entirely, inflating multi-hop retrieval scores. The
# ideal rule (spans not coverable by a single smallest-size chunk, i.e. a
# ~1600-char gap) would make multi-hop unsatisfiable on small demo documents,
# so this is a pragmatic floor of roughly a paragraph or two.
MIN_MULTIHOP_SPAN_GAP_CHARS = 400

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


# Bound on recorded alternate occurrences of one quote, so pathologically
# repetitive text (a phrase on every page) cannot bloat the stored spans.
MAX_ALTERNATE_OCCURRENCES = 20


def locate_quote(quote: str, text: str) -> tuple[int, int] | None:
    """Find ``quote`` in ``text``, returning a ``(start, end)`` char range or ``None``.

    Tries an exact substring match first, then a fuzzy fallback that ignores
    differences in whitespace and case while still reporting offsets into the
    original ``text``.
    """
    occurrences = locate_quote_all(quote, text)
    return occurrences[0] if occurrences else None


def locate_quote_all(quote: str, text: str) -> list[tuple[int, int]]:
    """Every occurrence of ``quote`` in ``text`` as ``(start, end)`` ranges.

    Exact substring matches win; only when there are none does the fuzzy
    (whitespace- and case-insensitive) pattern run. Ranges are returned in
    document order, capped at :data:`MAX_ALTERNATE_OCCURRENCES` + 1.
    """
    limit = MAX_ALTERNATE_OCCURRENCES + 1
    exact: list[tuple[int, int]] = []
    start = text.find(quote)
    while start != -1 and len(exact) < limit:
        exact.append((start, start + len(quote)))
        start = text.find(quote, start + 1)
    if exact:
        return exact

    needle = _normalize_ws(quote)
    if not needle:
        return []
    # Match the quote's tokens separated by arbitrary whitespace in the source.
    pattern = re.compile(
        r"\s+".join(re.escape(token) for token in needle.split(" ")),
        re.IGNORECASE,
    )
    return [(m.start(), m.end()) for m in pattern.finditer(text)][:limit]


def _locate_span(quote: str, documents: Sequence[ExamDocument]) -> GoldSpan | None:
    """Locate ``quote`` across all documents, recording every occurrence.

    The first occurrence (scanning documents in order) becomes the primary
    span; all further occurrences — in the same document or any other — are
    stored as ``alternates``, so retrieval of a repeated-but-identical passage
    scores as a hit instead of a false miss (§6.5).
    """
    ranges: list[SpanRange] = []
    for doc in documents:
        for start, end in locate_quote_all(quote, doc.text):
            ranges.append(SpanRange(doc_id=doc.doc_id, start_char=start, end_char=end))
    if not ranges:
        return None
    primary = ranges[0]
    return GoldSpan(
        doc_id=primary.doc_id,
        start_char=primary.start_char,
        end_char=primary.end_char,
        alternates=ranges[1 : MAX_ALTERNATE_OCCURRENCES + 1],
    )


def _spans_are_separated(spans: Sequence[GoldSpan]) -> bool:
    """Whether some pair of spans plausibly comes from *distinct* passages.

    True when any two spans live in different documents or are at least
    :data:`MIN_MULTIHOP_SPAN_GAP_CHARS` apart in the same document. Used to
    reject "multi-hop" questions whose evidence is really one passage.
    """
    for a, b in combinations(spans, 2):
        if a.doc_id != b.doc_id:
            return True
        gap = max(a.start_char, b.start_char) - min(a.end_char, b.end_char)
        if gap >= MIN_MULTIHOP_SPAN_GAP_CHARS:
            return True
    return False


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

    # Multi-hop must actually hop: two or more spans from distinct passages.
    # A single quote, or quotes from neighboring sentences, is factual in
    # disguise and would inflate multi-hop retrieval scores — discard it and
    # let the shortfall loop request a replacement.
    if generated.qtype is QType.MULTIHOP and (len(spans) < 2 or not _spans_are_separated(spans)):
        return None

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


# Enough of each document's head to name its subject — a title needs far less
# context than exam generation (§8).
TITLE_SAMPLE_CHARS = 1500
# Keep a title short enough to render on one line of a history card.
TITLE_MAX_CHARS = 80

_TITLE_SYSTEM_PROMPT = (
    "You name document sets. Given some source documents, you reply with a short, "
    "specific title capturing their subject so a user can recognize them later. "
    "Respond with JSON only."
)


async def generate_title(client: LLMClient, documents: Sequence[ExamDocument]) -> str:
    """Generate a short, recognizable title for a run's documents (§8).

    Uses the cheap FAST model and a small head sample of each document. Propagates
    the usual :class:`LLMError` subclasses on failure — the caller falls back to the
    document names rather than failing the run. May return "" if the model produces
    nothing usable; the caller treats that as "no title".
    """
    docs_block = "\n\n".join(
        f"[DOCUMENT {i + 1}: {doc.name}]\n{doc.text[:TITLE_SAMPLE_CHARS]}"
        for i, doc in enumerate(documents)
    )
    prompt = (
        f"Source documents:\n\n{docs_block}\n\n"
        "Write a concise 3-8 word title in Title Case naming the subject matter of "
        "these documents, so a user can recognize this evaluation in a list later. "
        "Prefer the real topic over the file names. Do not use quotation marks and do "
        "not include words like 'evaluation', 'documents', 'dataset', or 'RAG'."
    )
    result = await client.json_mode(
        prompt,
        RunTitle,
        role=ModelRole.FAST,
        system=_TITLE_SYSTEM_PROMPT,
    )
    title = _WHITESPACE.sub(" ", result.title).strip().strip("\"'").strip()
    return title[:TITLE_MAX_CHARS].strip()


async def generate_exam(
    client: LLMClient,
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
        except LLMJSONError:
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

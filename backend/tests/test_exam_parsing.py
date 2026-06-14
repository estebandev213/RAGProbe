"""Tests for exam generation, span location, and persistence (§6.3, commit #7).

Groq is mocked with ``respx``: the generation endpoint returns canned JSON
payloads, so the suite exercises taxonomy math, quote→span location, the
discard-and-regenerate loop, and SQLite persistence without any network or real
``GROQ_API_KEY``.
"""

import json
from collections.abc import Mapping
from pathlib import Path

import httpx
import pytest
import respx
from app.core.exam import (
    DEMO_EXAM_SIZE,
    EXAM_SIZE,
    ExamDocument,
    ExamGenerationError,
    generate_exam,
    insert_questions,
    locate_quote,
    resolve_question,
    taxonomy_counts,
)
from app.core.groq_client import GroqClient
from app.db import connect, run_migrations
from app.models import NOT_IN_DOCUMENTS, GeneratedQuestion, QType

URL = "https://api.groq.com/openai/v1/chat/completions"
GEN_MODEL = "gen-model"
FAST_MODEL = "fast-model"

FIXTURE = Path(__file__).resolve().parents[1] / "fixtures" / "sample_docs" / "meridian-overview.md"

# Verbatim substrings of the fixture, used as supporting quotes.
QUOTES = [
    "Meridian stores data as **collections** of JSON documents.",
    "Writes are always linearizable.",
    "Meridian Community Edition is open source under the Apache 2.0 license.",
]


@pytest.fixture
def document() -> ExamDocument:
    return ExamDocument(doc_id="doc1", name="meridian-overview.md", text=FIXTURE.read_text())


def _client() -> GroqClient:
    return GroqClient(
        api_key="test-key",
        generation_model=GEN_MODEL,
        fast_model=FAST_MODEL,
        jitter=lambda _a, _b: 0.0,
    )


def _completion(payload: Mapping[str, object]) -> httpx.Response:
    """Wrap a JSON-mode payload in a Groq chat-completion response."""
    return httpx.Response(
        200,
        json={
            "model": GEN_MODEL,
            "choices": [{"message": {"content": json.dumps(payload)}}],
            "usage": {"prompt_tokens": 10, "completion_tokens": 20, "total_tokens": 30},
        },
    )


def _make_questions(
    counts: dict[QType, int], *, bad_first_factual: bool = False
) -> list[dict[str, object]]:
    """Build a list of generated-question dicts matching ``counts`` per type."""
    out: list[dict[str, object]] = []
    index = 0
    for qtype, n in counts.items():
        for k in range(n):
            if qtype is QType.UNANSWERABLE:
                out.append(
                    {
                        "qtype": "unanswerable",
                        "question": f"q{index}",
                        "gold_answer": NOT_IN_DOCUMENTS,
                        "supporting_quotes": [],
                    }
                )
            elif qtype is QType.MULTIHOP:
                out.append(
                    {
                        "qtype": "multihop",
                        "question": f"q{index}",
                        "gold_answer": "an answer",
                        "supporting_quotes": [QUOTES[0], QUOTES[1]],
                    }
                )
            else:
                bad = bad_first_factual and qtype is QType.FACTUAL and k == 0
                quote = "ABSENT PHRASE ZZZ" if bad else QUOTES[index % len(QUOTES)]
                out.append(
                    {
                        "qtype": qtype.value,
                        "question": f"q{index}",
                        "gold_answer": "an answer",
                        "supporting_quotes": [quote],
                    }
                )
            index += 1
    return out


# ---------------------------------------------------------------------------
# Taxonomy
# ---------------------------------------------------------------------------


def test_taxonomy_counts_sum_to_total() -> None:
    for n in (12, 20, 7, 1, 100):
        assert sum(taxonomy_counts(n).values()) == n


def test_taxonomy_counts_default_sizes() -> None:
    assert taxonomy_counts(EXAM_SIZE) == {
        QType.FACTUAL: 8,
        QType.MULTIHOP: 5,
        QType.PARAPHRASE: 4,
        QType.UNANSWERABLE: 3,
    }
    assert taxonomy_counts(DEMO_EXAM_SIZE) == {
        QType.FACTUAL: 5,
        QType.MULTIHOP: 3,
        QType.PARAPHRASE: 2,
        QType.UNANSWERABLE: 2,
    }


# ---------------------------------------------------------------------------
# Quote → span location
# ---------------------------------------------------------------------------


def test_locate_quote_exact(document: ExamDocument) -> None:
    quote = QUOTES[0]
    located = locate_quote(quote, document.text)
    assert located is not None
    start, end = located
    assert document.text[start:end] == quote


def test_locate_quote_fuzzy_whitespace(document: ExamDocument) -> None:
    # Same words, different internal whitespace and case → still locatable.
    quote = "writes  are\nALWAYS linearizable."
    located = locate_quote(quote, document.text)
    assert located is not None
    start, end = located
    assert document.text[start:end].lower() == "writes are always linearizable."


def test_locate_quote_missing(document: ExamDocument) -> None:
    assert locate_quote("this phrase is absent from the document", document.text) is None


# ---------------------------------------------------------------------------
# resolve_question
# ---------------------------------------------------------------------------


def test_resolve_answerable_locates_spans(document: ExamDocument) -> None:
    generated = GeneratedQuestion(
        qtype=QType.FACTUAL,
        question="What is a collection?",
        gold_answer="A set of JSON documents",
        supporting_quotes=[QUOTES[0]],
    )
    question = resolve_question("run1", generated, [document])
    assert question is not None
    assert question.source_doc_id == "doc1"
    assert len(question.gold_spans) == 1
    span = question.gold_spans[0]
    assert document.text[span.start_char : span.end_char] == QUOTES[0]


def test_resolve_unanswerable_has_no_spans(document: ExamDocument) -> None:
    generated = GeneratedQuestion(
        qtype=QType.UNANSWERABLE,
        question="What is Meridian's pricing in euros?",
        gold_answer=NOT_IN_DOCUMENTS,
        supporting_quotes=[],
    )
    question = resolve_question("run1", generated, [document])
    assert question is not None
    assert question.gold_spans == []
    assert question.source_doc_id is None


def test_resolve_discards_unlocatable_quote(document: ExamDocument) -> None:
    generated = GeneratedQuestion(
        qtype=QType.FACTUAL,
        question="bogus",
        gold_answer="x",
        supporting_quotes=["a quote that is not in the document at all"],
    )
    assert resolve_question("run1", generated, [document]) is None


def test_resolve_discards_inconsistent_unanswerable(document: ExamDocument) -> None:
    # Unanswerable but carries quotes / a real answer → discarded.
    generated = GeneratedQuestion(
        qtype=QType.UNANSWERABLE,
        question="inconsistent",
        gold_answer="actually answerable",
        supporting_quotes=[QUOTES[0]],
    )
    assert resolve_question("run1", generated, [document]) is None


# ---------------------------------------------------------------------------
# generate_exam (mocked Groq)
# ---------------------------------------------------------------------------


@respx.mock
async def test_generate_exam_full_set(document: ExamDocument) -> None:
    payload = {"questions": _make_questions(taxonomy_counts(EXAM_SIZE))}
    respx.post(URL).mock(side_effect=[_completion(payload)])

    async with _client() as client:
        questions = await generate_exam(client, "run1", [document], EXAM_SIZE)

    assert len(questions) == EXAM_SIZE
    # Every answerable question has located spans that round-trip to the source.
    for q in questions:
        if q.qtype is QType.UNANSWERABLE:
            assert q.gold_spans == []
            assert q.source_doc_id is None
        else:
            assert q.gold_spans, f"{q.qtype} should have gold spans"
            for span in q.gold_spans:
                sliced = document.text[span.start_char : span.end_char]
                assert sliced  # non-empty


@respx.mock
async def test_generate_exam_regenerates_after_discard(document: ExamDocument) -> None:
    # Round 1 has one factual question with an unlocatable quote → discarded,
    # leaving a shortfall of one factual; round 2 supplies a valid replacement.
    first = {"questions": _make_questions(taxonomy_counts(DEMO_EXAM_SIZE), bad_first_factual=True)}
    second = {
        "questions": [
            {
                "qtype": "factual",
                "question": "replacement",
                "gold_answer": "an answer",
                "supporting_quotes": [QUOTES[2]],
            }
        ]
    }
    respx.post(URL).mock(side_effect=[_completion(first), _completion(second)])

    async with _client() as client:
        questions = await generate_exam(client, "run1", [document], DEMO_EXAM_SIZE)

    assert len(questions) == DEMO_EXAM_SIZE
    assert taxonomy_counts(DEMO_EXAM_SIZE)[QType.FACTUAL] == sum(
        1 for q in questions if q.qtype is QType.FACTUAL
    )


@respx.mock
async def test_generate_exam_raises_when_short(document: ExamDocument) -> None:
    # Every round returns the same too-small batch → quota never met.
    payload = {"questions": _make_questions({QType.FACTUAL: 1})}
    respx.post(URL).mock(return_value=_completion(payload))

    async with _client() as client:
        with pytest.raises(ExamGenerationError):
            await generate_exam(client, "run1", [document], DEMO_EXAM_SIZE)


# ---------------------------------------------------------------------------
# Persistence
# ---------------------------------------------------------------------------


@respx.mock
async def test_insert_questions_round_trips(document: ExamDocument) -> None:
    payload = {"questions": _make_questions(taxonomy_counts(DEMO_EXAM_SIZE))}
    respx.post(URL).mock(side_effect=[_completion(payload)])

    conn = connect(":memory:")
    try:
        run_migrations(conn)
        conn.execute(
            "INSERT INTO runs (id, status, doc_ids, settings, created_at) VALUES (?, ?, ?, ?, ?)",
            ("run1", "generating_exam", json.dumps(["doc1"]), "{}", "2026-06-13T00:00:00Z"),
        )
        conn.commit()

        async with _client() as client:
            questions = await generate_exam(client, "run1", [document], DEMO_EXAM_SIZE)
        insert_questions(conn, questions)

        rows = conn.execute(
            "SELECT qtype, gold_spans, source_doc_id FROM questions WHERE run_id = ?",
            ("run1",),
        ).fetchall()
        assert len(rows) == DEMO_EXAM_SIZE
        for row in rows:
            spans = json.loads(row["gold_spans"])
            if row["qtype"] == QType.UNANSWERABLE.value:
                assert spans == []
                assert row["source_doc_id"] is None
            else:
                assert spans
                assert all({"doc_id", "start_char", "end_char"} <= set(s) for s in spans)
    finally:
        conn.close()

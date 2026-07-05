"""Run orchestrator: config matrix, retrieve→answer pipeline, SSE progress (§6.7).

A run is a background ``asyncio.Task`` that walks a document set through five
phases — ``generating_exam → indexing → answering → judging → done`` — emitting
progress onto the in-memory event bus as it goes.

The matrix is the point: every (config x question) pair is answered, where a
config is a ``chunk_size x strategy`` combination (six in full mode, four in demo
mode for free-tier rate limits). Answers are persisted with the chunks they
retrieved and their latency/token cost, then the judge (§6.5) grades each one.

The orchestrator owns its own SQLite connection and Groq client (both injectable
so tests run mocked and instant); it must not borrow a request-scoped one, since
it outlives the HTTP request that started it.
"""

from __future__ import annotations

import asyncio
import json
import logging
import sqlite3
import uuid
from collections.abc import Sequence
from dataclasses import dataclass
from itertools import product

from app.config import get_settings
from app.core.chunking import CHUNK_SIZES
from app.core.exam import ExamDocument, generate_exam, insert_questions
from app.core.indexing import Embedder, embed_texts, index_document
from app.core.judge import grade_answer, insert_grade
from app.core.llm_client import (
    ChatMessage,
    LLMClient,
    ModelRole,
    answer_client_from_settings,
    judge_client_from_settings,
)
from app.core.retrieval import Retriever, build_context, make_retriever
from app.db import get_db
from app.events import bus
from app.models import (
    ConfigSummary,
    Question,
    RunEvent,
    RunEventType,
    RunSettings,
    RunStatus,
)

logger = logging.getLogger("ragprobe")

# Retrieval depth, fixed for the v1 matrix (§6.2).
TOP_K = 5

# Strategy sets per mode (§6.2): demo keeps only hybrid, so its matrix is the two
# chunk sizes at a fixed strategy (2 configs vs 6) — isolating chunk size while
# halving the LLM-call volume to stay well inside free-tier rate limits.
FULL_STRATEGIES: tuple[str, ...] = ("vector", "bm25", "hybrid")
DEMO_STRATEGIES: tuple[str, ...] = ("hybrid",)

# Strict-grounding system prompt for answer generation (§6.4): the model must
# abstain rather than draw on parametric knowledge, so abstention is measurable.
_ANSWER_SYSTEM = (
    "Answer ONLY from the provided context. If the context does not contain the "
    "answer, reply exactly: NOT_IN_DOCUMENTS."
)


@dataclass(frozen=True)
class AnswerResult:
    """One generated answer plus the retrieval and cost data to persist."""

    answer_text: str
    retrieved_chunk_ids: list[str]
    latency_ms: int
    prompt_tokens: int
    completion_tokens: int


def strategies_for(demo_mode: bool) -> tuple[str, ...]:
    """The retrieval strategies exercised in the given mode."""
    return DEMO_STRATEGIES if demo_mode else FULL_STRATEGIES


def build_config_matrix(run_id: str, demo_mode: bool) -> list[ConfigSummary]:
    """Materialize the ``chunk_size x strategy`` config matrix for a run (§6.2).

    Full mode yields six configs, demo mode four; ``top_k`` is fixed at
    :data:`TOP_K` and ``label`` is the ``"{chunk_size}/{strategy}"`` shown in the
    report and on progress events.
    """
    return [
        ConfigSummary(
            id=uuid.uuid4().hex,
            run_id=run_id,
            chunk_size=chunk_size,
            strategy=strategy,
            top_k=TOP_K,
            label=f"{chunk_size}/{strategy}",
        )
        for chunk_size, strategy in product(CHUNK_SIZES, strategies_for(demo_mode))
    ]


def insert_configs(conn: sqlite3.Connection, configs: Sequence[ConfigSummary]) -> None:
    """Persist the config matrix."""
    conn.executemany(
        "INSERT INTO configs (id, run_id, chunk_size, strategy, top_k, label) "
        "VALUES (?, ?, ?, ?, ?, ?)",
        [(c.id, c.run_id, c.chunk_size, c.strategy, c.top_k, c.label) for c in configs],
    )
    conn.commit()


async def answer_question(
    client: LLMClient,
    retriever: Retriever,
    question: Question,
    config: ConfigSummary,
) -> AnswerResult:
    """Retrieve context for a question under a config and generate the answer (§6.4)."""
    chunks = retriever.retrieve(question.question, config.chunk_size, config.top_k)
    context = build_context(chunks)
    messages = [
        ChatMessage(role="system", content=_ANSWER_SYSTEM),
        ChatMessage(role="user", content=f"Context:\n{context}\n\nQuestion: {question.question}"),
    ]

    result = await client.chat(messages, role=ModelRole.GENERATION)

    return AnswerResult(
        answer_text=result.text.strip(),
        retrieved_chunk_ids=[chunk.chunk_id for chunk in chunks],
        # The successful attempt's wall time only (see ChatResult): mean latency
        # on the report reflects the provider, not this client's rate limiter.
        latency_ms=result.latency_ms,
        prompt_tokens=result.prompt_tokens,
        completion_tokens=result.completion_tokens,
    )


def insert_answer(
    conn: sqlite3.Connection,
    run_id: str,
    config_id: str,
    question_id: str,
    result: AnswerResult,
) -> None:
    """Persist one answer row, with retrieved chunk ids stored as JSON."""
    conn.execute(
        "INSERT INTO answers (id, run_id, config_id, question_id, answer_text, "
        "retrieved_chunk_ids, latency_ms, prompt_tokens, completion_tokens) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        (
            uuid.uuid4().hex,
            run_id,
            config_id,
            question_id,
            result.answer_text,
            json.dumps(result.retrieved_chunk_ids),
            result.latency_ms,
            result.prompt_tokens,
            result.completion_tokens,
        ),
    )
    conn.commit()


async def judge_answers(
    conn: sqlite3.Connection,
    client: LLMClient,
    run_id: str,
    questions: Sequence[Question],
) -> None:
    """Grade every answer in a run, streaming judging progress (§6.5).

    Walks the run's persisted answers, grades each against its question (the
    in-memory exam, keyed by id), persists the grade, and emits a ``progress``
    event per answer so the UI can show the judging phase advancing.
    """
    questions_by_id = {question.id: question for question in questions}
    rows = conn.execute(
        "SELECT id, question_id, answer_text, retrieved_chunk_ids FROM answers WHERE run_id = ?",
        (run_id,),
    ).fetchall()

    total = len(rows)
    for done, row in enumerate(rows, start=1):
        question = questions_by_id[row["question_id"]]
        grade = await grade_answer(
            client,
            conn,
            question,
            row["id"],
            row["answer_text"],
            json.loads(row["retrieved_chunk_ids"]),
        )
        insert_grade(conn, grade)
        bus.publish(
            run_id,
            RunEvent(
                type=RunEventType.PROGRESS,
                phase=RunStatus.JUDGING,
                done=done,
                total=total,
            ),
        )


def _load_documents(conn: sqlite3.Connection, doc_ids: Sequence[str]) -> list[ExamDocument]:
    """Load the documents a run operates on, preserving the requested order."""
    placeholders = ",".join("?" for _ in doc_ids)
    rows = conn.execute(
        f"SELECT id, name, text FROM documents WHERE id IN ({placeholders})",
        list(doc_ids),
    ).fetchall()
    by_id = {row["id"]: row for row in rows}
    return [
        ExamDocument(doc_id=row["id"], name=row["name"], text=row["text"])
        for doc_id in doc_ids
        if (row := by_id.get(doc_id)) is not None
    ]


def _enter_phase(conn: sqlite3.Connection, run_id: str, status: RunStatus) -> None:
    """Advance the persisted run status and publish a matching phase event."""
    conn.execute("UPDATE runs SET status = ? WHERE id = ?", (status.value, run_id))
    conn.commit()
    bus.publish(run_id, RunEvent(type=RunEventType.PHASE, phase=status))


async def execute_run(
    run_id: str,
    doc_ids: Sequence[str],
    settings: RunSettings,
    *,
    embed: Embedder = embed_texts,
    client: LLMClient | None = None,
    judge_client: LLMClient | None = None,
) -> None:
    """Drive a run through its phases, persisting results and streaming progress.

    Each phase updates ``runs.status`` and emits an SSE event; the answering
    phase emits a ``progress`` event per (config, question) and a ``config_done``
    per finished config. Any failure flips the run to ``error`` with the message,
    emits an ``error`` event, and always closes the event stream.

    Grading uses ``judge_client`` when available — in production that is the
    independent Gemini client (built here when ``GEMINI_API_KEY`` is set), so
    the model that grades is not the model that answered. Without one, judging
    falls back to the answer client.
    """
    owns_client = client is None
    answerer = client or answer_client_from_settings(get_settings())
    # Only build a judge client when the caller didn't inject either client
    # (tests inject `client` and expect no surprise second provider).
    owns_judge = judge_client is None and client is None
    judge = judge_client or (judge_client_from_settings(get_settings()) if owns_judge else None)
    if judge is None:
        judge = answerer
        owns_judge = False
    logger.info(
        "run_clients",
        extra={"run_id": run_id, "independent_judge": judge is not answerer},
    )

    with get_db() as conn:
        try:
            documents = _load_documents(conn, doc_ids)
            if not documents:
                raise ValueError("Run has no resolvable documents to evaluate.")

            _enter_phase(conn, run_id, RunStatus.GENERATING_EXAM)
            questions = await generate_exam(answerer, run_id, documents, settings.n_questions)
            insert_questions(conn, questions)

            _enter_phase(conn, run_id, RunStatus.INDEXING)
            for document in documents:
                await asyncio.to_thread(index_document, conn, document.doc_id, document.text, embed)

            _enter_phase(conn, run_id, RunStatus.ANSWERING)
            configs = build_config_matrix(run_id, settings.demo_mode)
            insert_configs(conn, configs)
            retrievers = {
                strategy: make_retriever(strategy, conn, doc_ids, embed)
                for strategy in strategies_for(settings.demo_mode)
            }

            total = len(questions)
            for config in configs:
                retriever = retrievers[config.strategy]
                for done, question in enumerate(questions, start=1):
                    result = await answer_question(answerer, retriever, question, config)
                    insert_answer(conn, run_id, config.id, question.id, result)
                    bus.publish(
                        run_id,
                        RunEvent(
                            type=RunEventType.PROGRESS,
                            phase=RunStatus.ANSWERING,
                            config_label=config.label,
                            done=done,
                            total=total,
                        ),
                    )
                bus.publish(
                    run_id,
                    RunEvent(type=RunEventType.CONFIG_DONE, config_label=config.label),
                )

            _enter_phase(conn, run_id, RunStatus.JUDGING)
            await judge_answers(conn, judge, run_id, questions)

            _enter_phase(conn, run_id, RunStatus.DONE)
            bus.publish(run_id, RunEvent(type=RunEventType.RUN_DONE))
            logger.info(
                "run_done",
                extra={"run_id": run_id, "configs": len(configs), "questions": total},
            )
        except Exception as exc:
            message = str(exc)
            conn.execute(
                "UPDATE runs SET status = ?, error = ? WHERE id = ?",
                (RunStatus.ERROR.value, message, run_id),
            )
            conn.commit()
            bus.publish(run_id, RunEvent(type=RunEventType.ERROR, message=message))
            logger.exception("run_failed", extra={"run_id": run_id})
        finally:
            bus.close(run_id)
            if owns_judge:
                await judge.aclose()
            if owns_client:
                await answerer.aclose()

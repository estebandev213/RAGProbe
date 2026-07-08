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
from collections import Counter
from collections.abc import Sequence
from dataclasses import dataclass
from itertools import product

from app.config import get_settings
from app.core.chunking import CHUNK_SIZES
from app.core.exam import ExamDocument, generate_exam, generate_title, insert_questions
from app.core.indexing import Embedder, embed_texts, index_document
from app.core.judge import grade_answer, insert_grade
from app.core.llm_client import (
    ChatMessage,
    LLMClient,
    LLMError,
    ModelRole,
    answer_client_from_settings,
    judge_client_from_settings,
)
from app.core.retrieval import Retriever, build_context, make_retriever
from app.db import get_db
from app.events import bus
from app.models import (
    NOT_IN_DOCUMENTS,
    AnswerPayload,
    ConfigSpec,
    ConfigSummary,
    GradePayload,
    Question,
    QuestionPayload,
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

# Sandbox config-count caps per mode (§8): a run's total LLM calls scale with
# (questions x configs x metrics), so demo halves the ceiling to stay inside
# free-tier rate limits. The caps govern *explicit* Sandbox lists only; the
# derived full matrix is six configs and is not bound by them.
MAX_CONFIGS_DEMO = 2
MAX_CONFIGS_FULL = 4

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


def max_configs(demo_mode: bool) -> int:
    """How many explicit Sandbox configs a run may request in the given mode (§8)."""
    return MAX_CONFIGS_DEMO if demo_mode else MAX_CONFIGS_FULL


def derived_specs(demo_mode: bool) -> list[ConfigSpec]:
    """The default ``chunk_size x strategy`` matrix used when no configs are given.

    This is the zero-config fallback: full mode yields six configs (every chunk
    size x every strategy), demo mode two (both sizes at the fixed hybrid
    strategy), all at the default retrieval depth :data:`TOP_K`.
    """
    return [
        ConfigSpec(chunk_size=chunk_size, strategy=strategy, top_k=TOP_K)
        for chunk_size, strategy in product(CHUNK_SIZES, strategies_for(demo_mode))
    ]


def _unique_labels(specs: Sequence[ConfigSpec]) -> list[str]:
    """Human labels for a config set, disambiguated only where they'd collide.

    The base label is ``"{chunk_size}/{strategy}"``. Two Sandbox configs can share
    that (same size and strategy, different ``top_k``) — since the report and SSE
    events group by label, a collision would silently merge them, so colliding
    labels gain a ``"·k{top_k}"`` suffix. The derived matrix never collides, so it
    keeps its familiar ``"400/vector"`` labels untouched.
    """
    base = [f"{spec.chunk_size}/{spec.strategy}" for spec in specs]
    counts = Counter(base)
    return [
        f"{label}·k{spec.top_k}" if counts[label] > 1 else label
        for label, spec in zip(base, specs, strict=True)
    ]


def build_config_matrix(
    run_id: str,
    demo_mode: bool,
    specs: Sequence[ConfigSpec] | None = None,
) -> list[ConfigSummary]:
    """Materialize a run's config matrix as persistable :class:`ConfigSummary` rows.

    ``specs`` is the explicit Sandbox list; when ``None`` the demo/full matrix is
    derived from ``demo_mode`` (:func:`derived_specs`). Labels are made unique
    within the set so the report and progress events can group by them safely.
    """
    resolved = list(specs) if specs is not None else derived_specs(demo_mode)
    labels = _unique_labels(resolved)
    return [
        ConfigSummary(
            id=uuid.uuid4().hex,
            run_id=run_id,
            chunk_size=spec.chunk_size,
            strategy=spec.strategy,
            top_k=spec.top_k,
            label=label,
        )
        for spec, label in zip(resolved, labels, strict=True)
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
    # 1-based position of each question in the exam, so a grade event can name the
    # same turn ("Q3") the answering phase used.
    idx_by_qid = {question.id: idx for idx, question in enumerate(questions, start=1)}
    labels_by_cid = {
        row["id"]: row["label"]
        for row in conn.execute(
            "SELECT id, label FROM configs WHERE run_id = ?", (run_id,)
        ).fetchall()
    }
    rows = conn.execute(
        "SELECT id, config_id, question_id, answer_text, retrieved_chunk_ids "
        "FROM answers WHERE run_id = ?",
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
        # Content event → the judge's verdict lands on its transcript turn; the
        # progress event (kept) advances the judging counter.
        bus.publish(
            run_id,
            RunEvent(
                type=RunEventType.GRADE,
                config_label=labels_by_cid.get(row["config_id"]),
                done=done,
                total=total,
                grade=GradePayload(
                    idx=idx_by_qid[row["question_id"]],
                    qtype=question.qtype,
                    correctness=grade.correctness,
                    faithfulness=grade.faithfulness,
                    retrieval_hit=grade.retrieval_hit,
                    confidence=grade.judge_confidence,
                    rationale=grade.judge_rationale,
                ),
            ),
        )
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


def _think(run_id: str, message: str, phase: RunStatus | None = None) -> None:
    """Publish a ``thinking`` narration line for the live transcript (§6.7).

    Purely cosmetic — it carries no state and is never persisted — but it is what
    keeps the run from going dark between the heavier content events, giving the
    progress screen its running "thinking…" commentary.
    """
    bus.publish(run_id, RunEvent(type=RunEventType.THINKING, phase=phase, message=message))


def _delete_run(conn: sqlite3.Connection, run_id: str) -> None:
    """Delete a run and everything hanging off it, children first (FKs are ON).

    A failed run is not kept: it never appears in history and its report 404s.
    Deletion order follows the foreign keys — grades reference answers, and
    answers/configs/questions reference the run.
    """
    conn.execute(
        "DELETE FROM grades WHERE answer_id IN (SELECT id FROM answers WHERE run_id = ?)",
        (run_id,),
    )
    conn.execute("DELETE FROM answers   WHERE run_id = ?", (run_id,))
    conn.execute("DELETE FROM configs   WHERE run_id = ?", (run_id,))
    conn.execute("DELETE FROM questions WHERE run_id = ?", (run_id,))
    conn.execute("DELETE FROM runs      WHERE id     = ?", (run_id,))
    conn.commit()


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

    max_run_seconds = get_settings().max_run_seconds
    with get_db() as conn:
        try:
            # A hard deadline caps a run that the free-tier rate limiter would
            # otherwise drag out indefinitely; on expiry this raises TimeoutError,
            # handled below like any other failure (the run is deleted).
            async with asyncio.timeout(max_run_seconds):
                documents = _load_documents(conn, doc_ids)
                if not documents:
                    raise ValueError("Run has no resolvable documents to evaluate.")

                total_chars = sum(len(document.text) for document in documents)
                _think(
                    run_id,
                    f"Loaded {len(documents)} document(s) · {total_chars:,} characters. "
                    "Preparing to generate an exam.",
                )

                # Name the run from its documents so History shows a recognizable
                # title (§8). Best-effort: a title failure must never fail the run —
                # the list endpoint falls back to the document names.
                try:
                    title = await generate_title(answerer, documents)
                    if title:
                        conn.execute("UPDATE runs SET title = ? WHERE id = ?", (title, run_id))
                        conn.commit()
                except LLMError:
                    logger.warning("title_generation_failed", extra={"run_id": run_id})

                _enter_phase(conn, run_id, RunStatus.GENERATING_EXAM)
                _think(
                    run_id,
                    "Reading the documents and drafting questions across four types — "
                    "factual, multi-hop, paraphrase, and unanswerable…",
                    phase=RunStatus.GENERATING_EXAM,
                )
                questions = await generate_exam(answerer, run_id, documents, settings.n_questions)
                insert_questions(conn, questions)

                # Stream each drafted question into the transcript, then a one-line
                # summary of the exam's shape (its type mix).
                for idx, question in enumerate(questions, start=1):
                    bus.publish(
                        run_id,
                        RunEvent(
                            type=RunEventType.QUESTION,
                            done=idx,
                            total=len(questions),
                            question=QuestionPayload(
                                idx=idx, qtype=question.qtype, text=question.question
                            ),
                        ),
                    )
                mix = Counter(question.qtype.value for question in questions)
                shape = " · ".join(f"{count} {qtype}" for qtype, count in sorted(mix.items()))
                _think(
                    run_id,
                    f"Exam ready — {len(questions)} questions: {shape}.",
                    phase=RunStatus.GENERATING_EXAM,
                )

                # Resolve the matrix before indexing: the configs decide which
                # chunk sizes must be built (Sandbox picks arbitrary sizes), and
                # only the strategies actually used need retrievers.
                configs = build_config_matrix(run_id, settings.demo_mode, settings.configs)
                chunk_sizes = sorted({config.chunk_size for config in configs})
                strategies = sorted({config.strategy for config in configs})

                _enter_phase(conn, run_id, RunStatus.INDEXING)
                sizes = ", ".join(str(size) for size in chunk_sizes)
                _think(
                    run_id,
                    f"Chunking documents at {sizes} tokens, embedding locally, and "
                    "building the vector and BM25 indexes…",
                    phase=RunStatus.INDEXING,
                )
                for document in documents:
                    await asyncio.to_thread(
                        index_document, conn, document.doc_id, document.text, chunk_sizes, embed
                    )
                placeholders = ",".join("?" for _ in doc_ids)
                chunk_count = conn.execute(
                    f"SELECT COUNT(*) AS c FROM chunks WHERE document_id IN ({placeholders})",
                    list(doc_ids),
                ).fetchone()["c"]
                _think(
                    run_id,
                    f"Indexed {chunk_count} chunks across {len(chunk_sizes)} chunk size(s). "
                    "Vector + BM25 indexes ready.",
                    phase=RunStatus.INDEXING,
                )

                _enter_phase(conn, run_id, RunStatus.ANSWERING)
                insert_configs(conn, configs)
                retrievers = {
                    strategy: make_retriever(strategy, conn, doc_ids, chunk_sizes, embed)
                    for strategy in strategies
                }

                total = len(questions)
                for config in configs:
                    retriever = retrievers[config.strategy]
                    _think(
                        run_id,
                        f"Now evaluating {config.label} — {config.strategy} retrieval, "
                        f"{config.chunk_size}-token chunks, top-k {config.top_k}.",
                        phase=RunStatus.ANSWERING,
                    )
                    for done, question in enumerate(questions, start=1):
                        result = await answer_question(answerer, retriever, question, config)
                        insert_answer(conn, run_id, config.id, question.id, result)
                        # The content event drives the live chat turn; the progress
                        # event (kept) drives the per-config bar and question counter.
                        bus.publish(
                            run_id,
                            RunEvent(
                                type=RunEventType.ANSWER,
                                config_label=config.label,
                                done=done,
                                total=total,
                                answer=AnswerPayload(
                                    idx=done,
                                    qtype=question.qtype,
                                    question=question.question,
                                    text=result.answer_text,
                                    retrieved=len(result.retrieved_chunk_ids),
                                    latency_ms=result.latency_ms,
                                    abstained=result.answer_text.strip() == NOT_IN_DOCUMENTS,
                                ),
                            ),
                        )
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
                        if done < total:
                            _think(
                                run_id,
                                f"Answer captured. Proceeding with Q{done + 1}…",
                                phase=RunStatus.ANSWERING,
                            )
                    bus.publish(
                        run_id,
                        RunEvent(type=RunEventType.CONFIG_DONE, config_label=config.label),
                    )

                _enter_phase(conn, run_id, RunStatus.JUDGING)
                judge_source = "an independent judge" if judge is not answerer else "the judge"
                _think(
                    run_id,
                    f"Grading every answer with {judge_source} on three metrics — "
                    "correctness, faithfulness, and retrieval hit…",
                    phase=RunStatus.JUDGING,
                )
                await judge_answers(conn, judge, run_id, questions)

                _enter_phase(conn, run_id, RunStatus.DONE)
                _think(
                    run_id,
                    f"Evaluation complete — {total * len(configs)} answers graded across "
                    f"{len(configs)} configurations. Opening the report…",
                )
                bus.publish(run_id, RunEvent(type=RunEventType.RUN_DONE))
                logger.info(
                    "run_done",
                    extra={"run_id": run_id, "configs": len(configs), "questions": total},
                )
        except asyncio.CancelledError:
            # A cancel request (POST /runs/{id}/cancel) cancels this task.
            # CancelledError is a BaseException, so it bypasses the `except
            # Exception` below — tear the run down here, then re-raise so the task
            # is properly marked cancelled.
            bus.publish(run_id, RunEvent(type=RunEventType.ERROR, message="Run cancelled."))
            logger.info("run_cancelled", extra={"run_id": run_id})
            try:
                _delete_run(conn, run_id)
            except sqlite3.Error:
                logger.exception("run_cleanup_failed", extra={"run_id": run_id})
            raise
        except TimeoutError:
            minutes = round(max_run_seconds / 60)
            message = f"Run exceeded the {minutes}-minute limit and was cancelled."
            bus.publish(run_id, RunEvent(type=RunEventType.ERROR, message=message))
            logger.warning("run_timed_out", extra={"run_id": run_id})
            try:
                _delete_run(conn, run_id)
            except sqlite3.Error:
                logger.exception("run_cleanup_failed", extra={"run_id": run_id})
        except Exception as exc:
            message = str(exc)
            # Publish the failure first so the live progress page receives the
            # message before the run is torn down, then delete the run — failed
            # runs are not persisted (no history entry, no revisitable report).
            bus.publish(run_id, RunEvent(type=RunEventType.ERROR, message=message))
            logger.exception("run_failed", extra={"run_id": run_id})
            try:
                _delete_run(conn, run_id)
            except sqlite3.Error:
                logger.exception("run_cleanup_failed", extra={"run_id": run_id})
        finally:
            bus.close(run_id)
            if owns_judge:
                await judge.aclose()
            if owns_client:
                await answerer.aclose()

"""Tests for the run orchestrator, event bus, and run routes (§6.7, commit #8).

Groq is mocked with ``respx`` and a deterministic fake embedder stands in for
fastembed, so the full ``generate → index → answer`` pipeline runs offline and
fast. The end-to-end test drives :func:`execute_run` against the bundled fixture
and asserts the persisted matrix, the answer rows, and the emitted SSE events.
"""

import asyncio
import hashlib
import json
from collections.abc import Iterator, Sequence
from pathlib import Path
from typing import NoReturn

import httpx
import pytest
import respx
from app.config import get_settings
from app.core.exam import DEMO_EXAM_SIZE, taxonomy_counts
from app.core.indexing import EMBED_DIM
from app.core.llm_client import LLMClient
from app.core.runner import (
    TOP_K,
    answer_question,
    build_config_matrix,
    build_context,
    execute_run,
    strategies_for,
)
from app.db import connect, init_db
from app.events import EventBus
from app.main import create_app
from app.models import (
    ConfigSummary,
    QType,
    Question,
    RunEvent,
    RunEventType,
    RunSettings,
    RunStatus,
)
from fastapi.testclient import TestClient

from tests.test_exam_parsing import GEN_MODEL, URL, _client, _completion, _make_questions

FIXTURE = Path(__file__).resolve().parents[1] / "fixtures" / "sample_docs" / "meridian-overview.md"


def _fake_embedder(texts: Sequence[str]) -> list[list[float]]:
    """Map each text to a deterministic, distinct 384-dim vector (no model load)."""
    vectors: list[list[float]] = []
    for text in texts:
        digest = hashlib.sha256(text.encode("utf-8")).digest()
        vectors.append([digest[i % len(digest)] / 255.0 for i in range(EMBED_DIM)])
    return vectors


_DEFAULT_ANSWER = "Meridian stores data as collections of JSON documents."


def _answer_response(text: str = _DEFAULT_ANSWER) -> httpx.Response:
    """A plain (non-JSON-mode) chat completion standing in for an answer."""
    return httpx.Response(
        200,
        json={
            "model": GEN_MODEL,
            "choices": [{"message": {"content": text}}],
            "usage": {"prompt_tokens": 12, "completion_tokens": 7, "total_tokens": 19},
        },
    )


# ---------------------------------------------------------------------------
# Config matrix
# ---------------------------------------------------------------------------


def test_config_matrix_full_has_six_configs() -> None:
    configs = build_config_matrix("run1", demo_mode=False)
    assert len(configs) == 6
    assert all(c.top_k == TOP_K for c in configs)
    assert {c.label for c in configs} >= {"400/vector", "800/hybrid", "400/bm25"}


def test_config_matrix_demo_has_two_hybrid_configs() -> None:
    configs = build_config_matrix("run1", demo_mode=True)
    assert len(configs) == 2
    assert all(c.strategy in strategies_for(True) for c in configs)
    # Demo holds strategy fixed at hybrid, varying only chunk size.
    assert {c.strategy for c in configs} == {"hybrid"}
    assert {c.label for c in configs} == {"400/hybrid", "800/hybrid"}


# ---------------------------------------------------------------------------
# Event bus
# ---------------------------------------------------------------------------


async def test_event_bus_fans_out_to_all_subscribers() -> None:
    bus = EventBus()
    q1 = bus.subscribe("run1")
    q2 = bus.subscribe("run1")

    bus.publish("run1", RunEvent(type=RunEventType.PHASE, phase=RunStatus.INDEXING))
    first = await q1.get()
    second = await q2.get()
    assert first is not None and first.phase is RunStatus.INDEXING
    assert second is not None and second.phase is RunStatus.INDEXING

    bus.close("run1")
    assert await q1.get() is None  # end-of-stream sentinel
    assert await q2.get() is None


async def test_event_bus_unsubscribe_stops_delivery() -> None:
    bus = EventBus()
    queue = bus.subscribe("run1")
    bus.unsubscribe("run1", queue)

    bus.publish("run1", RunEvent(type=RunEventType.RUN_DONE))  # reaches nobody
    assert queue.empty()


# ---------------------------------------------------------------------------
# Context + answer generation
# ---------------------------------------------------------------------------


def _chunk(chunk_id: str, text: str):  # type: ignore[no-untyped-def]
    from app.core.retrieval import ScoredChunk

    return ScoredChunk(
        chunk_id=chunk_id,
        document_id="doc1",
        chunk_size=400,
        idx=0,
        text=text,
        start_char=0,
        end_char=len(text),
        score=1.0,
    )


class _StubRetriever:
    """A retriever that returns a fixed chunk list (Retriever-compatible)."""

    def __init__(self, chunks: Sequence[object]) -> None:
        self._chunks = list(chunks)

    def retrieve(self, query: str, chunk_size: int, top_k: int):  # type: ignore[no-untyped-def]
        return self._chunks[:top_k]


def test_build_context_labels_and_includes_chunk_text() -> None:
    context = build_context([_chunk("c1", "alpha text"), _chunk("c2", "beta text")])
    assert "[chunk 1]" in context and "[chunk 2]" in context
    assert "alpha text" in context and "beta text" in context


def _question() -> Question:
    return Question(
        id="q1",
        run_id="run1",
        qtype=QType.FACTUAL,
        question="What does Meridian store?",
        gold_answer="JSON documents",
        gold_spans=[],
        source_doc_id="doc1",
    )


def _config() -> ConfigSummary:
    return ConfigSummary(
        id="cfg1", run_id="run1", chunk_size=400, strategy="vector", top_k=TOP_K, label="400/vector"
    )


@respx.mock
async def test_answer_question_records_retrieval_and_cost() -> None:
    respx.post(URL).mock(return_value=_answer_response("JSON documents."))
    retriever = _StubRetriever([_chunk("c1", "Meridian stores JSON documents."), _chunk("c2", "x")])

    async with _client() as client:
        result = await answer_question(client, retriever, _question(), _config())

    assert result.answer_text == "JSON documents."
    assert result.retrieved_chunk_ids == ["c1", "c2"]
    assert result.prompt_tokens == 12
    assert result.completion_tokens == 7
    assert result.latency_ms >= 0


@respx.mock
async def test_answer_question_preserves_abstention() -> None:
    respx.post(URL).mock(return_value=_answer_response("NOT_IN_DOCUMENTS"))
    retriever = _StubRetriever([_chunk("c1", "unrelated context")])

    async with _client() as client:
        result = await answer_question(client, retriever, _question(), _config())

    assert result.answer_text == "NOT_IN_DOCUMENTS"


# ---------------------------------------------------------------------------
# End-to-end run
# ---------------------------------------------------------------------------


@pytest.fixture
def run_db(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> Iterator[str]:
    """A file-backed database the orchestrator's own connection can reach."""
    db_path = str(tmp_path / "run.db")
    monkeypatch.setenv("GROQ_API_KEY", "test-key")
    monkeypatch.setenv("DATABASE_PATH", db_path)
    get_settings.cache_clear()
    init_db(db_path)
    yield db_path
    get_settings.cache_clear()


def _seed_run(db_path: str) -> None:
    conn = connect(db_path)
    try:
        conn.execute(
            "INSERT INTO documents (id, name, mime, text, char_count, created_at) "
            "VALUES (?, ?, ?, ?, ?, ?)",
            ("doc1", "meridian-overview.md", "text/markdown", FIXTURE.read_text(), 1, "2026-06-13"),
        )
        conn.execute(
            "INSERT INTO runs (id, status, doc_ids, settings, created_at) VALUES (?, ?, ?, ?, ?)",
            ("run1", RunStatus.PENDING.value, json.dumps(["doc1"]), "{}", "2026-06-13T00:00:00Z"),
        )
        conn.commit()
    finally:
        conn.close()


def _groq_handler(request: httpx.Request) -> httpx.Response:
    """Route mocked Groq calls by shape: exam gen, judge verdict, or plain answer.

    Exam generation and the judges both use JSON mode; they are told apart by the
    schema embedded in the prompt (the judge's :class:`JudgeVerdict` carries a
    ``rationale`` field, the exam's :class:`GeneratedExam` does not).
    """
    body = json.loads(request.content)
    if "response_format" not in body:
        return _answer_response()
    prompt = body["messages"][-1]["content"]
    if "rationale" in prompt:
        return _completion({"score": 1, "rationale": "supported", "confidence": "high"})
    return _completion({"questions": _make_questions(taxonomy_counts(DEMO_EXAM_SIZE))})


@respx.mock
async def test_execute_run_completes_and_emits_events(run_db: str) -> None:
    _seed_run(run_db)
    respx.post(URL).mock(side_effect=_groq_handler)

    # Subscribe before the run so progress events are captured live.
    from app.events import bus

    queue = bus.subscribe("run1")
    settings = RunSettings(demo_mode=True, n_questions=DEMO_EXAM_SIZE, top_k=TOP_K)

    async with _client() as client:
        await execute_run("run1", ["doc1"], settings, embed=_fake_embedder, client=client)

    events: list[RunEvent] = []
    while not queue.empty():
        event = queue.get_nowait()
        if event is None:
            break
        events.append(event)
    bus.unsubscribe("run1", queue)

    conn = connect(run_db)
    try:
        status = conn.execute("SELECT status FROM runs WHERE id = 'run1'").fetchone()[0]
        n_configs = conn.execute("SELECT COUNT(*) FROM configs").fetchone()[0]
        n_answers = conn.execute("SELECT COUNT(*) FROM answers").fetchone()[0]
        n_questions = conn.execute("SELECT COUNT(*) FROM questions").fetchone()[0]
        n_grades = conn.execute("SELECT COUNT(*) FROM grades").fetchone()[0]
    finally:
        conn.close()

    assert status == RunStatus.DONE.value
    assert n_configs == 2
    assert n_questions == DEMO_EXAM_SIZE
    assert n_answers == 2 * DEMO_EXAM_SIZE  # every config x question answered
    assert n_grades == n_answers  # and every answer graded

    types = {event.type for event in events}
    assert RunEventType.PHASE in types
    assert RunEventType.PROGRESS in types
    assert RunEventType.RUN_DONE in types
    # Progress reaches the full question count on at least one config.
    assert any(e.type is RunEventType.PROGRESS and e.done == DEMO_EXAM_SIZE for e in events)
    # The judging phase ran (a phase event for it was emitted).
    assert any(e.type is RunEventType.PHASE and e.phase is RunStatus.JUDGING for e in events)


JUDGE_URL = "https://judge.example.test/v1/chat/completions"


@respx.mock
async def test_execute_run_routes_judging_to_independent_judge(run_db: str) -> None:
    """With a judge client bound to a second provider, all grading traffic goes
    there — the model that answers is not the model that grades."""
    _seed_run(run_db)

    def _answerer_handler(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        if "response_format" in body:  # exam generation (JSON mode)
            return _completion({"questions": _make_questions(taxonomy_counts(DEMO_EXAM_SIZE))})
        return _answer_response()

    answer_route = respx.post(URL).mock(side_effect=_answerer_handler)
    judge_route = respx.post(JUDGE_URL).mock(
        return_value=_completion({"score": 1, "rationale": "ok", "confidence": "high"})
    )

    settings = RunSettings(demo_mode=True, n_questions=DEMO_EXAM_SIZE, top_k=TOP_K)
    judge = LLMClient(
        api_key="judge-key",
        generation_model="judge-model",
        fast_model="judge-model",
        base_url="https://judge.example.test/v1",
        jitter=lambda _a, _b: 0.0,
    )
    async with _client() as answerer, judge:
        await execute_run(
            "run1",
            ["doc1"],
            settings,
            embed=_fake_embedder,
            client=answerer,
            judge_client=judge,
        )

    conn = connect(run_db)
    try:
        status = conn.execute("SELECT status FROM runs WHERE id = 'run1'").fetchone()[0]
        n_grades = conn.execute("SELECT COUNT(*) FROM grades").fetchone()[0]
    finally:
        conn.close()

    assert status == RunStatus.DONE.value
    assert n_grades == 2 * DEMO_EXAM_SIZE
    # The judge host actually graded, and the answer host never saw a
    # judge-verdict-shaped request (its traffic is exam gen + answers only;
    # only judge prompts embed the JudgeVerdict schema with its "rationale").
    assert judge_route.called
    assert answer_route.called
    for call in answer_route.calls:
        prompt = json.loads(call.request.content)["messages"][-1]["content"]
        assert "rationale" not in prompt


@respx.mock
async def test_execute_run_deletes_failed_run(run_db: str, monkeypatch: pytest.MonkeyPatch) -> None:
    """A failed run publishes its error, then is removed entirely — no lingering
    error row, and none of its child rows survive."""
    _seed_run(run_db)
    # Title generation makes the only real Groq call before the (patched) failure;
    # a plain completion lets it fail its JSON parse gracefully and fall back.
    respx.post(URL).mock(return_value=_answer_response())

    async def _boom(*args: object, **kwargs: object) -> object:
        raise RuntimeError("exam generation blew up")

    monkeypatch.setattr("app.core.runner.generate_exam", _boom)

    from app.events import bus

    queue = bus.subscribe("run1")
    settings = RunSettings(demo_mode=True, n_questions=DEMO_EXAM_SIZE, top_k=TOP_K)

    async with _client() as client:
        await execute_run("run1", ["doc1"], settings, embed=_fake_embedder, client=client)

    events: list[RunEvent] = []
    while not queue.empty():
        event = queue.get_nowait()
        if event is None:
            break
        events.append(event)
    bus.unsubscribe("run1", queue)

    # The failure surfaced as an error event carrying the message...
    error_events = [e for e in events if e.type is RunEventType.ERROR]
    assert error_events
    assert "exam generation blew up" in (error_events[0].message or "")

    # ...and the run and every child row are gone.
    conn = connect(run_db)
    try:
        assert conn.execute("SELECT COUNT(*) FROM runs WHERE id = 'run1'").fetchone()[0] == 0
        for table in ("questions", "configs", "answers", "grades"):
            assert conn.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0] == 0
    finally:
        conn.close()


def _drain(queue: object) -> list[RunEvent]:
    """Collect buffered events up to the end-of-stream sentinel."""
    events: list[RunEvent] = []
    while not queue.empty():  # type: ignore[attr-defined]
        event = queue.get_nowait()  # type: ignore[attr-defined]
        if event is None:
            break
        events.append(event)
    return events


@respx.mock
async def test_execute_run_cancelled_deletes_run(
    run_db: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Cancelling the run task tears the run down: an error event is published and
    the run (a BaseException CancelledError would otherwise skip cleanup) is gone."""
    _seed_run(run_db)
    respx.post(URL).mock(return_value=_answer_response())

    started = asyncio.Event()

    async def _hang(*args: object, **kwargs: object) -> NoReturn:
        started.set()
        await asyncio.Event().wait()  # blocks until cancelled
        raise AssertionError("unreachable")

    monkeypatch.setattr("app.core.runner.generate_exam", _hang)

    from app.events import bus

    queue = bus.subscribe("run1")
    settings = RunSettings(demo_mode=True, n_questions=DEMO_EXAM_SIZE, top_k=TOP_K)

    async with _client() as client:
        task = asyncio.create_task(
            execute_run("run1", ["doc1"], settings, embed=_fake_embedder, client=client)
        )
        await asyncio.wait_for(started.wait(), timeout=5)
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task

    events = _drain(queue)
    bus.unsubscribe("run1", queue)

    error_events = [e for e in events if e.type is RunEventType.ERROR]
    assert error_events
    assert "cancel" in (error_events[0].message or "").lower()

    conn = connect(run_db)
    try:
        assert conn.execute("SELECT COUNT(*) FROM runs WHERE id = 'run1'").fetchone()[0] == 0
    finally:
        conn.close()


@respx.mock
async def test_execute_run_times_out_deletes_run(
    run_db: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A run that exceeds MAX_RUN_SECONDS self-terminates: it is deleted and an
    error event carrying the limit message is published."""
    _seed_run(run_db)
    respx.post(URL).mock(return_value=_answer_response())
    monkeypatch.setenv("MAX_RUN_SECONDS", "0.3")
    get_settings.cache_clear()

    async def _hang(*args: object, **kwargs: object) -> NoReturn:
        await asyncio.Event().wait()  # never returns; the deadline fires
        raise AssertionError("unreachable")

    monkeypatch.setattr("app.core.runner.generate_exam", _hang)

    from app.events import bus

    queue = bus.subscribe("run1")
    settings = RunSettings(demo_mode=True, n_questions=DEMO_EXAM_SIZE, top_k=TOP_K)

    async with _client() as client:
        await execute_run("run1", ["doc1"], settings, embed=_fake_embedder, client=client)

    events = _drain(queue)
    bus.unsubscribe("run1", queue)

    error_events = [e for e in events if e.type is RunEventType.ERROR]
    assert error_events
    assert "limit" in (error_events[0].message or "").lower()

    conn = connect(run_db)
    try:
        assert conn.execute("SELECT COUNT(*) FROM runs WHERE id = 'run1'").fetchone()[0] == 0
    finally:
        conn.close()


# ---------------------------------------------------------------------------
# Routes
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


def test_create_run_returns_backend_resolved_counts(
    api: tuple[TestClient, str], monkeypatch: pytest.MonkeyPatch
) -> None:
    """The response carries n_questions/n_configs — the UI's single source of truth."""

    async def _noop_run(*args: object, **kwargs: object) -> None:
        return None

    monkeypatch.setattr("app.routes.runs.execute_run", _noop_run)
    client, db_path = api
    conn = connect(db_path)
    try:
        conn.execute(
            "INSERT INTO documents (id, name, mime, text, char_count, created_at) "
            "VALUES ('doc1', 'd.md', 'text/markdown', 'hello', 5, '2026-06-13')"
        )
        conn.commit()
    finally:
        conn.close()

    resp = client.post("/api/runs", json={"doc_ids": ["doc1"], "demo_mode": True})
    assert resp.status_code == 201
    body = resp.json()
    assert body["n_questions"] == DEMO_EXAM_SIZE
    assert body["n_configs"] == 2  # two chunk sizes x the demo strategy set


def test_create_run_rejects_empty_doc_ids(api: tuple[TestClient, str]) -> None:
    client, _ = api
    assert client.post("/api/runs", json={"doc_ids": []}).status_code == 422


def test_create_run_rejects_unknown_document(api: tuple[TestClient, str]) -> None:
    client, _ = api
    resp = client.post("/api/runs", json={"doc_ids": ["nope"]})
    assert resp.status_code == 404


def test_get_run_unknown_returns_404(api: tuple[TestClient, str]) -> None:
    client, _ = api
    assert client.get("/api/runs/missing").status_code == 404


def test_events_endpoint_replays_terminal_status(api: tuple[TestClient, str]) -> None:
    client, db_path = api
    conn = connect(db_path)
    try:
        conn.execute(
            "INSERT INTO runs (id, status, doc_ids, settings, created_at) VALUES (?, ?, ?, ?, ?)",
            ("done1", RunStatus.DONE.value, "[]", "{}", "2026-06-13T00:00:00Z"),
        )
        conn.commit()
    finally:
        conn.close()

    resp = client.get("/api/runs/done1/events")
    assert resp.status_code == 200
    assert resp.headers["content-type"].startswith("text/event-stream")
    assert "run_done" in resp.text


def test_events_endpoint_unknown_run_returns_404(api: tuple[TestClient, str]) -> None:
    client, _ = api
    assert client.get("/api/runs/missing/events").status_code == 404


def test_cancel_run_unknown_returns_404(api: tuple[TestClient, str]) -> None:
    client, _ = api
    assert client.post("/api/runs/missing/cancel").status_code == 404


def test_cancel_run_orphan_deletes_row(api: tuple[TestClient, str]) -> None:
    """A stuck in-flight row with no live task (e.g. after a restart) is deleted
    by the cancel endpoint so it leaves the progress screen and history."""
    client, db_path = api
    conn = connect(db_path)
    try:
        conn.execute(
            "INSERT INTO runs (id, status, doc_ids, settings, created_at) VALUES (?, ?, ?, ?, ?)",
            ("orphan1", RunStatus.ANSWERING.value, "[]", "{}", "2026-06-13T00:00:00Z"),
        )
        conn.commit()
    finally:
        conn.close()

    resp = client.post("/api/runs/orphan1/cancel")
    assert resp.status_code == 202

    conn = connect(db_path)
    try:
        assert conn.execute("SELECT COUNT(*) FROM runs WHERE id = 'orphan1'").fetchone()[0] == 0
    finally:
        conn.close()


def test_cancel_run_after_completion_does_not_delete(api: tuple[TestClient, str]) -> None:
    """A cancel request that loses the race to a just-finished run must not nuke it.

    By the time cancel arrives the task is already gone from the in-flight table
    (its done-callback popped it), so the endpoint falls into the "orphan" path.
    If that path deletes unconditionally, a client racing the `run_done` event
    with a cancel click destroys a successful run out from under itself.
    """
    client, db_path = api
    conn = connect(db_path)
    try:
        conn.execute(
            "INSERT INTO runs (id, status, doc_ids, settings, created_at) VALUES (?, ?, ?, ?, ?)",
            ("done1", RunStatus.DONE.value, "[]", "{}", "2026-06-13T00:00:00Z"),
        )
        conn.commit()
    finally:
        conn.close()

    client.post("/api/runs/done1/cancel")

    conn = connect(db_path)
    try:
        assert conn.execute("SELECT COUNT(*) FROM runs WHERE id = 'done1'").fetchone()[0] == 1
    finally:
        conn.close()


def test_list_runs_returns_only_completed(api: tuple[TestClient, str]) -> None:
    """History lists only ``done`` runs — in-flight, error, and pending are hidden."""
    client, db_path = api
    settings = '{"demo_mode": true, "n_questions": 12, "top_k": 5}'
    insert = "INSERT INTO runs (id, status, doc_ids, settings, created_at) VALUES (?, ?, ?, ?, ?)"
    conn = connect(db_path)
    try:
        for run_id, status in (
            ("done1", RunStatus.DONE.value),
            ("answering1", RunStatus.ANSWERING.value),
            ("error1", RunStatus.ERROR.value),
            ("pending1", RunStatus.PENDING.value),
        ):
            conn.execute(insert, (run_id, status, "[]", settings, "2026-06-13T00:00:00Z"))
        conn.commit()
    finally:
        conn.close()

    resp = client.get("/api/runs")
    assert resp.status_code == 200
    assert [row["id"] for row in resp.json()] == ["done1"]

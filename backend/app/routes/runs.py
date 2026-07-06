"""Run routes: create a run, poll its status, and stream live progress (§7).

``POST /api/runs`` validates the requested documents, persists a pending run, and
spawns the orchestrator (:func:`app.core.runner.execute_run`) as a background
task. ``GET /api/runs/{id}`` returns a status snapshot. ``GET /api/runs/{id}/events``
is a Server-Sent Events stream: it first replays the run's current status (so a
reconnecting client catches up immediately), then forwards live events from the
in-memory bus until the run finishes.
"""

from __future__ import annotations

import asyncio
import json
import logging
import sqlite3
import uuid
from collections.abc import AsyncIterator
from datetime import UTC, datetime
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Response
from fastapi.responses import StreamingResponse

from app.config import get_settings
from app.core.chunking import CHUNK_SIZES
from app.core.exam import exam_size
from app.core.runner import TOP_K, _delete_run, execute_run, strategies_for
from app.db import get_connection
from app.events import bus
from app.models import (
    RunCreate,
    RunCreated,
    RunEvent,
    RunEventType,
    RunSettings,
    RunStatus,
    RunStatusResponse,
    RunSummary,
)

logger = logging.getLogger("ragprobe")

router = APIRouter(tags=["runs"])

# Statuses past which no further events will be published (§6.7).
_TERMINAL = (RunStatus.DONE, RunStatus.ERROR)

# Seconds of stream silence before an SSE comment frame is sent. Long quiet
# phases (indexing, throttled answering) otherwise emit nothing for minutes,
# and reverse proxies in real deployments buffer or kill idle streams.
_HEARTBEAT_SECONDS = 15.0

# In-flight run tasks keyed by run id. This both keeps a strong reference so the
# event loop does not garbage collect a task mid-run (a done-callback drops each
# when it completes) and lets the cancel endpoint reach a running task.
_run_tasks: dict[str, asyncio.Task[None]] = {}


def _spawn_run(run_id: str, doc_ids: list[str], settings: RunSettings) -> None:
    """Launch the orchestrator as a tracked background task."""
    task = asyncio.create_task(execute_run(run_id, doc_ids, settings))
    _run_tasks[run_id] = task
    task.add_done_callback(lambda _t: _run_tasks.pop(run_id, None))


@router.post("/runs", response_model=RunCreated, status_code=201)
async def create_run(
    body: RunCreate,
    conn: Annotated[sqlite3.Connection, Depends(get_connection)],
) -> RunCreated:
    """Create a run over the given documents and start it in the background."""
    if not body.doc_ids:
        raise HTTPException(status_code=422, detail="At least one document is required.")

    placeholders = ",".join("?" for _ in body.doc_ids)
    found = {
        row["id"]
        for row in conn.execute(
            f"SELECT id FROM documents WHERE id IN ({placeholders})", body.doc_ids
        ).fetchall()
    }
    missing = [doc_id for doc_id in body.doc_ids if doc_id not in found]
    if missing:
        raise HTTPException(status_code=404, detail=f"Unknown document id(s): {', '.join(missing)}")

    app_settings = get_settings()
    demo_mode = body.demo_mode if body.demo_mode is not None else app_settings.demo_mode
    settings = RunSettings(
        demo_mode=demo_mode,
        n_questions=exam_size(demo_mode),
        top_k=TOP_K,
        answer_model=app_settings.groq_generation_model,
        # Which model will grade: the independent Gemini judge when its key is
        # configured, otherwise the answerer grades itself (recorded honestly).
        judge_model=(
            app_settings.gemini_judge_model
            if app_settings.gemini_api_key
            else app_settings.groq_generation_model
        ),
    )

    run_id = uuid.uuid4().hex
    conn.execute(
        "INSERT INTO runs (id, status, doc_ids, settings, created_at) VALUES (?, ?, ?, ?, ?)",
        (
            run_id,
            RunStatus.PENDING.value,
            json.dumps(body.doc_ids),
            settings.model_dump_json(),
            datetime.now(UTC).isoformat(),
        ),
    )
    conn.commit()

    _spawn_run(run_id, body.doc_ids, settings)
    logger.info("run_created", extra={"run_id": run_id, "demo_mode": demo_mode})
    return RunCreated(
        run_id=run_id,
        n_questions=settings.n_questions,
        n_configs=len(CHUNK_SIZES) * len(strategies_for(demo_mode)),
    )


def _row_to_summary(row: sqlite3.Row, name_by_id: dict[str, str]) -> RunSummary:
    """Map a runs row to a history-list summary, resolving its document names.

    ``title`` falls back to the joined document names (then a generic label) when
    the AI title hasn't landed yet or generation failed, so a card is never blank.
    """
    settings = RunSettings.model_validate_json(row["settings"])
    doc_ids = json.loads(row["doc_ids"])
    names = [name_by_id[doc_id] for doc_id in doc_ids if doc_id in name_by_id]
    title = row["title"] or ", ".join(names) or "Untitled evaluation"
    return RunSummary(
        id=row["id"],
        status=RunStatus(row["status"]),
        created_at=row["created_at"],
        error=row["error"],
        title=title,
        document_names=names,
        demo_mode=settings.demo_mode,
        n_documents=len(doc_ids),
        n_questions=settings.n_questions,
        n_configs=len(CHUNK_SIZES) * len(strategies_for(settings.demo_mode)),
    )


@router.get("/runs", response_model=list[RunSummary])
async def list_runs(
    conn: Annotated[sqlite3.Connection, Depends(get_connection)],
) -> list[RunSummary]:
    """List completed runs for the history screen, newest first.

    Only ``done`` runs are surfaced: in-flight, errored, and process-killed
    "stuck" runs are never valid history entries (failed runs are deleted
    outright by the orchestrator; a killed process leaves an in-flight row that
    should not clutter the list).
    """
    rows = conn.execute(
        "SELECT id, status, error, created_at, doc_ids, settings, title FROM runs "
        "WHERE status = ? ORDER BY created_at DESC",
        (RunStatus.DONE.value,),
    ).fetchall()
    # Resolve every run's document names for the source chips in one query (§8).
    all_ids = {doc_id for row in rows for doc_id in json.loads(row["doc_ids"])}
    name_by_id: dict[str, str] = {}
    if all_ids:
        placeholders = ",".join("?" for _ in all_ids)
        name_by_id = {
            doc["id"]: doc["name"]
            for doc in conn.execute(
                f"SELECT id, name FROM documents WHERE id IN ({placeholders})",
                list(all_ids),
            ).fetchall()
        }
    return [_row_to_summary(row, name_by_id) for row in rows]


def _row_to_status(row: sqlite3.Row) -> RunStatusResponse:
    return RunStatusResponse(
        id=row["id"],
        status=RunStatus(row["status"]),
        error=row["error"],
        created_at=row["created_at"],
    )


@router.get("/runs/{run_id}", response_model=RunStatusResponse)
async def get_run(
    run_id: str,
    conn: Annotated[sqlite3.Connection, Depends(get_connection)],
) -> RunStatusResponse:
    """Return a status snapshot for one run."""
    row = conn.execute(
        "SELECT id, status, error, created_at FROM runs WHERE id = ?", (run_id,)
    ).fetchone()
    if row is None:
        raise HTTPException(status_code=404, detail=f"Run {run_id} not found.")
    return _row_to_status(row)


@router.post("/runs/{run_id}/cancel", status_code=202)
async def cancel_run(
    run_id: str,
    conn: Annotated[sqlite3.Connection, Depends(get_connection)],
) -> Response:
    """Cancel an in-flight run, tearing it down like a failure (the run is deleted).

    If the run's task is still live, cancel it and let the orchestrator's own
    ``CancelledError`` handler delete the row and publish the terminal event — this
    avoids racing the runner's own database connection. If no live task exists,
    the run finished (successfully, by failure, or by timeout) between the
    client's last snapshot and this request racing it — its done-callback already
    popped the task. A terminal ``done`` row is left alone (the run is real and
    kept); anything else is an orphaned/stuck row (e.g. left by a restarted
    process) and is deleted.
    """
    task = _run_tasks.get(run_id)
    if task is not None:
        task.cancel()
        logger.info("run_cancel_requested", extra={"run_id": run_id})
        return Response(status_code=202)

    row = conn.execute("SELECT status FROM runs WHERE id = ?", (run_id,)).fetchone()
    if row is None:
        raise HTTPException(status_code=404, detail=f"Run {run_id} not found.")
    if RunStatus(row["status"]) is RunStatus.DONE:
        # Lost the race to a run that already finished successfully — leave it.
        logger.info("run_cancel_too_late", extra={"run_id": run_id})
        return Response(status_code=202)
    # Orphaned/stuck run: no task will ever publish for it. End any attached SSE
    # stream and delete the row so it leaves the progress screen and history.
    bus.publish(run_id, RunEvent(type=RunEventType.ERROR, message="Run cancelled."))
    bus.close(run_id)
    _delete_run(conn, run_id)
    logger.info("run_cancelled_orphan", extra={"run_id": run_id})
    return Response(status_code=202)


def _replay_event(status: RunStatus, error: str | None) -> RunEvent:
    """The single catch-up event describing a run's current status to a (re)connection."""
    if status is RunStatus.DONE:
        return RunEvent(type=RunEventType.RUN_DONE)
    if status is RunStatus.ERROR:
        return RunEvent(type=RunEventType.ERROR, message=error)
    return RunEvent(type=RunEventType.PHASE, phase=status)


def _sse(event: RunEvent) -> str:
    """Format a run event as an SSE ``data:`` frame."""
    return f"data: {event.model_dump_json()}\n\n"


@router.get("/runs/{run_id}/events")
async def stream_events(
    run_id: str,
    conn: Annotated[sqlite3.Connection, Depends(get_connection)],
) -> StreamingResponse:
    """Stream a run's progress as Server-Sent Events, replaying current status first."""
    row = conn.execute("SELECT status, error FROM runs WHERE id = ?", (run_id,)).fetchone()
    if row is None:
        raise HTTPException(status_code=404, detail=f"Run {run_id} not found.")
    status = RunStatus(row["status"])
    error = row["error"]

    async def event_stream() -> AsyncIterator[str]:
        # Replay where the run currently stands so a fresh/reconnecting client
        # is immediately oriented, then forward live events.
        yield _sse(_replay_event(status, error))
        if status in _TERMINAL:
            return

        queue = bus.subscribe(run_id)
        try:
            while True:
                try:
                    event = await asyncio.wait_for(queue.get(), timeout=_HEARTBEAT_SECONDS)
                except TimeoutError:
                    # SSE comment frame: ignored by EventSource, but keeps the
                    # connection visibly alive through proxies.
                    yield ": keepalive\n\n"
                    continue
                if event is None:  # end-of-stream sentinel
                    return
                yield _sse(event)
        finally:
            bus.unsubscribe(run_id, queue)

    return StreamingResponse(event_stream(), media_type="text/event-stream")

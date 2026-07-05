"""SQLite connection management and schema migrations.

The whole application persists to a single SQLite file (path from settings).
Schema changes are applied as ordered, idempotent SQL migrations tracked via
SQLite's ``PRAGMA user_version`` — no migration framework, just plain SQL as
called for in the build plan (§5).

This commit introduces the ``documents`` table. Later commits append migrations
(chunks, runs, questions, ...) and wire in the ``sqlite-vec`` virtual table for
vector search; new migrations are added to ``_MIGRATIONS`` and never edited in
place, so existing databases upgrade cleanly.
"""

from __future__ import annotations

import sqlite3
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path

import sqlite_vec

from app.config import get_settings

# Ordered schema migrations. The list index (1-based) is the schema version
# stored in ``PRAGMA user_version``; only migrations newer than the current
# version are applied. Append new migrations — never reorder or rewrite.
_MIGRATIONS: tuple[str, ...] = (
    """
    CREATE TABLE documents (
        id         TEXT PRIMARY KEY,
        name       TEXT NOT NULL,
        mime       TEXT NOT NULL,
        text       TEXT NOT NULL,
        char_count INTEGER NOT NULL,
        created_at TEXT NOT NULL
    );
    """,
    # Chunks are per (document, chunk_size); offsets index into documents.text.
    # vec_chunks is a sqlite-vec virtual table holding one 384-dim embedding per
    # chunk, keyed by chunk id so vectors join straight back to chunk rows.
    """
    CREATE TABLE chunks (
        id          TEXT PRIMARY KEY,
        document_id TEXT NOT NULL REFERENCES documents(id),
        chunk_size  INTEGER NOT NULL,
        idx         INTEGER NOT NULL,
        text        TEXT NOT NULL,
        start_char  INTEGER NOT NULL,
        end_char    INTEGER NOT NULL
    );
    CREATE INDEX idx_chunks_doc_size ON chunks(document_id, chunk_size);

    CREATE VIRTUAL TABLE vec_chunks USING vec0(
        chunk_id  TEXT PRIMARY KEY,
        embedding float[384]
    );
    """,
    # A run owns a generated exam (questions) and, in later commits, its config
    # matrix, answers, and grades. The runs table is created here — ahead of the
    # runner commit that fills its lifecycle — so questions.run_id references a
    # real parent and the foreign key is enforceable (a dangling FK errors on
    # insert under PRAGMA foreign_keys = ON). gold_spans is a JSON array of
    # {doc_id, start_char, end_char}; empty for unanswerable questions.
    """
    CREATE TABLE runs (
        id         TEXT PRIMARY KEY,
        status     TEXT NOT NULL,
        doc_ids    TEXT NOT NULL,
        settings   TEXT NOT NULL,
        error      TEXT,
        created_at TEXT NOT NULL
    );

    CREATE TABLE questions (
        id            TEXT PRIMARY KEY,
        run_id        TEXT NOT NULL REFERENCES runs(id),
        qtype         TEXT NOT NULL,
        question      TEXT NOT NULL,
        gold_answer   TEXT NOT NULL,
        gold_spans    TEXT NOT NULL,
        source_doc_id TEXT
    );
    CREATE INDEX idx_questions_run ON questions(run_id);
    """,
    # The run orchestrator (§6.7) materializes a config matrix (chunk_size x
    # strategy) and, for every config x question, records the generated answer
    # with the chunks it retrieved and its latency/token cost. Grades land on a
    # separate table in the judging commit; retrieved_chunk_ids is a JSON array.
    """
    CREATE TABLE configs (
        id         TEXT PRIMARY KEY,
        run_id     TEXT NOT NULL REFERENCES runs(id),
        chunk_size INTEGER NOT NULL,
        strategy   TEXT NOT NULL,
        top_k      INTEGER NOT NULL,
        label      TEXT NOT NULL
    );
    CREATE INDEX idx_configs_run ON configs(run_id);

    CREATE TABLE answers (
        id                  TEXT PRIMARY KEY,
        run_id              TEXT NOT NULL REFERENCES runs(id),
        config_id           TEXT NOT NULL REFERENCES configs(id),
        question_id         TEXT NOT NULL REFERENCES questions(id),
        answer_text         TEXT NOT NULL,
        retrieved_chunk_ids TEXT NOT NULL,
        latency_ms          INTEGER NOT NULL,
        prompt_tokens       INTEGER NOT NULL,
        completion_tokens   INTEGER NOT NULL
    );
    CREATE INDEX idx_answers_run ON answers(run_id);
    CREATE INDEX idx_answers_config ON answers(config_id);
    """,
    # The judge (§6.5) grades every answer on three independent 0|0.5|1 metrics:
    # correctness and faithfulness (LLM-judged) and retrieval_hit (pure
    # span-overlap math). retrieval_hit is NULL for unanswerable questions, which
    # are excluded from that metric. Each grade keeps the judge's rationale and
    # confidence and an overridden flag the report UI can flip via PATCH — the
    # composite is computed on read, so an override re-aggregates automatically.
    """
    CREATE TABLE grades (
        id               TEXT PRIMARY KEY,
        answer_id        TEXT NOT NULL REFERENCES answers(id),
        correctness      REAL NOT NULL,
        faithfulness     REAL NOT NULL,
        retrieval_hit    REAL,
        judge_rationale  TEXT NOT NULL,
        judge_confidence TEXT NOT NULL,
        overridden       INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX idx_grades_answer ON grades(answer_id);
    """,
    # Judge cost accountability: record what each grade cost to produce, so a
    # run's total LLM spend is reconstructible (answers carry their own token
    # counts already). Deterministic verdicts (abstentions) cost zero.
    """
    ALTER TABLE grades ADD COLUMN judge_prompt_tokens INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE grades ADD COLUMN judge_completion_tokens INTEGER NOT NULL DEFAULT 0;
    """,
    # A short, AI-generated title so the History screen shows a recognizable name
    # instead of a bare timestamp (§8). Nullable: the orchestrator fills it early in
    # the run; existing rows and any generation failure fall back to the document
    # names, resolved by the runs list endpoint.
    """
    ALTER TABLE runs ADD COLUMN title TEXT;
    """,
)


def connect(database_path: str | None = None) -> sqlite3.Connection:
    """Open a configured SQLite connection.

    Rows come back as :class:`sqlite3.Row` (mapping-style access) and foreign
    keys are enforced. ``check_same_thread=False`` lets FastAPI hand a
    connection to the threadpool worker running a sync dependency.
    """
    path = database_path if database_path is not None else get_settings().database_path
    if path != ":memory:":
        Path(path).parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(path, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    # WAL lets report reads proceed while the run orchestrator writes, and the
    # explicit busy timeout turns residual lock contention into a short wait
    # instead of an SQLITE_BUSY error surfacing as a 500 mid-run. (Both are
    # harmless no-ops for :memory: databases.)
    conn.execute("PRAGMA busy_timeout = 5000")
    conn.execute("PRAGMA journal_mode = WAL")
    # Load sqlite-vec on every connection so the vec_chunks virtual table is
    # available for both migrations and queries.
    conn.enable_load_extension(True)
    sqlite_vec.load(conn)
    conn.enable_load_extension(False)
    return conn


def run_migrations(conn: sqlite3.Connection) -> None:
    """Apply any migrations newer than the connection's schema version.

    Each migration runs atomically: its statements and the ``user_version``
    bump are wrapped in one transaction, so a mid-script failure rolls back
    completely and the migration can simply be retried on the next startup
    (instead of wedging the database with half-created tables).
    """
    current = int(conn.execute("PRAGMA user_version").fetchone()[0])
    for version, migration in enumerate(_MIGRATIONS, start=1):
        if version > current:
            try:
                # user_version does not accept bound parameters; the value is
                # a trusted loop index, not user input.
                conn.executescript(f"BEGIN;{migration};PRAGMA user_version = {version};COMMIT;")
            except sqlite3.Error:
                conn.rollback()
                raise


def init_db(database_path: str | None = None) -> None:
    """Create the database file (if needed) and bring its schema up to date."""
    conn = connect(database_path)
    try:
        run_migrations(conn)
    finally:
        conn.close()


@contextmanager
def get_db() -> Iterator[sqlite3.Connection]:
    """Context manager yielding a connection, closed on exit.

    Used outside the request cycle (startup, background tasks, tests).
    """
    conn = connect()
    try:
        yield conn
    finally:
        conn.close()


def get_connection() -> Iterator[sqlite3.Connection]:
    """FastAPI dependency: a per-request connection, closed when the request ends."""
    with get_db() as conn:
        yield conn

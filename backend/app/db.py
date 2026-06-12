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
    return conn


def run_migrations(conn: sqlite3.Connection) -> None:
    """Apply any migrations newer than the connection's schema version."""
    current = int(conn.execute("PRAGMA user_version").fetchone()[0])
    for version, migration in enumerate(_MIGRATIONS, start=1):
        if version > current:
            conn.executescript(migration)
            # user_version does not accept bound parameters; the value is a
            # trusted loop index, not user input.
            conn.execute(f"PRAGMA user_version = {version}")
    conn.commit()


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

"""Tests for migration atomicity.

Regression for the wedge scenario: if a multi-statement migration fails midway
(e.g. the sqlite-vec extension is unavailable when CREATE VIRTUAL TABLE runs),
the whole migration must roll back — tables and ``user_version`` together — so
the next startup can simply retry instead of dying on ``table already exists``.
"""

import sqlite3

import pytest
import sqlite_vec
from app.db import run_migrations


def _table_names(conn: sqlite3.Connection) -> set[str]:
    rows = conn.execute("SELECT name FROM sqlite_master WHERE type = 'table'").fetchall()
    return {row[0] for row in rows}


def test_failed_migration_rolls_back_and_is_retryable() -> None:
    # A raw connection WITHOUT sqlite-vec loaded: migration #1 (documents)
    # succeeds, migration #2 fails at CREATE VIRTUAL TABLE ... USING vec0.
    conn = sqlite3.connect(":memory:")

    with pytest.raises(sqlite3.Error):
        run_migrations(conn)

    # Migration #1 landed; the failed #2 rolled back completely.
    assert conn.execute("PRAGMA user_version").fetchone()[0] == 1
    tables = _table_names(conn)
    assert "documents" in tables
    assert "chunks" not in tables  # no half-applied migration left behind

    # Once the failure cause is fixed (extension available), a plain retry works.
    conn.enable_load_extension(True)
    sqlite_vec.load(conn)
    conn.enable_load_extension(False)
    run_migrations(conn)

    assert conn.execute("PRAGMA user_version").fetchone()[0] == 2
    assert {"documents", "chunks", "vec_chunks"} <= _table_names(conn)

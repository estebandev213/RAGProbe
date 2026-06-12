"""Document routes: upload and list.

``POST /api/documents`` accepts a single pdf/md/txt file, extracts and
normalizes its text (:mod:`app.core.ingestion`), and persists it. Unsupported
or unreadable files return HTTP 422; oversized files return 413.
"""

from __future__ import annotations

import logging
import sqlite3
import uuid
from datetime import UTC, datetime
from typing import Annotated

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile

from app.core.ingestion import UnsupportedDocumentError, extract_text
from app.db import get_connection
from app.models import DocumentSummary

logger = logging.getLogger("ragprobe")

router = APIRouter(tags=["documents"])

# Per-file upload cap, mirrored by the frontend (§8: ≤2MB each).
MAX_FILE_BYTES = 2 * 1024 * 1024


def _row_to_summary(row: sqlite3.Row) -> DocumentSummary:
    return DocumentSummary(
        id=row["id"],
        name=row["name"],
        mime=row["mime"],
        char_count=row["char_count"],
        created_at=row["created_at"],
    )


@router.post("/documents", response_model=DocumentSummary, status_code=201)
async def upload_document(
    file: Annotated[UploadFile, File()],
    conn: Annotated[sqlite3.Connection, Depends(get_connection)],
) -> DocumentSummary:
    """Upload one document; extract, normalize, and store its text."""
    filename = file.filename or "upload"
    data = await file.read()

    if len(data) > MAX_FILE_BYTES:
        raise HTTPException(
            status_code=413,
            detail=f"File exceeds the {MAX_FILE_BYTES // (1024 * 1024)}MB limit.",
        )

    try:
        text, mime = extract_text(filename, data)
    except UnsupportedDocumentError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc

    summary = DocumentSummary(
        id=uuid.uuid4().hex,
        name=filename,
        mime=mime,
        char_count=len(text),
        created_at=datetime.now(UTC).isoformat(),
    )
    conn.execute(
        "INSERT INTO documents (id, name, mime, text, char_count, created_at) "
        "VALUES (?, ?, ?, ?, ?, ?)",
        (summary.id, summary.name, summary.mime, text, summary.char_count, summary.created_at),
    )
    conn.commit()

    logger.info(
        "document_uploaded",
        extra={"document_id": summary.id, "mime": mime, "char_count": summary.char_count},
    )
    return summary


@router.get("/documents", response_model=list[DocumentSummary])
async def list_documents(
    conn: Annotated[sqlite3.Connection, Depends(get_connection)],
) -> list[DocumentSummary]:
    """List stored documents, newest first."""
    rows = conn.execute(
        "SELECT id, name, mime, char_count, created_at FROM documents ORDER BY created_at DESC"
    ).fetchall()
    return [_row_to_summary(row) for row in rows]

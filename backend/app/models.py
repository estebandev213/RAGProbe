"""Pydantic schemas shared across API boundaries.

Domain-specific models (documents, runs, questions, grades, ...) are added in
later commits; this module starts with the cross-cutting health and error
envelopes referenced by the API contract (§7).
"""

from __future__ import annotations

from pydantic import BaseModel


class HealthResponse(BaseModel):
    """Response body for ``GET /api/health``."""

    ok: bool
    version: str


class ErrorResponse(BaseModel):
    """Uniform error envelope: ``{detail, code}`` with a proper status code."""

    detail: str
    code: str

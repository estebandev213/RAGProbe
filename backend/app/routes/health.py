"""Health check route."""

from __future__ import annotations

from fastapi import APIRouter

from app.config import get_settings
from app.models import HealthResponse

router = APIRouter(tags=["health"])


@router.get("/health", response_model=HealthResponse)
async def health() -> HealthResponse:
    """Liveness probe: reports service readiness and version."""
    settings = get_settings()
    return HealthResponse(ok=True, version=settings.version)

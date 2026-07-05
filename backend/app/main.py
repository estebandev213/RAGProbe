"""FastAPI application factory.

Wires together configuration (fail-fast), structured logging, CORS for the
local frontend dev server, a uniform error envelope, and the health route.
When a built SPA is present (``Settings.static_dir``, the Docker image), the
app also serves it — one container, one port.
"""

from __future__ import annotations

import logging
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from starlette.exceptions import HTTPException as StarletteHTTPException

from app.config import get_settings
from app.db import init_db
from app.logging_config import configure_logging
from app.models import ErrorResponse
from app.routes import documents, health, reports, runs

logger = logging.getLogger("ragprobe")

# Origins allowed during local development (Vite dev server).
_DEV_ORIGINS: tuple[str, ...] = (
    "http://localhost:5173",
    "http://127.0.0.1:5173",
)


def _error_response(status_code: int, detail: str, code: str) -> JSONResponse:
    return JSONResponse(
        status_code=status_code,
        content=ErrorResponse(detail=detail, code=code).model_dump(),
    )


async def _validation_exception_handler(request: Request, exc: Exception) -> JSONResponse:
    detail = "Request validation failed"
    if isinstance(exc, RequestValidationError):
        parts = [
            f"{'.'.join(str(loc) for loc in err['loc'])}: {err['msg']}" for err in exc.errors()
        ]
        if parts:
            detail = "; ".join(parts)
    return _error_response(422, detail, "validation_error")


async def _http_exception_handler(request: Request, exc: Exception) -> JSONResponse:
    if isinstance(exc, StarletteHTTPException):
        return _error_response(exc.status_code, str(exc.detail), "http_error")
    return await _unhandled_exception_handler(request, exc)


async def _unhandled_exception_handler(request: Request, exc: Exception) -> JSONResponse:
    logger.exception("unhandled_exception", extra={"path": request.url.path})
    return _error_response(500, "Internal server error", "internal_error")


def _register_exception_handlers(app: FastAPI) -> None:
    app.add_exception_handler(RequestValidationError, _validation_exception_handler)
    app.add_exception_handler(StarletteHTTPException, _http_exception_handler)
    app.add_exception_handler(Exception, _unhandled_exception_handler)


def _mount_spa(app: FastAPI, static_dir: str) -> None:
    """Serve the built SPA when its dist directory exists (production image).

    Fingerprinted assets are mounted directly; every other non-API path falls
    back to ``index.html`` so client-side routes (``/runs/{id}/report``) survive
    a full page load. Registered *after* the API routers, so ``/api/*`` always
    wins. A no-op in development, where Vite serves the frontend.
    """
    dist = Path(static_dir).resolve()
    index = dist / "index.html"
    if not index.is_file():
        logger.info("spa_not_mounted", extra={"static_dir": static_dir})
        return

    assets = dist / "assets"
    if assets.is_dir():
        app.mount("/assets", StaticFiles(directory=assets), name="assets")

    @app.get("/{full_path:path}", include_in_schema=False)
    async def spa(full_path: str) -> FileResponse:
        # Real files at the dist root (samples/, favicon, manifest) are served
        # as-is; anything else is a client-side route and gets the shell. The
        # resolve() + containment check rejects path traversal.
        candidate = (dist / full_path).resolve()
        if full_path and candidate.is_file() and candidate.is_relative_to(dist):
            return FileResponse(candidate)
        return FileResponse(index)

    logger.info("spa_mounted", extra={"static_dir": str(dist)})


def create_app() -> FastAPI:
    """Build and configure the FastAPI application."""
    configure_logging()
    settings = get_settings()  # fail-fast: raises ConfigError if GROQ_API_KEY is unset
    init_db()  # create the SQLite file and bring its schema up to date

    app = FastAPI(title="RAGProbe", version=settings.version)

    app.add_middleware(
        CORSMiddleware,
        allow_origins=list(_DEV_ORIGINS),
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    _register_exception_handlers(app)
    app.include_router(health.router, prefix="/api")
    app.include_router(documents.router, prefix="/api")
    app.include_router(runs.router, prefix="/api")
    app.include_router(reports.router, prefix="/api")
    _mount_spa(app, settings.static_dir)

    logger.info(
        "app_initialized",
        extra={"version": settings.version, "demo_mode": settings.demo_mode},
    )
    return app


app = create_app()

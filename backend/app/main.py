"""FastAPI application factory.

Wires together configuration (fail-fast), structured logging, CORS for the
local frontend dev server, a uniform error envelope, and the health route.
Static serving of the built SPA is added with the Docker build (commit 13).
"""

from __future__ import annotations

import logging

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException

from app.config import get_settings
from app.logging_config import configure_logging
from app.models import ErrorResponse
from app.routes import health

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


def create_app() -> FastAPI:
    """Build and configure the FastAPI application."""
    configure_logging()
    settings = get_settings()  # fail-fast: raises ConfigError if GROQ_API_KEY is unset

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

    logger.info(
        "app_initialized",
        extra={"version": settings.version, "demo_mode": settings.demo_mode},
    )
    return app


app = create_app()

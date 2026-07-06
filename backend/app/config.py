"""Application configuration via pydantic-settings.

Settings are read from environment variables first, then from ``.env`` /
``.env.local`` files at the repository root (so the app works whether
``uvicorn`` is launched from the repo root or from ``backend/``). ``.env.local``
is a git-ignored local override that wins over ``.env`` — use it for personal
credentials without touching the shared ``.env``. A missing required variable —
notably ``GROQ_API_KEY`` — fails fast with a clear, actionable message at startup.
"""

from __future__ import annotations

from functools import lru_cache

from pydantic import Field, ValidationError
from pydantic_settings import BaseSettings, SettingsConfigDict

# Checked in order; values found later win, real environment variables always win.
# The ``.env.local`` files come last so a local override beats the shared ``.env``.
DEFAULT_ENV_FILES: tuple[str, ...] = (".env", "../.env", ".env.local", "../.env.local")


class ConfigError(RuntimeError):
    """Raised when required configuration is missing or invalid."""


class Settings(BaseSettings):
    """Typed application settings loaded from the environment / ``.env``."""

    model_config = SettingsConfigDict(
        env_file=DEFAULT_ENV_FILES,
        env_file_encoding="utf-8",
        case_sensitive=False,
        extra="ignore",
    )

    # Required and non-empty: an empty value (e.g. a freshly copied .env.example)
    # must fail fast rather than boot with an unusable credential.
    groq_api_key: str = Field(min_length=1)
    demo_mode: bool = True
    database_path: str = "./data/ragprobe.db"
    groq_generation_model: str = "llama-3.3-70b-versatile"
    groq_fast_model: str = "llama-3.1-8b-instant"
    # Request-rate budget for the answering provider (Groq free tier).
    llm_rate_per_min: int = 15

    # Hard ceiling on a single run's wall-clock time. A run throttled by the free
    # tier can otherwise grind for a very long time; past this it self-terminates
    # (deleted like a failure) so a stuck run cannot run forever server-side.
    max_run_seconds: float = 1800.0

    # Independent judge (optional but recommended): when GEMINI_API_KEY is set,
    # grading runs on Gemini — a different model *family* from the answerer,
    # removing self-preference bias from the scores. Left empty, judging falls
    # back to the answer client (documented limitation).
    gemini_api_key: str = ""
    gemini_judge_model: str = "gemini-3.5-flash"
    gemini_base_url: str = "https://generativelanguage.googleapis.com/v1beta/openai"
    # Gemini free tier allows ~10 requests/min; stay under it.
    judge_rate_per_min: int = 8

    # Directory holding the built SPA (Vite dist). When it exists, the API also
    # serves the frontend — the single-container deployment story. Absent in
    # development, where Vite serves the frontend itself.
    static_dir: str = "./static"

    # Application version surfaced by /api/health. Not read from the environment
    # in practice, but overridable for tests/deploys.
    version: str = "0.1.0"


def _format_validation_error(exc: ValidationError) -> str:
    """Turn a pydantic ValidationError into a clear, actionable message."""
    fields = sorted({str(err["loc"][0]).upper() for err in exc.errors() if err["loc"]})
    if fields:
        joined = ", ".join(fields)
        return (
            f"Missing or invalid required configuration: {joined}. "
            "Set it in your environment or in a .env file at the repo root "
            "(copy .env.example to .env and fill in the values)."
        )
    return f"Invalid configuration: {exc}"


def _create_settings(env_file: tuple[str, ...] | None = DEFAULT_ENV_FILES) -> Settings:
    """Build Settings, translating validation failures into ConfigError."""
    try:
        return Settings(_env_file=env_file)  # type: ignore[call-arg]
    except ValidationError as exc:
        raise ConfigError(_format_validation_error(exc)) from exc


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    """Return the process-wide settings singleton (cached)."""
    return _create_settings()

"""Async, provider-agnostic LLM client: rate limiting, retries, JSON mode (§6.6).

This module is load-bearing — every LLM call in RAGProbe (exam generation,
answer generation, the correctness/faithfulness judges) goes through an
:class:`LLMClient`. It speaks the OpenAI-compatible ``/chat/completions``
protocol, so one implementation serves any conforming provider — Groq for
answering, Gemini for judging — each instance with its own credentials, model
IDs, and rate budget. Free tiers are rate-limited, so the client:

* caps in-flight concurrency with an ``asyncio.Semaphore`` and throttles the
  request *rate* with an async token bucket (per-instance ``rate_per_min``);
* retries 429 / 5xx responses with exponential backoff + jitter, honoring a
  ``retry-after`` header when present, up to :data:`MAX_ATTEMPTS` attempts —
  consuming a bucket token per attempt so retries stay throttled too;
* exposes :meth:`LLMClient.json_mode`, which requests a JSON object, strips
  code fences, validates against a pydantic schema, and makes one repair
  attempt before giving up;
* emits a structured log line per call (host, model, latency, tokens, attempt).

The clock (``monotonic``/``sleep``) and ``jitter`` source are injectable so
tests run instantly and deterministically without real waits or network — the
same dependency-injection style as ``Embedder`` in :mod:`app.core.indexing`.
"""

from __future__ import annotations

import asyncio
import json
import logging
import random
import re
import time
from collections.abc import Awaitable, Callable, Sequence
from dataclasses import dataclass
from enum import StrEnum
from typing import Any, Literal, TypeVar

import httpx
from pydantic import BaseModel, Field, ValidationError

from app.config import Settings

logger = logging.getLogger("ragprobe")

# OpenAI-compatible endpoints (§3). The constructor accepts a base_url
# override so tests can point respx at a predictable host.
GROQ_BASE_URL = "https://api.groq.com/openai/v1"
CHAT_PATH = "/chat/completions"

MAX_ATTEMPTS = 5  # retries cap (§6.6)
MAX_CONCURRENCY = 4  # asyncio.Semaphore size (§6.6)
DEFAULT_RATE_PER_MIN = 15.0  # token-bucket default (§6.6); free-tier safe
BASE_DELAY = 0.5  # first retry backoff, seconds
MAX_DELAY = 8.0  # backoff ceiling, seconds

# Injectable side-effects, defaulted to the real ones (see module docstring).
Sleeper = Callable[[float], Awaitable[None]]
Monotonic = Callable[[], float]
Jitter = Callable[[float, float], float]

# Module-level TypeVar (rather than PEP 695 ``[T]`` syntax) for compatibility
# with the pinned pre-commit mypy, which does not yet accept PEP 695 generics.
T = TypeVar("T", bound=BaseModel)


class ModelRole(StrEnum):
    """Logical model roles mapped to concrete model IDs at call time.

    Call sites name the *role* (``GENERATION`` / ``FAST``); the client resolves
    it to the configured model ID, so the IDs live in one place (settings).
    """

    GENERATION = "generation"
    FAST = "fast"


class ChatMessage(BaseModel):
    """A single chat message in the OpenAI/Groq ``messages`` format."""

    role: Literal["system", "user", "assistant"]
    content: str


@dataclass(frozen=True)
class ChatResult:
    """The outcome of a successful chat completion.

    ``latency_ms`` is the wall time of the *successful HTTP attempt only* —
    it excludes semaphore waits, token-bucket throttling, and failed-attempt
    backoff, so it measures the provider, not this client's rate limiting.
    """

    text: str
    model: str
    prompt_tokens: int
    completion_tokens: int
    attempts: int
    latency_ms: int = 0


@dataclass(frozen=True)
class TokenUsage:
    """Token counts accumulated across one or more chat calls."""

    prompt_tokens: int = 0
    completion_tokens: int = 0

    def add(self, result: ChatResult) -> TokenUsage:
        """Return this usage plus one chat result's token counts."""
        return TokenUsage(
            prompt_tokens=self.prompt_tokens + result.prompt_tokens,
            completion_tokens=self.completion_tokens + result.completion_tokens,
        )


class LLMError(RuntimeError):
    """Raised when a request fails non-retryably or exhausts its retries."""


class LLMJSONError(LLMError):
    """Raised when :meth:`LLMClient.json_mode` cannot parse valid JSON.

    Carries the last raw model output (``raw``) to aid debugging upstream.
    """

    def __init__(self, message: str, *, raw: str) -> None:
        super().__init__(message)
        self.raw = raw


# ---------------------------------------------------------------------------
# Internal models mirroring the OpenAI-compatible response shape (keeps mypy
# strict — no Any leaks from response.json()).
# ---------------------------------------------------------------------------


class _Usage(BaseModel):
    prompt_tokens: int = 0
    completion_tokens: int = 0
    total_tokens: int = 0


class _Message(BaseModel):
    content: str = ""


class _Choice(BaseModel):
    message: _Message = Field(default_factory=_Message)


class _Completion(BaseModel):
    model: str = ""
    choices: list[_Choice] = Field(default_factory=list)
    usage: _Usage = Field(default_factory=_Usage)


# ---------------------------------------------------------------------------
# Pure helpers (unit-tested directly)
# ---------------------------------------------------------------------------

# Matches an optionally-``json``-tagged fenced block, capturing its body.
_FENCE_RE = re.compile(r"^\s*```(?:json)?\s*\n?(.*?)\n?\s*```\s*$", re.DOTALL | re.IGNORECASE)


def strip_code_fences(text: str) -> str:
    """Return ``text`` with a single wrapping ```` ``` ```` / ```` ```json ```` block removed."""
    match = _FENCE_RE.match(text)
    if match:
        return match.group(1).strip()
    return text.strip()


def _parse_retry_after(headers: httpx.Headers) -> float | None:
    """Parse a ``retry-after`` header as seconds, or ``None`` if absent/non-numeric.

    Groq sends a numeric seconds value; the HTTP-date form is unsupported and
    falls back to computed backoff.
    """
    raw = headers.get("retry-after")
    if raw is None:
        return None
    try:
        return float(raw)
    except ValueError:
        return None


def _backoff_seconds(attempt: int, retry_after: float | None, *, jitter: Jitter) -> float:
    """Seconds to wait after a failed ``attempt`` (1-based).

    ``retry-after`` wins when present; otherwise exponential backoff capped at
    :data:`MAX_DELAY` plus up to :data:`BASE_DELAY` of jitter.
    """
    if retry_after is not None:
        return retry_after
    # 1 << (attempt - 1) == 2 ** (attempt - 1), but stays a typed int (the int
    # power operator is typed as Any in typeshed, which would poison the return).
    capped = min(MAX_DELAY, BASE_DELAY * (1 << (attempt - 1)))
    return capped + jitter(0.0, BASE_DELAY)


# ---------------------------------------------------------------------------
# Rate limiting
# ---------------------------------------------------------------------------


class TokenBucket:
    """An async token bucket that throttles acquisitions to a target rate.

    Lock-guarded so the rate is enforced globally across concurrent callers.
    Starts full, so an initial burst up to ``capacity`` does not block. The
    clock and sleep are injected for deterministic, instant tests.
    """

    def __init__(
        self,
        rate_per_sec: float,
        capacity: float,
        *,
        monotonic: Monotonic = time.monotonic,
        sleep: Sleeper = asyncio.sleep,
    ) -> None:
        self._rate = rate_per_sec
        self._capacity = capacity
        self._tokens = capacity
        self._monotonic = monotonic
        self._sleep = sleep
        self._updated = monotonic()
        self._lock = asyncio.Lock()

    async def acquire(self) -> None:
        """Block until one token is available, then consume it."""
        async with self._lock:
            while True:
                now = self._monotonic()
                self._tokens = min(
                    self._capacity, self._tokens + (now - self._updated) * self._rate
                )
                self._updated = now
                if self._tokens >= 1.0:
                    self._tokens -= 1.0
                    return
                await self._sleep((1.0 - self._tokens) / self._rate)


# ---------------------------------------------------------------------------
# Client
# ---------------------------------------------------------------------------


class LLMClient:
    """Async, rate-limited, retrying client for OpenAI-compatible chat APIs.

    Provider-agnostic: each instance binds its own base URL, credentials,
    model IDs, and request-rate budget, so the answering provider (Groq) and
    the judging provider (Gemini) run as two independently throttled clients.
    """

    def __init__(
        self,
        *,
        api_key: str,
        generation_model: str,
        fast_model: str,
        http_client: httpx.AsyncClient | None = None,
        base_url: str = GROQ_BASE_URL,
        rate_per_min: float = DEFAULT_RATE_PER_MIN,
        sleep: Sleeper = asyncio.sleep,
        monotonic: Monotonic = time.monotonic,
        jitter: Jitter = random.uniform,
    ) -> None:
        self._generation_model = generation_model
        self._fast_model = fast_model
        self._sleep = sleep
        self._monotonic = monotonic
        self._jitter = jitter
        self._headers = {
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        }
        self._http = http_client or httpx.AsyncClient(base_url=base_url, timeout=60.0)
        # Host recorded per structured log line, so answerer vs judge traffic
        # is distinguishable in a run's logs.
        self._host = httpx.URL(base_url).host or "unknown"
        self._semaphore = asyncio.Semaphore(MAX_CONCURRENCY)
        self._bucket = TokenBucket(
            rate_per_min / 60.0,
            float(MAX_CONCURRENCY),
            monotonic=monotonic,
            sleep=sleep,
        )

    async def __aenter__(self) -> LLMClient:
        return self

    async def __aexit__(self, *exc: object) -> None:
        await self.aclose()

    async def aclose(self) -> None:
        """Close the underlying HTTP client."""
        await self._http.aclose()

    @property
    def host(self) -> str:
        """The provider host this client talks to (for logs and diagnostics)."""
        return self._host

    def _model_id(self, role: ModelRole) -> str:
        return self._generation_model if role is ModelRole.GENERATION else self._fast_model

    async def chat(
        self,
        messages: Sequence[ChatMessage],
        *,
        role: ModelRole,
        temperature: float = 0.0,
        json_object: bool = False,
    ) -> ChatResult:
        """Run one chat completion, rate-limited and retried.

        Retries 429 / 5xx with backoff (honoring ``retry-after``); raises
        :class:`LLMError` on other 4xx or once :data:`MAX_ATTEMPTS` is reached.
        """
        model_id = self._model_id(role)
        body: dict[str, Any] = {
            "model": model_id,
            "messages": [m.model_dump() for m in messages],
            "temperature": temperature,
        }
        if json_object:
            body["response_format"] = {"type": "json_object"}

        async with self._semaphore:
            for attempt in range(1, MAX_ATTEMPTS + 1):
                # One bucket token per HTTP attempt (not per logical call), so
                # retries after a 429 are throttled too instead of bypassing the
                # rate limit exactly when the API is telling us to slow down.
                await self._bucket.acquire()
                started = self._monotonic()
                response = await self._http.post(CHAT_PATH, json=body, headers=self._headers)
                latency_ms = int((self._monotonic() - started) * 1000)
                status = response.status_code

                if status == 200:
                    completion = _Completion.model_validate(response.json())
                    text = completion.choices[0].message.content if completion.choices else ""
                    logger.info(
                        "llm_call",
                        extra={
                            "host": self._host,
                            "model": model_id,
                            "latency_ms": latency_ms,
                            "prompt_tokens": completion.usage.prompt_tokens,
                            "completion_tokens": completion.usage.completion_tokens,
                            "attempt": attempt,
                            "status": status,
                        },
                    )
                    return ChatResult(
                        text=text,
                        model=completion.model or model_id,
                        prompt_tokens=completion.usage.prompt_tokens,
                        completion_tokens=completion.usage.completion_tokens,
                        attempts=attempt,
                        latency_ms=latency_ms,
                    )

                retryable = status == 429 or status >= 500
                logger.warning(
                    "llm_call_retry" if retryable else "llm_call_error",
                    extra={
                        "host": self._host,
                        "model": model_id,
                        "status": status,
                        "attempt": attempt,
                        "latency_ms": latency_ms,
                    },
                )
                if not retryable:
                    raise LLMError(
                        f"LLM request to {self._host} failed with status {status}: {response.text}"
                    )
                if attempt < MAX_ATTEMPTS:
                    delay = _backoff_seconds(
                        attempt, _parse_retry_after(response.headers), jitter=self._jitter
                    )
                    await self._sleep(delay)

        # Reached only if every attempt was a retryable failure.
        raise LLMError(f"LLM request to {self._host} failed after {MAX_ATTEMPTS} attempts.")

    async def json_mode(
        self,
        prompt: str,
        schema: type[T],
        *,
        role: ModelRole,
        system: str | None = None,
    ) -> T:
        """Request a JSON object and validate it against ``schema`` (§6.6).

        Sends ``prompt`` plus the schema in JSON mode, strips any code fences,
        and validates. On failure makes exactly one repair attempt before
        raising :class:`LLMJSONError`.
        """
        parsed, _usage = await self.json_mode_with_usage(prompt, schema, role=role, system=system)
        return parsed

    async def json_mode_with_usage(
        self,
        prompt: str,
        schema: type[T],
        *,
        role: ModelRole,
        system: str | None = None,
    ) -> tuple[T, TokenUsage]:
        """Like :meth:`json_mode`, additionally returning the tokens consumed.

        The usage sums the initial call and the repair call (if one was needed)
        so callers can account for the true cost of a validated object.
        """
        schema_json = json.dumps(schema.model_json_schema())
        instruction = (
            f"{prompt}\n\n"
            "Respond with a single JSON object that conforms to this JSON schema "
            f"(no prose, no markdown fences):\n{schema_json}"
        )
        messages: list[ChatMessage] = []
        if system is not None:
            messages.append(ChatMessage(role="system", content=system))
        messages.append(ChatMessage(role="user", content=instruction))

        result = await self.chat(messages, role=role, json_object=True)
        usage = TokenUsage().add(result)
        try:
            return schema.model_validate_json(strip_code_fences(result.text)), usage
        except ValidationError:
            pass  # fall through to one repair attempt

        repair_messages = [
            *messages,
            ChatMessage(role="assistant", content=result.text),
            ChatMessage(
                role="user",
                content=(
                    "That response was not valid JSON for the schema. Return ONLY the "
                    "corrected JSON object — no explanation, no markdown fences."
                ),
            ),
        ]
        repaired = await self.chat(repair_messages, role=role, json_object=True)
        usage = usage.add(repaired)
        try:
            return schema.model_validate_json(strip_code_fences(repaired.text)), usage
        except ValidationError as exc:
            raise LLMJSONError(
                f"{self._host} returned invalid JSON for {schema.__name__} "
                "after one repair attempt.",
                raw=repaired.text,
            ) from exc


# ---------------------------------------------------------------------------
# Client factories: one per role. The answerer and the judge are separate
# providers with separate rate budgets — and, when a Gemini key is configured,
# separate model families, which is what makes the judge independent (§6.5).
# ---------------------------------------------------------------------------


def answer_client_from_settings(settings: Settings) -> LLMClient:
    """The client used for exam generation and answer generation (Groq)."""
    return LLMClient(
        api_key=settings.groq_api_key,
        generation_model=settings.groq_generation_model,
        fast_model=settings.groq_fast_model,
        rate_per_min=float(settings.llm_rate_per_min),
    )


def judge_client_from_settings(settings: Settings) -> LLMClient | None:
    """An *independent* judge client, or ``None`` when no Gemini key is set.

    ``None`` means the caller falls back to grading with the answer client —
    the zero-config behavior, honestly documented as a limitation (the model
    grades its own work). One env var (``GEMINI_API_KEY``) upgrades every run
    to cross-family judging.
    """
    if not settings.gemini_api_key:
        return None
    return LLMClient(
        api_key=settings.gemini_api_key,
        generation_model=settings.gemini_judge_model,
        fast_model=settings.gemini_judge_model,
        base_url=settings.gemini_base_url,
        rate_per_min=float(settings.judge_rate_per_min),
    )

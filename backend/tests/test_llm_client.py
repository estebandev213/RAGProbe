"""Tests for the async, provider-agnostic LLM client (§6.6).

All HTTP traffic is intercepted by ``respx`` and all waiting is driven by a
``FakeClock`` that advances virtual time on ``sleep`` — so the suite needs no
network, no real API keys, and no wall-clock delays.
"""

import json
import logging

import httpx
import pytest
import respx
from app.config import Settings
from app.core.llm_client import (
    BASE_DELAY,
    MAX_ATTEMPTS,
    MAX_DELAY,
    ChatMessage,
    LLMClient,
    LLMError,
    LLMJSONError,
    ModelRole,
    TokenBucket,
    _backoff_seconds,
    _parse_retry_after,
    answer_client_from_settings,
    judge_client_from_settings,
    strip_code_fences,
)
from pydantic import BaseModel

URL = "https://api.groq.com/openai/v1/chat/completions"
GEN_MODEL = "gen-model"
FAST_MODEL = "fast-model"


class _Grade(BaseModel):
    score: int
    reason: str


class FakeClock:
    """A virtual clock: ``sleep`` advances ``monotonic`` and records durations."""

    def __init__(self) -> None:
        self.now = 0.0
        self.sleeps: list[float] = []

    def monotonic(self) -> float:
        return self.now

    async def sleep(self, delay: float) -> None:
        self.sleeps.append(delay)
        self.now += delay


def make_client(clock: FakeClock | None = None) -> LLMClient:
    clock = clock or FakeClock()
    return LLMClient(
        api_key="test-key",
        generation_model=GEN_MODEL,
        fast_model=FAST_MODEL,
        sleep=clock.sleep,
        monotonic=clock.monotonic,
        jitter=lambda _a, _b: 0.0,
    )


def _completion_body(
    content: str,
    *,
    prompt_tokens: int = 0,
    completion_tokens: int = 0,
    model: str = GEN_MODEL,
) -> dict[str, object]:
    return {
        "model": model,
        "choices": [{"message": {"role": "assistant", "content": content}}],
        "usage": {
            "prompt_tokens": prompt_tokens,
            "completion_tokens": completion_tokens,
            "total_tokens": prompt_tokens + completion_tokens,
        },
    }


def _user(text: str = "question") -> list[ChatMessage]:
    return [ChatMessage(role="user", content=text)]


# ---------------------------------------------------------------------------
# chat: success path
# ---------------------------------------------------------------------------


@respx.mock
async def test_chat_success_parses_text_and_usage() -> None:
    respx.post(URL).mock(
        return_value=httpx.Response(
            200, json=_completion_body("hello", prompt_tokens=11, completion_tokens=4)
        )
    )
    async with make_client() as client:
        result = await client.chat(_user(), role=ModelRole.GENERATION)

    assert result.text == "hello"
    assert result.prompt_tokens == 11
    assert result.completion_tokens == 4
    assert result.attempts == 1
    assert result.model == GEN_MODEL


@respx.mock
async def test_fast_role_uses_fast_model_and_omits_response_format() -> None:
    route = respx.post(URL).mock(
        return_value=httpx.Response(200, json=_completion_body("ok", model=FAST_MODEL))
    )
    async with make_client() as client:
        await client.chat(_user(), role=ModelRole.FAST)

    sent = json.loads(route.calls.last.request.content)
    assert sent["model"] == FAST_MODEL
    assert sent["temperature"] == 0.0
    assert "response_format" not in sent


# ---------------------------------------------------------------------------
# chat: retries
# ---------------------------------------------------------------------------


@respx.mock
async def test_retries_on_429_then_succeeds_honoring_retry_after() -> None:
    route = respx.post(URL).mock(
        side_effect=[
            httpx.Response(429, headers={"retry-after": "2"}, json={"error": "slow down"}),
            httpx.Response(200, json=_completion_body("ok", prompt_tokens=1, completion_tokens=1)),
        ]
    )
    clock = FakeClock()
    async with make_client(clock) as client:
        result = await client.chat(_user(), role=ModelRole.GENERATION)

    assert result.attempts == 2
    assert route.call_count == 2
    assert clock.sleeps == [2.0]  # retry-after honored, not exponential


@respx.mock
async def test_retries_on_5xx_with_exponential_backoff() -> None:
    respx.post(URL).mock(
        side_effect=[
            httpx.Response(500),
            httpx.Response(503),
            httpx.Response(200, json=_completion_body("ok")),
        ]
    )
    clock = FakeClock()
    async with make_client(clock) as client:
        result = await client.chat(_user(), role=ModelRole.GENERATION)

    assert result.attempts == 3
    assert clock.sleeps == [BASE_DELAY, BASE_DELAY * 2]  # jitter zeroed in tests


@respx.mock
async def test_gives_up_after_max_attempts() -> None:
    route = respx.post(URL).mock(return_value=httpx.Response(429))
    async with make_client() as client:
        with pytest.raises(LLMError):
            await client.chat(_user(), role=ModelRole.GENERATION)

    assert route.call_count == MAX_ATTEMPTS


@respx.mock
async def test_non_retryable_4xx_raises_immediately() -> None:
    route = respx.post(URL).mock(return_value=httpx.Response(401, json={"error": "bad key"}))
    async with make_client() as client:
        with pytest.raises(LLMError):
            await client.chat(_user(), role=ModelRole.GENERATION)

    assert route.call_count == 1


# ---------------------------------------------------------------------------
# json_mode
# ---------------------------------------------------------------------------


@respx.mock
async def test_json_mode_strips_code_fences_and_requests_json() -> None:
    body = _completion_body('```json\n{"score": 1, "reason": "grounded"}\n```')
    route = respx.post(URL).mock(return_value=httpx.Response(200, json=body))
    async with make_client() as client:
        out = await client.json_mode("grade this", _Grade, role=ModelRole.GENERATION)

    assert out == _Grade(score=1, reason="grounded")
    assert route.call_count == 1
    sent = json.loads(route.calls.last.request.content)
    assert sent["response_format"] == {"type": "json_object"}


@respx.mock
async def test_json_mode_repairs_malformed_then_succeeds() -> None:
    route = respx.post(URL).mock(
        side_effect=[
            httpx.Response(200, json=_completion_body("this is not json")),
            httpx.Response(200, json=_completion_body('{"score": 0, "reason": "fixed"}')),
        ]
    )
    async with make_client() as client:
        out = await client.json_mode("grade", _Grade, role=ModelRole.GENERATION)

    assert out == _Grade(score=0, reason="fixed")
    assert route.call_count == 2  # original + one repair


@respx.mock
async def test_json_mode_raises_after_repair_fails() -> None:
    respx.post(URL).mock(
        side_effect=[
            httpx.Response(200, json=_completion_body("garbage")),
            httpx.Response(200, json=_completion_body("still garbage")),
        ]
    )
    async with make_client() as client:
        with pytest.raises(LLMJSONError):
            await client.json_mode("grade", _Grade, role=ModelRole.GENERATION)


# ---------------------------------------------------------------------------
# Structured logging
# ---------------------------------------------------------------------------


@respx.mock
async def test_structured_log_has_model_latency_tokens_attempts(
    caplog: pytest.LogCaptureFixture,
) -> None:
    respx.post(URL).mock(
        return_value=httpx.Response(
            200, json=_completion_body("hi", prompt_tokens=7, completion_tokens=2)
        )
    )
    with caplog.at_level(logging.INFO, logger="ragprobe"):
        async with make_client() as client:
            await client.chat(_user(), role=ModelRole.GENERATION)

    record = next(r for r in caplog.records if r.getMessage() == "llm_call")
    assert record.model == GEN_MODEL
    assert record.prompt_tokens == 7
    assert record.completion_tokens == 2
    assert record.attempt == 1
    assert record.host == "api.groq.com"
    assert hasattr(record, "latency_ms")


# ---------------------------------------------------------------------------
# Client factories (answerer vs independent judge)
# ---------------------------------------------------------------------------


def _settings(**overrides: str) -> Settings:
    return Settings(_env_file=None, groq_api_key="groq-key", **overrides)  # type: ignore[call-arg]


async def test_judge_factory_returns_none_without_gemini_key() -> None:
    assert judge_client_from_settings(_settings()) is None


async def test_judge_factory_builds_gemini_client_when_key_set() -> None:
    judge = judge_client_from_settings(_settings(gemini_api_key="gem-key"))
    assert judge is not None
    async with judge:
        assert judge.host == "generativelanguage.googleapis.com"


async def test_answer_factory_targets_groq() -> None:
    async with answer_client_from_settings(_settings()) as answerer:
        assert answerer.host == "api.groq.com"


# ---------------------------------------------------------------------------
# Pure helpers
# ---------------------------------------------------------------------------


def test_strip_code_fences_cases() -> None:
    assert strip_code_fences('{"a": 1}') == '{"a": 1}'
    assert strip_code_fences('```json\n{"a": 1}\n```') == '{"a": 1}'
    assert strip_code_fences('```\n{"a": 1}\n```') == '{"a": 1}'
    assert strip_code_fences('   {"a": 1}   ') == '{"a": 1}'


def test_parse_retry_after() -> None:
    assert _parse_retry_after(httpx.Headers({"retry-after": "5"})) == 5.0
    assert _parse_retry_after(httpx.Headers({})) is None
    # HTTP-date form is unsupported and falls back to None (→ computed backoff).
    http_date = httpx.Headers({"retry-after": "Wed, 21 Oct 2026 07:28:00 GMT"})
    assert _parse_retry_after(http_date) is None


def test_backoff_honors_retry_after_over_jitter() -> None:
    assert _backoff_seconds(1, 3.0, jitter=lambda _a, _b: 99.0) == 3.0
    assert _backoff_seconds(4, 1.5, jitter=lambda _a, _b: 0.0) == 1.5


def test_backoff_is_exponential_and_capped_without_header() -> None:
    assert _backoff_seconds(1, None, jitter=lambda _a, _b: 0.0) == BASE_DELAY
    assert _backoff_seconds(2, None, jitter=lambda _a, _b: 0.0) == BASE_DELAY * 2
    assert _backoff_seconds(99, None, jitter=lambda _a, _b: 0.0) == MAX_DELAY


def test_backoff_adds_jitter() -> None:
    assert _backoff_seconds(1, None, jitter=lambda _a, _b: 0.1) == BASE_DELAY + 0.1


async def test_token_bucket_throttles_to_rate() -> None:
    clock = FakeClock()
    bucket = TokenBucket(1.0, 2.0, monotonic=clock.monotonic, sleep=clock.sleep)

    await bucket.acquire()  # full → no wait
    await bucket.acquire()  # second of capacity → no wait
    await bucket.acquire()  # empty → wait one refill period (1 / rate)

    assert clock.sleeps == [1.0]
    assert clock.now == 1.0

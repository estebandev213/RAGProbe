"""Tests for configuration loading and fail-fast behavior."""

import pytest
from app.config import ConfigError, _create_settings


def test_missing_groq_api_key_fails_fast(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("GROQ_API_KEY", raising=False)
    with pytest.raises(ConfigError) as excinfo:
        _create_settings(env_file=None)
    assert "GROQ_API_KEY" in str(excinfo.value)


def test_empty_groq_api_key_fails_fast(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("GROQ_API_KEY", "")
    with pytest.raises(ConfigError) as excinfo:
        _create_settings(env_file=None)
    assert "GROQ_API_KEY" in str(excinfo.value)


def test_settings_load_with_defaults(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("GROQ_API_KEY", "abc123")
    settings = _create_settings(env_file=None)
    assert settings.groq_api_key == "abc123"
    assert settings.demo_mode is True
    assert settings.groq_generation_model == "llama-3.3-70b-versatile"
    assert settings.groq_fast_model == "llama-3.1-8b-instant"

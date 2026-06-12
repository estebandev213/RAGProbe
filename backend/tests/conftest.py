"""Shared test configuration.

Tests are fully mocked and never call Groq, but importing ``app.main`` builds
the app (and therefore loads Settings, which requires GROQ_API_KEY). Provide a
dummy key here, before any test module imports the app, so collection succeeds
without a real credential.
"""

import os

os.environ.setdefault("GROQ_API_KEY", "test-dummy-key")
# Keep tests off the real on-disk database by default; tests that need
# persistence (e.g. document upload) override DATABASE_PATH with a tmp file.
os.environ.setdefault("DATABASE_PATH", ":memory:")

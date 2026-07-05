# ---------------------------------------------------------------------------
# Stage 1 — build the React SPA
# ---------------------------------------------------------------------------
FROM node:20-alpine AS frontend

WORKDIR /build
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build

# ---------------------------------------------------------------------------
# Stage 2 — Python runtime serving API + SPA from one port
# ---------------------------------------------------------------------------
FROM python:3.12-slim AS runtime

WORKDIR /app
ENV PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    STATIC_DIR=/app/static \
    DATABASE_PATH=/app/data/ragprobe.db

COPY backend/pyproject.toml ./
COPY backend/app ./app
RUN pip install --no-cache-dir .

COPY --from=frontend /build/dist ./static

# SQLite lives here; mount a volume at /app/data to survive redeploys.
RUN mkdir -p /app/data

EXPOSE 8000

# Single worker: the SSE event bus and BM25 indexes are in-process state, and
# free-tier instances (512MB) fit exactly one fastembed model. $PORT honors
# Railway/Render's injected port, defaulting to 8000 locally.
CMD ["sh", "-c", "uvicorn app.main:app --host 0.0.0.0 --port ${PORT:-8000} --workers 1"]

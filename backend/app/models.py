"""Pydantic schemas shared across API boundaries.

Domain-specific models (documents, runs, questions, grades, ...) are added in
later commits; this module starts with the cross-cutting health and error
envelopes referenced by the API contract (§7).
"""

from __future__ import annotations

from enum import StrEnum

from pydantic import BaseModel, Field

# Sentinel gold answer for questions that the documents do not answer (§6.3).
# The answer generator is told to reply with exactly this string when the
# context is insufficient, and the correctness judge scores an abstention as
# correct only for unanswerable questions.
NOT_IN_DOCUMENTS = "NOT_IN_DOCUMENTS"


class HealthResponse(BaseModel):
    """Response body for ``GET /api/health``."""

    ok: bool
    version: str


class DocumentSummary(BaseModel):
    """A stored document without its full text.

    Returned by ``POST /api/documents`` (upload) and ``GET /api/documents``
    (list). The extracted text is intentionally omitted — it can be large and
    no client screen needs it.
    """

    id: str
    name: str
    mime: str
    char_count: int
    created_at: str


class ErrorResponse(BaseModel):
    """Uniform error envelope: ``{detail, code}`` with a proper status code."""

    detail: str
    code: str


# ---------------------------------------------------------------------------
# Exam (§6.3): question taxonomy, the LLM's generation schema, and the
# persisted question with located gold spans.
# ---------------------------------------------------------------------------


class QType(StrEnum):
    """The four question types of the exam taxonomy (§6.3).

    The mix is fixed at 40% factual, 25% multi-hop, 20% paraphrase, 15%
    unanswerable; each type stresses a different part of the RAG pipeline.
    """

    FACTUAL = "factual"
    MULTIHOP = "multihop"
    PARAPHRASE = "paraphrase"
    UNANSWERABLE = "unanswerable"


class GeneratedQuestion(BaseModel):
    """One question as returned by the generation model (pre-span-location).

    Deliberately permissive: semantic rules (unanswerable ⇒ no quotes, every
    quote must be locatable in a document) are enforced per-question in
    :mod:`app.core.exam` so a single bad question is discarded rather than
    failing the whole batch. ``supporting_quotes`` are verbatim excerpts the
    backend locates in the canonical document text to compute gold spans.
    """

    qtype: QType
    question: str
    gold_answer: str
    supporting_quotes: list[str] = Field(default_factory=list)


class GeneratedExam(BaseModel):
    """The generation model's JSON-mode output: a batch of questions."""

    questions: list[GeneratedQuestion]


class GoldSpan(BaseModel):
    """A located supporting passage as a char range into a document's text.

    ``document_text[start_char:end_char]`` recovers the quote (modulo the
    whitespace/case normalization used during fuzzy location). Span-overlap
    retrieval scoring (§6.5) compares these ranges against retrieved chunks'
    ranges, which is what makes retrieval comparable across chunk sizes.
    """

    doc_id: str
    start_char: int
    end_char: int


class Question(BaseModel):
    """A persisted exam question with its resolved gold spans.

    Mirrors the ``questions`` table. ``gold_spans`` is empty for unanswerable
    questions; ``source_doc_id`` is the document of the first gold span (``None``
    for unanswerable).
    """

    id: str
    run_id: str
    qtype: QType
    question: str
    gold_answer: str
    gold_spans: list[GoldSpan]
    source_doc_id: str | None


# ---------------------------------------------------------------------------
# Runs (§6.7): lifecycle status, the config matrix, and the SSE event shape the
# run orchestrator emits as it works through generate → index → answer.
# ---------------------------------------------------------------------------


class RunStatus(StrEnum):
    """Coarse run lifecycle state, persisted in ``runs.status`` (§6.7).

    The orchestrator advances through these in order; the SSE event stream
    mirrors each transition as a ``phase`` event. ``JUDGING`` is reserved for the
    grading commit — this orchestrator stops at ``ANSWERING`` then ``DONE``.
    """

    PENDING = "pending"
    GENERATING_EXAM = "generating_exam"
    INDEXING = "indexing"
    ANSWERING = "answering"
    JUDGING = "judging"
    DONE = "done"
    ERROR = "error"


class RunSettings(BaseModel):
    """Per-run knobs, serialized into ``runs.settings`` as JSON.

    ``demo_mode`` shrinks both the exam and the config matrix to fit free-tier
    rate limits; ``n_questions`` and ``top_k`` are resolved from it at run
    creation so the run is reproducible from its stored settings alone.
    """

    demo_mode: bool
    n_questions: int
    top_k: int


class RunCreate(BaseModel):
    """Request body for ``POST /api/runs``.

    ``demo_mode`` is optional: when omitted it falls back to the application
    default (``Settings.demo_mode``).
    """

    doc_ids: list[str]
    demo_mode: bool | None = None


class RunCreated(BaseModel):
    """Response body for ``POST /api/runs``: the id of the started run."""

    run_id: str


class RunStatusResponse(BaseModel):
    """Status snapshot for ``GET /api/runs/{id}`` and the SSE reconnect replay."""

    id: str
    status: RunStatus
    error: str | None
    created_at: str


class ConfigSummary(BaseModel):
    """One config in the matrix; mirrors a ``configs`` row.

    ``label`` is the human-readable ``"{chunk_size}/{strategy}"`` shown in the
    report and carried on progress events.
    """

    id: str
    run_id: str
    chunk_size: int
    strategy: str
    top_k: int
    label: str


class RunEventType(StrEnum):
    """The kinds of event the run orchestrator publishes over SSE (§6.7)."""

    PHASE = "phase"
    PROGRESS = "progress"
    CONFIG_DONE = "config_done"
    RUN_DONE = "run_done"
    ERROR = "error"


class RunEvent(BaseModel):
    """A single SSE event from a run (§6.7).

    Fields beyond ``type`` are optional and populated per event kind: ``phase``
    on lifecycle transitions; ``config_label``/``done``/``total`` on answering
    progress; ``message`` on errors and human-readable notes.
    """

    type: RunEventType
    phase: RunStatus | None = None
    config_label: str | None = None
    done: int | None = None
    total: int | None = None
    message: str | None = None

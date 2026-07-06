"""Pydantic schemas shared across API boundaries.

Domain-specific models (documents, runs, questions, grades, ...) are added in
later commits; this module starts with the cross-cutting health and error
envelopes referenced by the API contract (§7).
"""

from __future__ import annotations

from enum import StrEnum

from pydantic import BaseModel, Field, field_validator

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


class RunTitle(BaseModel):
    """The fast model's JSON-mode output: a short, recognizable run title (§8)."""

    title: str


class SpanRange(BaseModel):
    """A plain char range into one document's text."""

    doc_id: str
    start_char: int
    end_char: int


class GoldSpan(BaseModel):
    """A located supporting passage as a char range into a document's text.

    ``document_text[start_char:end_char]`` recovers the quote (modulo the
    whitespace/case normalization used during fuzzy location). Span-overlap
    retrieval scoring (§6.5) compares these ranges against retrieved chunks'
    ranges, which is what makes retrieval comparable across chunk sizes.

    ``alternates`` lists *other occurrences of the same quote* anywhere in the
    corpus: repeated text (headers, boilerplate) means a retriever may surface
    a different-but-identical passage, and that must count as a hit rather than
    a false miss. Rows stored before this field existed parse with the default.
    """

    doc_id: str
    start_char: int
    end_char: int
    alternates: list[SpanRange] = Field(default_factory=list)


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
    mirrors each transition as a ``phase`` event.
    """

    PENDING = "pending"
    GENERATING_EXAM = "generating_exam"
    INDEXING = "indexing"
    ANSWERING = "answering"
    JUDGING = "judging"
    DONE = "done"
    ERROR = "error"


# Retrieval strategies a config may pick (§6.2). Single source of truth: the
# request validator here and the dispatcher in app.core.retrieval both read it,
# so the API and the pipeline can never disagree on what's valid.
STRATEGIES: tuple[str, ...] = ("vector", "bm25", "hybrid")

# Bounds on a Sandbox config's knobs. Chunk size is token-approximate (§6.1):
# below ~100 chunking degenerates, above ~2000 it blows the answer context
# budget. top_k is the retrieval depth handed to each question.
MIN_CHUNK_SIZE, MAX_CHUNK_SIZE = 100, 2000
MIN_TOP_K, MAX_TOP_K = 1, 20


class ConfigSpec(BaseModel):
    """One retrieval configuration to evaluate: chunk size / strategy / depth.

    In Sandbox mode (§8) the client sends an explicit list of these; when omitted
    the backend derives the demo/full matrix instead. Bounds are enforced at this
    boundary so an out-of-range knob is a clean 422, not a failure deep in
    indexing. Two specs are considered *the same configuration* when all three
    fields match — the run route rejects duplicates.
    """

    chunk_size: int = Field(ge=MIN_CHUNK_SIZE, le=MAX_CHUNK_SIZE)
    strategy: str
    top_k: int = Field(ge=MIN_TOP_K, le=MAX_TOP_K)

    @field_validator("strategy")
    @classmethod
    def _known_strategy(cls, value: str) -> str:
        if value not in STRATEGIES:
            raise ValueError(f"strategy must be one of {STRATEGIES}")
        return value

    def key(self) -> tuple[int, str, int]:
        """Identity tuple used to detect duplicate configurations."""
        return (self.chunk_size, self.strategy, self.top_k)


class RunSettings(BaseModel):
    """Per-run knobs, serialized into ``runs.settings`` as JSON.

    ``demo_mode`` shrinks the exam (fewer questions) and caps how many configs a
    Sandbox run may request, to fit free-tier rate limits; ``n_questions`` and
    ``top_k`` are resolved at run creation so the run is reproducible from its
    stored settings alone. ``configs`` is the concrete evaluated matrix (custom
    or derived) — persisting it keeps a run self-describing, so history can show
    its shape without re-deriving. Older rows predate this field and parse with
    ``None`` (the summary then falls back to the derived count). The model IDs
    record *which* models produced and graded the numbers.
    """

    demo_mode: bool
    n_questions: int
    top_k: int
    answer_model: str = ""
    judge_model: str = ""
    configs: list[ConfigSpec] | None = None


class RunCreate(BaseModel):
    """Request body for ``POST /api/runs``.

    ``demo_mode`` is optional: when omitted it falls back to the application
    default (``Settings.demo_mode``). ``configs`` is the Sandbox matrix (§8) — an
    explicit list to evaluate; when omitted the backend derives the demo/full
    matrix, preserving the zero-config default. Its length is capped against the
    resolved ``demo_mode`` in the route, which is where that mode is finally known.
    """

    doc_ids: list[str]
    demo_mode: bool | None = None
    configs: list[ConfigSpec] | None = None


class RunCreated(BaseModel):
    """Response body for ``POST /api/runs``.

    Carries the resolved run shape (``n_questions`` x ``n_configs``) so the UI
    renders the numbers the backend actually decided on — the backend is the
    single source of truth for exam and matrix sizing.
    """

    run_id: str
    n_questions: int
    n_configs: int


class RunStatusResponse(BaseModel):
    """Status snapshot for ``GET /api/runs/{id}`` and the SSE reconnect replay."""

    id: str
    status: RunStatus
    error: str | None
    created_at: str


class RunSummary(BaseModel):
    """One run as shown in the history list (``GET /api/runs``), newest first.

    ``title`` is the AI-generated name (falling back to the joined document names),
    and ``document_names`` feeds the card's source chips. The counts are the run's
    *shape*, read straight off the stored ``doc_ids`` and ``settings``.
    """

    id: str
    status: RunStatus
    created_at: str
    error: str | None
    title: str
    document_names: list[str]
    demo_mode: bool
    n_documents: int
    n_questions: int
    n_configs: int


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


# ---------------------------------------------------------------------------
# Grading (§6.5): the three-metric judge output, the persisted grade, and the
# human override that makes the LLM judge accountable.
# ---------------------------------------------------------------------------

# The only scores any metric can take (§6.5): wrong / partial / right.
VALID_SCORES: tuple[float, ...] = (0.0, 0.5, 1.0)


def _snap_score(value: float) -> float:
    """Round a free-form score to the nearest allowed value in :data:`VALID_SCORES`.

    LLM judges occasionally emit off-grid scores (e.g. ``0.7``); snapping keeps
    a single stray number from failing JSON validation and triggering a needless
    repair round, while still confining grades to the {0, 0.5, 1} scale.
    """
    return min(VALID_SCORES, key=lambda valid: abs(valid - value))


class JudgeConfidence(StrEnum):
    """How sure the judge is of its verdict; surfaced in the report (§6.5)."""

    LOW = "low"
    MEDIUM = "medium"
    HIGH = "high"


class JudgeVerdict(BaseModel):
    """One metric's judgment as returned by the LLM judge in JSON mode (§6.5)."""

    score: float
    rationale: str
    confidence: JudgeConfidence

    @field_validator("score")
    @classmethod
    def _snap(cls, value: float) -> float:
        return _snap_score(value)


class Grade(BaseModel):
    """A persisted grade for one answer; mirrors the ``grades`` table.

    ``retrieval_hit`` is ``None`` for unanswerable questions, which are excluded
    from that metric (§6.5). The composite is computed on read from these three
    fields, so an override re-aggregates without any stored value to refresh.
    The ``judge_*_tokens`` fields record what the grading itself cost —
    deterministic (abstention) verdicts cost zero.
    """

    id: str
    answer_id: str
    correctness: float
    faithfulness: float
    retrieval_hit: float | None
    judge_rationale: str
    judge_confidence: JudgeConfidence
    overridden: bool
    judge_prompt_tokens: int = 0
    judge_completion_tokens: int = 0


class GradeOverride(BaseModel):
    """Request body for ``PATCH /api/grades/{id}``: a manual judge correction.

    Either field may be supplied; each must be an on-grid score. The route
    rejects an empty body (nothing to change).
    """

    correctness: float | None = None
    faithfulness: float | None = None

    @field_validator("correctness", "faithfulness")
    @classmethod
    def _must_be_on_grid(cls, value: float | None) -> float | None:
        if value is not None and value not in VALID_SCORES:
            raise ValueError(f"score must be one of {VALID_SCORES}")
        return value


# ---------------------------------------------------------------------------
# Report aggregation (§7, §8): the leaderboard + per-question-type breakdown the
# report card ranks configs by, and the failure drill-down rows it explores.
# ---------------------------------------------------------------------------


class ConfigScore(BaseModel):
    """One config's aggregated scores — a leaderboard row.

    ``retrieval_hit`` is the mean over answerable questions only (unanswerable
    are excluded from that metric), and is ``None`` when the config answered no
    answerable question.
    """

    config_id: str
    label: str
    chunk_size: int
    strategy: str
    composite: float
    correctness: float
    faithfulness: float
    retrieval_hit: float | None
    mean_latency_ms: float
    n_answers: int


class QTypeScore(BaseModel):
    """Mean composite for one question type within a config (breakdown bar)."""

    qtype: QType
    composite: float
    n: int


class ConfigBreakdown(BaseModel):
    """Per-question-type scores for one config — feeds the grouped bar chart."""

    config_id: str
    label: str
    by_qtype: list[QTypeScore]


class ReportResponse(BaseModel):
    """Response for ``GET /api/runs/{id}/report`` (§7).

    ``leaderboard`` is ranked by composite (best first); ``winner_label`` and
    ``recommendation`` summarize the top config, or are empty/``None`` when the
    run has no grades yet.
    """

    run_id: str
    leaderboard: list[ConfigScore]
    breakdown: list[ConfigBreakdown]
    winner_label: str | None
    recommendation: str


class GoldSpanHit(BaseModel):
    """A gold span paired with whether retrieval covered it (≥ 50% overlap)."""

    span: GoldSpan
    hit: bool


class RetrievedChunkView(BaseModel):
    """A retrieved chunk as shown in the failure explorer (offsets drive badges)."""

    chunk_id: str
    document_id: str
    start_char: int
    end_char: int
    text: str


class FailureRow(BaseModel):
    """One graded answer with everything the explorer needs to diagnose it (§8).

    Carries the three metric scores, the composite, and per-metric failure flags
    so the UI can badge and filter without recomputation — the backend hides
    nothing, it ranks (worst first) and labels.
    """

    answer_id: str
    grade_id: str
    config_id: str
    config_label: str
    question_id: str
    qtype: QType
    question: str
    gold_answer: str
    answer_text: str
    gold_span_hits: list[GoldSpanHit]
    retrieved_chunks: list[RetrievedChunkView]
    correctness: float
    faithfulness: float
    retrieval_hit: float | None
    composite: float
    is_failure: bool
    correctness_failed: bool
    faithfulness_failed: bool
    retrieval_failed: bool
    judge_rationale: str
    judge_confidence: JudgeConfidence
    overridden: bool


class FailuresResponse(BaseModel):
    """Response for ``GET /api/runs/{id}/failures`` — rows ranked worst first."""

    run_id: str
    failures: list[FailureRow]

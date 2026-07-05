/**
 * TypeScript mirrors of the backend pydantic schemas (§7).
 *
 * Kept as string-literal unions and const maps rather than TS enums so the build
 * stays under `erasableSyntaxOnly` (no runtime-emitting syntax).
 */

export interface DocumentSummary {
  id: string;
  name: string;
  mime: string;
  char_count: number;
  created_at: string;
}

/** Coarse run lifecycle state, advanced in order by the orchestrator (§6.7). */
export type RunStatus =
  | "pending"
  | "generating_exam"
  | "indexing"
  | "answering"
  | "judging"
  | "done"
  | "error";

export interface RunCreated {
  run_id: string;
  /** Backend-resolved run shape — the single source of truth for counts. */
  n_questions: number;
  n_configs: number;
}

export interface RunStatusResponse {
  id: string;
  status: RunStatus;
  error: string | null;
  created_at: string;
}

/** One run in the history list (`GET /api/runs`), newest first. */
export interface RunSummary {
  id: string;
  status: RunStatus;
  created_at: string;
  error: string | null;
  /** AI-generated name, falling back to the joined document names. */
  title: string;
  document_names: string[];
  demo_mode: boolean;
  n_documents: number;
  n_questions: number;
  n_configs: number;
}

/** The kinds of event the run orchestrator publishes over SSE (§6.7). */
export type RunEventType =
  | "phase"
  | "progress"
  | "config_done"
  | "run_done"
  | "error";

export interface RunEvent {
  type: RunEventType;
  phase?: RunStatus | null;
  config_label?: string | null;
  done?: number | null;
  total?: number | null;
  message?: string | null;
}

/** Uniform backend error envelope: `{detail, code}`. */
export interface ApiError {
  detail: string;
  code: string;
}

// ---------------------------------------------------------------------------
// Exam taxonomy + grading (§6.3, §6.5) — mirrors of the backend enums.
// ---------------------------------------------------------------------------

/** The four question types of the exam taxonomy. */
export type QType = "factual" | "multihop" | "paraphrase" | "unanswerable";

/** How sure the judge is of its verdict. */
export type JudgeConfidence = "low" | "medium" | "high";

// ---------------------------------------------------------------------------
// Report aggregation (§7, §8): the leaderboard + per-question-type breakdown.
// ---------------------------------------------------------------------------

/** One config's aggregated scores — a leaderboard row. */
export interface ConfigScore {
  config_id: string;
  label: string;
  chunk_size: number;
  strategy: string;
  composite: number;
  correctness: number;
  faithfulness: number;
  /** Mean over answerable questions only; `null` if the config answered none. */
  retrieval_hit: number | null;
  mean_latency_ms: number;
  n_answers: number;
}

/** Mean composite for one question type within a config (a breakdown bar). */
export interface QTypeScore {
  qtype: QType;
  composite: number;
  n: number;
}

/** Per-question-type scores for one config — feeds the grouped bar chart. */
export interface ConfigBreakdown {
  config_id: string;
  label: string;
  by_qtype: QTypeScore[];
}

/** Response for `GET /api/runs/{id}/report`. */
export interface ReportResponse {
  run_id: string;
  /** Ranked by composite, best first. */
  leaderboard: ConfigScore[];
  breakdown: ConfigBreakdown[];
  winner_label: string | null;
  recommendation: string;
}

// ---------------------------------------------------------------------------
// Failure drill-down (§8): graded answers with everything to diagnose them.
// ---------------------------------------------------------------------------

/** A plain char range into one document's text. */
export interface SpanRange {
  doc_id: string;
  start_char: number;
  end_char: number;
}

/**
 * A located supporting passage as a char range into a document.
 * `alternates` are other occurrences of the same quote in the corpus — a hit
 * on any occurrence counts, so repeated text can't cause false misses.
 */
export interface GoldSpan {
  doc_id: string;
  start_char: number;
  end_char: number;
  alternates?: SpanRange[];
}

/** A gold span paired with whether retrieval covered it (≥ 50% overlap). */
export interface GoldSpanHit {
  span: GoldSpan;
  hit: boolean;
}

/** A retrieved chunk as shown in the failure explorer. */
export interface RetrievedChunkView {
  chunk_id: string;
  document_id: string;
  start_char: number;
  end_char: number;
  text: string;
}

/** One graded answer with everything the explorer needs to diagnose it. */
export interface FailureRow {
  answer_id: string;
  grade_id: string;
  config_id: string;
  config_label: string;
  question_id: string;
  qtype: QType;
  question: string;
  gold_answer: string;
  answer_text: string;
  gold_span_hits: GoldSpanHit[];
  retrieved_chunks: RetrievedChunkView[];
  correctness: number;
  faithfulness: number;
  retrieval_hit: number | null;
  composite: number;
  is_failure: boolean;
  correctness_failed: boolean;
  faithfulness_failed: boolean;
  retrieval_failed: boolean;
  judge_rationale: string;
  judge_confidence: JudgeConfidence;
  overridden: boolean;
}

/** Response for `GET /api/runs/{id}/failures` — rows ranked worst first. */
export interface FailuresResponse {
  run_id: string;
  failures: FailureRow[];
}

/** A persisted grade, returned by the override endpoint. */
export interface Grade {
  id: string;
  answer_id: string;
  correctness: number;
  faithfulness: number;
  retrieval_hit: number | null;
  judge_rationale: string;
  judge_confidence: JudgeConfidence;
  overridden: boolean;
}

/** Body for `PATCH /api/grades/{id}` — a manual judge correction. */
export interface GradeOverride {
  correctness?: number;
  faithfulness?: number;
}

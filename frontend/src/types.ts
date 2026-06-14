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
}

export interface RunStatusResponse {
  id: string;
  status: RunStatus;
  error: string | null;
  created_at: string;
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

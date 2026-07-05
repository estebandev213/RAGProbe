/**
 * Typed fetch wrapper + SSE helper for the RAGProbe backend (§7).
 *
 * Everything is same-origin under `/api` — Vite proxies it to the FastAPI dev
 * server, and in production FastAPI serves this SPA, so no base URL is needed.
 */

import type {
  DocumentSummary,
  FailuresResponse,
  Grade,
  GradeOverride,
  ReportResponse,
  RunCreated,
  RunEvent,
  RunStatusResponse,
  RunSummary,
} from "../types";

/** An error carrying the backend's `{detail, code}` envelope when present. */
export class ApiRequestError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(message: string, status: number, code: string) {
    super(message);
    this.name = "ApiRequestError";
    this.status = status;
    this.code = code;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`/api${path}`, init);
  } catch {
    throw new ApiRequestError(
      "Could not reach the server.",
      0,
      "network_error",
    );
  }

  if (!response.ok) {
    let detail = `Request failed (${response.status}).`;
    let code = "http_error";
    try {
      const body = (await response.json()) as {
        detail?: string;
        code?: string;
      };
      if (body.detail) detail = body.detail;
      if (body.code) code = body.code;
    } catch {
      // Non-JSON error body; keep the generic message.
    }
    throw new ApiRequestError(detail, response.status, code);
  }

  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

/** Upload one document; the backend extracts and stores its text. */
export async function uploadDocument(file: File): Promise<DocumentSummary> {
  const form = new FormData();
  form.append("file", file);
  return request<DocumentSummary>("/documents", { method: "POST", body: form });
}

// The demo documents bundled into the SPA so a recruiter needs zero files (§8).
const SAMPLE_FILES = ["meridian-overview.md", "meridian-operations.md"];

/** Load the bundled sample documents by uploading them through the normal path. */
export async function loadSampleDocuments(): Promise<DocumentSummary[]> {
  const uploads = SAMPLE_FILES.map(async (name) => {
    const res = await fetch(`/samples/${name}`);
    if (!res.ok)
      throw new ApiRequestError(
        `Missing sample ${name}.`,
        res.status,
        "sample_error",
      );
    const file = new File([await res.blob()], name, { type: "text/markdown" });
    return uploadDocument(file);
  });
  return Promise.all(uploads);
}

/** Create a run over the given documents and start it in the background. */
export async function createRun(
  docIds: string[],
  demoMode: boolean,
): Promise<RunCreated> {
  return request<RunCreated>("/runs", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ doc_ids: docIds, demo_mode: demoMode }),
  });
}

/** List every run for the history screen, newest first. */
export async function listRuns(): Promise<RunSummary[]> {
  return request<RunSummary[]>("/runs");
}

/** Fetch a run's current status snapshot. */
export async function getRun(runId: string): Promise<RunStatusResponse> {
  return request<RunStatusResponse>(`/runs/${runId}`);
}

/** Fetch a run's aggregated report: leaderboard, breakdown, recommendation. */
export async function getReport(runId: string): Promise<ReportResponse> {
  return request<ReportResponse>(`/runs/${runId}/report`);
}

/** Fetch the failure drill-down rows for a run, ranked worst first. */
export async function getFailures(runId: string): Promise<FailuresResponse> {
  return request<FailuresResponse>(`/runs/${runId}/failures`);
}

/**
 * Manually correct a grade's correctness and/or faithfulness (§6.5).
 *
 * The backend recomputes the composite on read, so callers should refetch the
 * report afterwards to re-aggregate the leaderboard.
 */
export async function overrideGrade(
  gradeId: string,
  patch: GradeOverride,
): Promise<Grade> {
  return request<Grade>(`/grades/${gradeId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  });
}

export interface RunStreamHandlers {
  onEvent: (event: RunEvent) => void;
  onError?: () => void;
}

/**
 * Subscribe to a run's live progress over SSE.
 *
 * The backend replays the current status first, then streams events. Returns the
 * `EventSource` so the caller can `.close()` it on unmount; malformed frames are
 * skipped rather than tearing down the stream.
 */
export function subscribeToRun(
  runId: string,
  handlers: RunStreamHandlers,
): EventSource {
  const source = new EventSource(`/api/runs/${runId}/events`);
  source.onmessage = (message) => {
    try {
      handlers.onEvent(JSON.parse(message.data) as RunEvent);
    } catch {
      // Ignore a single unparseable frame.
    }
  };
  source.onerror = () => handlers.onError?.();
  return source;
}

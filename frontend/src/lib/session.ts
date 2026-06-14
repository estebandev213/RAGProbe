/** Tiny localStorage helpers so the sidebar can link to the most recent run. */

const LAST_RUN_KEY = "ragprobe:lastRunId";

export function setLastRunId(runId: string): void {
  try {
    localStorage.setItem(LAST_RUN_KEY, runId);
  } catch {
    // Storage may be unavailable (private mode); the app still works without it.
  }
}

export function getLastRunId(): string | null {
  try {
    return localStorage.getItem(LAST_RUN_KEY);
  } catch {
    return null;
  }
}

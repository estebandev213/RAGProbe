/** Tiny localStorage helper for the run currently processing.
 *
 * `activeRunId` is set when a run starts and cleared when it reaches a terminal
 * state. It drives the sidebar's Progress link, which is a destination only
 * while a run is live. (The Report link is not backed by storage — it lights up
 * purely from the current route, so it never survives a restart.)
 */

const ACTIVE_RUN_KEY = "ragprobe:activeRunId";

export function setActiveRunId(runId: string): void {
  try {
    localStorage.setItem(ACTIVE_RUN_KEY, runId);
  } catch {
    // Storage may be unavailable (private mode); the app still works without it.
  }
}

export function getActiveRunId(): string | null {
  try {
    return localStorage.getItem(ACTIVE_RUN_KEY);
  } catch {
    return null;
  }
}

export function clearActiveRunId(): void {
  try {
    localStorage.removeItem(ACTIVE_RUN_KEY);
  } catch {
    // Ignore — nothing to clear if storage is unavailable.
  }
}

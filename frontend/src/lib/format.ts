/** Small presentation helpers shared across pages (numbers, sizes, time). */

/** "1,234,567" — thousands-separated integer. */
export function formatNumber(value: number): string {
  return value.toLocaleString("en-US");
}

/** Human file size: "842 KB", "1.24 MB". */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${Math.round(kb)} KB`;
  return `${(kb / 1024).toFixed(2)} MB`;
}

/** Elapsed seconds as "mm:ss" (or "h:mm:ss" past an hour). */
export function formatElapsed(totalSeconds: number): string {
  const seconds = Math.max(0, Math.floor(totalSeconds));
  const s = String(seconds % 60).padStart(2, "0");
  const m = Math.floor(seconds / 60);
  if (m < 60) return `${String(m).padStart(2, "0")}:${s}`;
  const hh = Math.floor(m / 60);
  return `${hh}:${String(m % 60).padStart(2, "0")}:${s}`;
}

/** Wall-clock time of day, e.g. "10:42:31 AM". */
export function formatClock(date: Date): string {
  return date.toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
  });
}

export interface ParsedConfig {
  chunkSize: number;
  strategy: string;
  overlap: number;
}

/**
 * Derive the chunk size, strategy, and 15% overlap from a "{chunk}/{strategy}"
 * config label (§6.1, §6.2) for the progress readout subtitle.
 */
export function parseConfigLabel(label: string): ParsedConfig {
  const [sizePart, strategy = ""] = label.split("/");
  const chunkSize = Number.parseInt(sizePart, 10) || 0;
  return { chunkSize, strategy, overlap: Math.round(chunkSize * 0.15) };
}

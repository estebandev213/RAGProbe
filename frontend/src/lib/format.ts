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

/** A 0–1 score as a two-decimal string; em dash for a missing metric. */
export function formatScore(value: number | null): string {
  return value === null ? "—" : value.toFixed(2);
}

/** Latency in milliseconds rendered as seconds, one decimal: "1.4s". */
export function formatLatency(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

/** Wall-clock date and time, e.g. "May 10, 2025, 10:47 AM". */
export function formatDateTime(date: Date): string {
  return date.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

/** Coarse "x ago" relative time for the report header. */
export function formatRelative(from: Date, now: Date = new Date()): string {
  const seconds = Math.max(
    0,
    Math.round((now.getTime() - from.getTime()) / 1000),
  );
  if (seconds < 60) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

/** Short, accurate description of a retrieval strategy for config sublabels. */
export function strategyDetail(strategy: string): string {
  switch (strategy) {
    case "hybrid":
      return "RRF fusion (k=60)";
    case "bm25":
      return "BM25 keyword";
    case "vector":
      return "vector / cosine";
    default:
      return strategy;
  }
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

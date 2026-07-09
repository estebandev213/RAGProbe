import { useEffect, useRef, useState } from "react";
import { ScrollText } from "lucide-react";
import { useI18n } from "../lib/i18n";
import { Switch } from "./Switch";

export type LogKind = "info" | "phase" | "progress" | "success" | "error";

export interface LogEntry {
  id: number;
  time: string;
  text: string;
  kind: LogKind;
}

const DOT: Record<LogKind, string> = {
  info: "bg-slate-300",
  phase: "bg-blue-500",
  progress: "bg-violet-400",
  success: "bg-emerald-500",
  error: "bg-red-500",
};

/** Scrolling, timestamped feed of raw run events with an auto-scroll toggle. */
export function EventLog({
  entries,
  onClear,
}: {
  entries: LogEntry[];
  onClear: () => void;
}) {
  const { t } = useI18n();
  const [autoScroll, setAutoScroll] = useState(true);
  // Scrolled directly on this element (never scrollIntoView): that call can
  // bubble to the page's own scroll container and drag the whole viewport
  // around as entries stream in. scrollTop/scrollTo here only ever moves this box.
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = scrollRef.current;
    if (!autoScroll || !el) return;
    const reduceMotion =
      typeof window !== "undefined" &&
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    el.scrollTo({
      top: el.scrollHeight,
      behavior: reduceMotion ? "auto" : "smooth",
    });
  }, [entries, autoScroll]);

  return (
    <div className="card flex min-h-0 flex-1 flex-col overflow-hidden">
      <div className="flex shrink-0 items-center justify-between border-b border-slate-100 px-5 py-4 dark:border-slate-800">
        <div className="flex min-w-0 items-center gap-3">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center text-accent">
            <ScrollText size={28} strokeWidth={1.8} />
          </span>
          <div className="min-w-0">
            <h2 className="font-display text-base font-semibold text-slate-800 dark:text-slate-100">
              {t("event.title")}
            </h2>
            <p className="mt-0.5 truncate font-mono text-[11px] text-slate-400">
              {entries.length} event{entries.length === 1 ? "" : "s"}{" "}
              {t("event.received")}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <label className="flex items-center gap-1.5 text-xs text-slate-500 dark:text-slate-400">
            {t("event.auto")}
            <Switch
              checked={autoScroll}
              onChange={setAutoScroll}
              label={t("event.toggle")}
              size="sm"
            />
          </label>
          <button
            type="button"
            onClick={onClear}
            className="rounded-md border border-slate-200 px-2.5 py-1 text-xs font-medium text-slate-500 transition hover:bg-slate-50 dark:border-slate-700 dark:hover:bg-slate-800"
          >
            {t("event.clear")}
          </button>
        </div>
      </div>

      <div
        ref={scrollRef}
        className="fancy-scrollbar min-h-0 flex-1 overflow-y-auto px-5 py-4 pr-4"
      >
        {entries.length === 0 ? (
          <p className="py-6 text-sm text-slate-400">{t("event.empty")}</p>
        ) : (
          <ul className="space-y-1.5">
            {entries.map((entry, index) => {
              const isLatest = index === entries.length - 1;
              return (
                <li
                  key={entry.id}
                  className="flex animate-fade-in items-start gap-2.5 font-mono text-xs"
                >
                  <span className="shrink-0 text-slate-400">{entry.time}</span>
                  <span
                    className={`mt-1 h-1.5 w-1.5 shrink-0 rounded-full ${DOT[entry.kind]} ${isLatest ? "animate-pulse motion-reduce:animate-none" : ""}`}
                  />
                  <span className="text-slate-600 dark:text-slate-300">
                    {entry.text}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}

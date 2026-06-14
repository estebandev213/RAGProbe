import { useEffect, useRef, useState } from "react";
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
  const [autoScroll, setAutoScroll] = useState(true);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (autoScroll) bottomRef.current?.scrollIntoView({ block: "end" });
  }, [entries, autoScroll]);

  return (
    <div className="card flex h-full flex-col p-5">
      <div className="flex items-center justify-between">
        <h2 className="font-display text-base font-semibold text-slate-800 dark:text-slate-100">
          Live event log
        </h2>
        <div className="flex items-center gap-3">
          <label className="flex items-center gap-1.5 text-xs text-slate-500 dark:text-slate-400">
            Auto-scroll
            <Switch
              checked={autoScroll}
              onChange={setAutoScroll}
              label="Toggle auto-scroll"
              size="sm"
            />
          </label>
          <button
            type="button"
            onClick={onClear}
            className="rounded-md border border-slate-200 px-2.5 py-1 text-xs font-medium text-slate-500 transition hover:bg-slate-50 dark:border-slate-700 dark:hover:bg-slate-800"
          >
            Clear
          </button>
        </div>
      </div>

      <div className="mt-3 max-h-[420px] min-h-[200px] flex-1 overflow-y-auto pr-1">
        {entries.length === 0 ? (
          <p className="py-6 text-sm text-slate-400">No events yet.</p>
        ) : (
          <ul className="space-y-1.5">
            {entries.map((entry) => (
              <li
                key={entry.id}
                className="flex items-start gap-2.5 font-mono text-xs"
              >
                <span className="shrink-0 text-slate-400">{entry.time}</span>
                <span
                  className={`mt-1 h-1.5 w-1.5 shrink-0 rounded-full ${DOT[entry.kind]}`}
                />
                <span className="text-slate-600 dark:text-slate-300">
                  {entry.text}
                </span>
              </li>
            ))}
            <div ref={bottomRef} />
          </ul>
        )}
      </div>
    </div>
  );
}

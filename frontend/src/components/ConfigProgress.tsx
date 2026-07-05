import { ChevronRight } from "lucide-react";
import { parseConfigLabel } from "../lib/format";

export interface ConfigProgress {
  label: string;
  done: number;
  total: number;
}

// One palette slot per config (up to the full matrix of six).
const PALETTE = [
  {
    bar: "bg-blue-500",
    badge: "bg-blue-100 text-blue-600",
    pct: "text-blue-600",
  },
  {
    bar: "bg-violet-500",
    badge: "bg-violet-100 text-violet-600",
    pct: "text-violet-600",
  },
  {
    bar: "bg-orange-500",
    badge: "bg-orange-100 text-orange-600",
    pct: "text-orange-600",
  },
  {
    bar: "bg-emerald-500",
    badge: "bg-emerald-100 text-emerald-600",
    pct: "text-emerald-600",
  },
  {
    bar: "bg-rose-500",
    badge: "bg-rose-100 text-rose-600",
    pct: "text-rose-600",
  },
  {
    bar: "bg-cyan-500",
    badge: "bg-cyan-100 text-cyan-600",
    pct: "text-cyan-600",
  },
];

function ConfigRow({
  config,
  index,
}: {
  config: ConfigProgress;
  index: number;
}) {
  const color = PALETTE[index % PALETTE.length];
  const { chunkSize, strategy, overlap } = parseConfigLabel(config.label);
  const percent =
    config.total > 0 ? Math.round((config.done / config.total) * 100) : 0;

  return (
    <div className="flex items-center gap-4 py-3">
      <div
        className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg font-mono text-sm font-semibold ${color.badge}`}
      >
        {index + 1}
      </div>
      <div className="w-44 shrink-0">
        <p className="truncate font-medium text-slate-800 dark:text-slate-100">
          {chunkSize} / {strategy}
        </p>
        <p className="truncate font-mono text-xs text-slate-400">
          chunk={chunkSize} · overlap={overlap} · {strategy}
        </p>
      </div>
      <div className="h-2 flex-1 overflow-hidden rounded-full bg-slate-100 dark:bg-slate-800">
        <div
          className={`h-full rounded-full transition-all duration-500 ${color.bar}`}
          style={{ width: `${percent}%` }}
        />
      </div>
      <div className="w-24 shrink-0 text-right">
        <p className="font-mono text-sm text-slate-700 dark:text-slate-200">
          {config.done} / {config.total}
        </p>
        <p className={`font-mono text-xs font-semibold ${color.pct}`}>
          {percent}%
        </p>
      </div>
      <ChevronRight size={18} className="shrink-0 text-slate-300" />
    </div>
  );
}

/** The "Configurations progress" panel: one bar per config in the matrix. */
export function ConfigProgressList({
  configs,
  totalQuestions,
}: {
  configs: ConfigProgress[];
  totalQuestions: number;
}) {
  return (
    <div className="card p-5">
      <h2 className="font-display text-base font-semibold text-slate-800 dark:text-slate-100">
        Configurations progress
      </h2>

      {/* Column headers mirror the ConfigRow grid so labels sit above their columns. */}
      <div className="mt-3 flex items-center gap-4 text-xs font-medium uppercase tracking-wide text-slate-400">
        <div className="w-9 shrink-0" aria-hidden />
        <span className="w-44 shrink-0">Configuration</span>
        <span className="flex-1">Progress</span>
        <span className="w-24 shrink-0 text-right">Questions</span>
        <span className="w-[18px] shrink-0" aria-hidden />
      </div>

      <div className="mt-1 divide-y divide-slate-100 dark:divide-slate-800">
        {configs.length === 0 ? (
          <p className="py-6 text-center text-sm text-slate-400">
            Waiting for the answering phase to begin…
          </p>
        ) : (
          configs.map((config, index) => (
            <ConfigRow key={config.label} config={config} index={index} />
          ))
        )}
      </div>

      {totalQuestions > 0 && (
        <p className="mt-3 text-center text-xs text-slate-400">
          Each configuration will answer all {totalQuestions} questions
        </p>
      )}
    </div>
  );
}

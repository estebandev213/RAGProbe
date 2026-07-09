import { ChevronRight, SlidersHorizontal } from "lucide-react";
import { parseConfigLabel } from "../lib/format";
import { useI18n } from "../lib/i18n";

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
  live,
}: {
  config: ConfigProgress;
  index: number;
  live: boolean;
}) {
  const color = PALETTE[index % PALETTE.length];
  const { chunkSize, strategy, overlap } = parseConfigLabel(config.label);
  const percent =
    config.total > 0 ? Math.round((config.done / config.total) * 100) : 0;

  return (
    <div className="flex animate-text-rise items-center gap-4 py-3">
      <div className="relative shrink-0">
        {live && (
          <span
            aria-hidden
            className="absolute -inset-1 rounded-xl bg-accent/15 blur-sm motion-reduce:hidden"
          />
        )}
        <div
          className={`relative flex h-9 w-9 items-center justify-center rounded-lg font-mono text-sm font-semibold ${color.badge}`}
        >
          {index + 1}
        </div>
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
  liveLabel,
}: {
  configs: ConfigProgress[];
  /** Label of the config that most recently received a progress update — its
   * badge gets a brief glow to signal "this one's live" (bounded to one at a
   * time so a fast-moving run never lights up more than a single badge). */
  liveLabel?: string | null;
}) {
  const { t } = useI18n();
  return (
    <div className="card flex min-h-0 flex-1 flex-col overflow-hidden">
      <div className="flex shrink-0 items-center gap-3 border-b border-slate-100 px-5 py-4 dark:border-slate-800">
        <span className="flex h-10 w-10 shrink-0 items-center justify-center text-accent">
          <SlidersHorizontal size={28} strokeWidth={1.8} />
        </span>
        <div className="min-w-0">
          <h2 className="font-display text-base font-semibold text-slate-800 dark:text-slate-100">
            {t("progress.title")}
          </h2>
          <p className="mt-0.5 truncate font-mono text-[11px] text-slate-400">
            {configs.length} configuration{configs.length === 1 ? "" : "s"} in{" "}
            {t("progress.matrix")}
          </p>
        </div>
      </div>

      <div className="flex min-h-0 flex-1 flex-col px-5 pb-5">
        {/* Scrolls internally (rather than growing the card) once there are more
          configs than the panel's share of the page has room for. */}
        <div className="fancy-scrollbar min-h-0 flex-1 divide-y divide-slate-100 overflow-y-auto pt-2 dark:divide-slate-800">
          {configs.length === 0 ? (
            <p className="py-6 text-center text-sm text-slate-400">
              {t("progress.waiting")}
            </p>
          ) : (
            configs.map((config, index) => (
              <ConfigRow
                key={config.label}
                config={config}
                index={index}
                live={config.label === liveLabel}
              />
            ))
          )}
        </div>
      </div>
    </div>
  );
}

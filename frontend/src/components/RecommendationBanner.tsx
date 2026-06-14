import { Trophy } from "lucide-react";
import { configColor } from "../lib/configColors";
import { formatLatency, formatScore, strategyDetail } from "../lib/format";
import { bestByMetric, type Metric } from "../lib/leaderboard";
import type { ConfigScore } from "../types";

/** A metric column in the banner's readout strip. */
interface MetricCell {
  key: Metric;
  label: string;
  value: string;
  accent?: boolean;
}

/**
 * The verdict banner: crowns the winning config and shows its headline metrics,
 * badging each one the winner actually leads (§8). When the winner doesn't top a
 * metric, its badge is simply absent — the crown is earned, not assumed.
 */
export function RecommendationBanner({
  winner,
  leaderboard,
  recommendation,
}: {
  winner: ConfigScore;
  leaderboard: ConfigScore[];
  recommendation: string;
}) {
  const best = bestByMetric(leaderboard);
  const color = configColor(0);

  const cells: MetricCell[] = [
    {
      key: "composite",
      label: "Composite Score",
      value: formatScore(winner.composite),
      accent: true,
    },
    {
      key: "correctness",
      label: "Correctness",
      value: formatScore(winner.correctness),
    },
    {
      key: "faithfulness",
      label: "Faithfulness",
      value: formatScore(winner.faithfulness),
    },
    {
      key: "retrieval_hit",
      label: "Retrieval",
      value: formatScore(winner.retrieval_hit),
    },
    {
      key: "mean_latency_ms",
      label: "Avg Latency",
      value: formatLatency(winner.mean_latency_ms),
    },
  ];

  return (
    <div className="card mt-6 overflow-hidden bg-accent-soft/60 p-6 dark:bg-accent/10">
      <div className="flex flex-col gap-6 lg:flex-row lg:items-center lg:justify-between">
        <div className="flex items-center gap-5">
          <div className="flex h-16 w-16 shrink-0 items-center justify-center rounded-full bg-white text-accent shadow-sm dark:bg-slate-900">
            <Trophy size={28} />
          </div>
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.14em] text-accent">
              Recommended configuration
            </p>
            <h2 className="mt-1 font-display text-2xl font-bold tracking-tight text-slate-900 dark:text-white">
              {winner.chunk_size} / {winner.strategy}
              <span className="ml-2 font-mono text-base font-medium text-slate-400">
                {strategyDetail(winner.strategy)}
              </span>
            </h2>
            <p className="mt-1 max-w-md text-sm text-slate-600 dark:text-slate-300">
              {recommendation}
            </p>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-x-6 gap-y-4 sm:grid-cols-3 lg:flex lg:gap-7">
          {cells.map((cell) => (
            <div key={cell.key} className="min-w-[84px]">
              <p className="text-xs font-medium text-slate-500 dark:text-slate-400">
                {cell.label}
              </p>
              <p
                className={`mt-0.5 font-mono text-2xl font-semibold ${
                  cell.accent
                    ? color.text
                    : "text-slate-800 dark:text-slate-100"
                }`}
              >
                {cell.value}
              </p>
              {best[cell.key] === winner.config_id && (
                <span className="mt-1 inline-flex rounded-full bg-emerald-100 px-2 py-0.5 text-[11px] font-semibold text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300">
                  Best
                </span>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

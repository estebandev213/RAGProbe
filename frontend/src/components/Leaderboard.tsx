import { Info } from "lucide-react";
import { configColor } from "../lib/configColors";
import { formatLatency, formatScore, strategyDetail } from "../lib/format";
import type { ConfigScore } from "../types";

/** Rank chip: gold / silver / bronze medals, then plain numerals. */
const MEDAL = [
  "bg-amber-100 text-amber-700 ring-amber-300",
  "bg-slate-200 text-slate-600 ring-slate-300",
  "bg-orange-100 text-orange-700 ring-orange-300",
];

function RankBadge({ rank }: { rank: number }) {
  const medal = MEDAL[rank - 1] ?? "bg-slate-100 text-slate-500 ring-slate-200";
  return (
    <span
      className={`flex h-8 w-8 items-center justify-center rounded-full font-mono text-sm font-semibold ring-1 ${medal} dark:bg-slate-800 dark:text-slate-300 dark:ring-slate-700`}
    >
      {rank}
    </span>
  );
}

/** A score value with a proportional bar beneath it (the instrument readout). */
function ScoreCell({
  value,
  bar,
  fraction,
}: {
  value: string;
  bar: string;
  fraction: number;
}) {
  return (
    <div className="w-20">
      <p className="font-mono text-sm font-semibold text-slate-700 dark:text-slate-200">
        {value}
      </p>
      <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-slate-100 dark:bg-slate-800">
        <div
          className={`h-full rounded-full ${bar}`}
          style={{
            width: `${Math.round(Math.min(1, Math.max(0, fraction)) * 100)}%`,
          }}
        />
      </div>
    </div>
  );
}

function HeaderCell({ label, hint }: { label: string; hint: string }) {
  return (
    <th className="px-3 pb-2 text-left align-bottom font-medium">
      <span className="text-slate-600 dark:text-slate-300">{label}</span>
      <span className="block text-[11px] font-normal text-slate-400">
        {hint}
      </span>
    </th>
  );
}

/**
 * The leaderboard: configs ranked by composite, styled like an instrument
 * readout (§8). Every 0–1 metric carries a proportional bar; latency is shown
 * relative to the slowest config so the fastest reads shortest.
 */
export function Leaderboard({ rows }: { rows: ConfigScore[] }) {
  const maxLatency = Math.max(...rows.map((row) => row.mean_latency_ms), 1);

  return (
    <div className="card p-5">
      <h2 className="flex items-center gap-1.5 font-display text-base font-semibold text-slate-800 dark:text-slate-100">
        Leaderboard
        <Info size={14} className="text-slate-300" />
      </h2>

      <div className="mt-3 overflow-x-auto">
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="border-b border-slate-200 text-xs dark:border-slate-700">
              <th className="px-3 pb-2 text-left font-medium text-slate-400">
                Rank
              </th>
              <th className="px-3 pb-2 text-left font-medium text-slate-400">
                Configuration
              </th>
              <HeaderCell label="Composite ↑" hint="higher is better" />
              <HeaderCell label="Correctness" hint="↑" />
              <HeaderCell label="Faithfulness" hint="↑" />
              <HeaderCell label="Retrieval" hint="↑" />
              <HeaderCell label="Avg Latency" hint="lower is better" />
            </tr>
          </thead>
          <tbody>
            {rows.map((row, index) => {
              const color = configColor(index);
              const winner = index === 0;
              return (
                <tr
                  key={row.config_id}
                  className={`border-b border-slate-100 last:border-0 dark:border-slate-800 ${
                    winner ? "bg-accent-soft/50 dark:bg-accent/10" : ""
                  }`}
                >
                  <td className="px-3 py-3">
                    <RankBadge rank={index + 1} />
                  </td>
                  <td className="px-3 py-3">
                    <p className="font-medium text-slate-800 dark:text-slate-100">
                      {row.chunk_size} / {row.strategy}
                    </p>
                    <p className="font-mono text-xs text-slate-400">
                      {strategyDetail(row.strategy)}
                    </p>
                  </td>
                  <td className="px-3 py-3">
                    <div className="w-20">
                      <p
                        className={`font-mono text-sm font-semibold ${color.text}`}
                      >
                        {formatScore(row.composite)}
                      </p>
                      <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-slate-100 dark:bg-slate-800">
                        <div
                          className={`h-full rounded-full ${color.bar}`}
                          style={{
                            width: `${Math.round(row.composite * 100)}%`,
                          }}
                        />
                      </div>
                    </div>
                  </td>
                  <td className="px-3 py-3">
                    <ScoreCell
                      value={formatScore(row.correctness)}
                      bar={color.bar}
                      fraction={row.correctness}
                    />
                  </td>
                  <td className="px-3 py-3">
                    <ScoreCell
                      value={formatScore(row.faithfulness)}
                      bar={color.bar}
                      fraction={row.faithfulness}
                    />
                  </td>
                  <td className="px-3 py-3">
                    <ScoreCell
                      value={formatScore(row.retrieval_hit)}
                      bar={color.bar}
                      fraction={row.retrieval_hit ?? 0}
                    />
                  </td>
                  <td className="px-3 py-3">
                    <ScoreCell
                      value={formatLatency(row.mean_latency_ms)}
                      bar="bg-slate-300 dark:bg-slate-600"
                      fraction={row.mean_latency_ms / maxLatency}
                    />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

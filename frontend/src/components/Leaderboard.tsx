import {
  ChevronDown,
  ChevronUp,
  ChevronsUpDown,
  Info,
  Medal,
  Trophy,
} from "lucide-react";
import { useMemo, useState } from "react";
import { configColor } from "../lib/configColors";
import { formatLatency, formatScore, strategyDetail } from "../lib/format";
import type { ConfigScore } from "../types";

type SortKey =
  | "composite"
  | "correctness"
  | "faithfulness"
  | "retrieval_hit"
  | "mean_latency_ms";
type SortDir = "asc" | "desc";

/** Metrics where a smaller value ranks better (only latency, so far). */
const ASCENDS_BY_DEFAULT = new Set<SortKey>(["mean_latency_ms"]);

/** Rank chip: gold / silver / bronze podium medals, then plain numerals. */
const PODIUM = [
  {
    Icon: Trophy,
    ring: "from-amber-300 via-amber-400 to-yellow-500",
    tile: "bg-amber-50 text-amber-600 dark:bg-amber-950/40 dark:text-amber-400",
    glow: "shadow-[0_0_0_3px_rgba(251,191,36,0.15)]",
  },
  {
    Icon: Medal,
    ring: "from-slate-300 via-slate-400 to-slate-500",
    tile: "bg-slate-50 text-slate-500 dark:bg-slate-800/60 dark:text-slate-300",
    glow: "shadow-[0_0_0_3px_rgba(148,163,184,0.15)]",
  },
  {
    Icon: Medal,
    ring: "from-orange-300 via-orange-400 to-orange-600",
    tile: "bg-orange-50 text-orange-600 dark:bg-orange-950/40 dark:text-orange-400",
    glow: "shadow-[0_0_0_3px_rgba(251,146,60,0.15)]",
  },
];

function RankBadge({ rank }: { rank: number }) {
  const podium = PODIUM[rank - 1];

  if (podium) {
    const { Icon, ring, tile, glow } = podium;
    return (
      <span
        className={`relative flex h-9 w-9 items-center justify-center rounded-full bg-gradient-to-br p-[1.5px] ${ring} ${glow}`}
      >
        <span
          className={`flex h-full w-full items-center justify-center rounded-full ${tile}`}
        >
          <Icon size={16} strokeWidth={2.25} />
        </span>
      </span>
    );
  }

  return (
    <span className="flex h-9 w-9 items-center justify-center rounded-full bg-slate-100 font-mono text-sm font-semibold text-slate-500 ring-1 ring-slate-200 dark:bg-slate-800 dark:text-slate-300 dark:ring-slate-700">
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

function SortHeaderCell({
  label,
  hint,
  sortKey,
  active,
  dir,
  onSort,
}: {
  label: string;
  hint: string;
  sortKey: SortKey;
  active: boolean;
  dir: SortDir;
  onSort: (key: SortKey) => void;
}) {
  const Chevron = active
    ? dir === "asc"
      ? ChevronUp
      : ChevronDown
    : ChevronsUpDown;
  return (
    <th className="px-3 pb-2 text-left align-bottom font-medium">
      <button
        type="button"
        onClick={() => onSort(sortKey)}
        className={`group inline-flex items-center gap-1 rounded transition hover:text-slate-800 dark:hover:text-slate-100 ${
          active
            ? "text-slate-700 dark:text-slate-200"
            : "text-slate-600 dark:text-slate-300"
        }`}
      >
        {label}
        <Chevron
          size={13}
          className={
            active
              ? "text-accent"
              : "text-slate-300 opacity-0 transition-opacity group-hover:opacity-100 dark:text-slate-600"
          }
        />
      </button>
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
  const [sortKey, setSortKey] = useState<SortKey>("composite");
  const [sortDir, setSortDir] = useState<SortDir>("desc");

  const handleSort = (key: SortKey) => {
    if (key === sortKey) {
      setSortDir((dir) => (dir === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDir(ASCENDS_BY_DEFAULT.has(key) ? "asc" : "desc");
    }
  };

  const sortedRows = useMemo(() => {
    const sorted = [...rows].sort((a, b) => {
      const av = a[sortKey] ?? 0;
      const bv = b[sortKey] ?? 0;
      return av - bv;
    });
    if (sortDir === "desc") sorted.reverse();
    return sorted;
  }, [rows, sortKey, sortDir]);

  // Color and "winner" status track the original composite ranking so a
  // config's identity color stays stable no matter which column is sorted.
  const originalRank = new Map(
    rows.map((row, index) => [row.config_id, index]),
  );

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
              <SortHeaderCell
                label="Composite"
                hint="higher is better"
                sortKey="composite"
                active={sortKey === "composite"}
                dir={sortDir}
                onSort={handleSort}
              />
              <SortHeaderCell
                label="Correctness"
                hint="higher is better"
                sortKey="correctness"
                active={sortKey === "correctness"}
                dir={sortDir}
                onSort={handleSort}
              />
              <SortHeaderCell
                label="Faithfulness"
                hint="higher is better"
                sortKey="faithfulness"
                active={sortKey === "faithfulness"}
                dir={sortDir}
                onSort={handleSort}
              />
              <SortHeaderCell
                label="Retrieval"
                hint="higher is better"
                sortKey="retrieval_hit"
                active={sortKey === "retrieval_hit"}
                dir={sortDir}
                onSort={handleSort}
              />
              <SortHeaderCell
                label="Avg Latency"
                hint="lower is better"
                sortKey="mean_latency_ms"
                active={sortKey === "mean_latency_ms"}
                dir={sortDir}
                onSort={handleSort}
              />
            </tr>
          </thead>
          <tbody>
            {sortedRows.map((row, index) => {
              const compositeRank = originalRank.get(row.config_id) ?? index;
              const color = configColor(compositeRank);
              const winner = compositeRank === 0;
              return (
                <tr
                  key={row.config_id}
                  className={`border-b border-slate-100 last:border-0 dark:border-slate-800 ${
                    winner ? "bg-accent-soft/50 dark:bg-accent/10" : ""
                  }`}
                >
                  <td className="px-3 py-3">
                    <RankBadge rank={compositeRank + 1} />
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

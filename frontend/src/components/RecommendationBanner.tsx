import { Trophy } from "lucide-react";
import { formatScore, strategyDetail } from "../lib/format";
import type { ConfigScore } from "../types";

/**
 * The verdict panel: crowns the winning config and states the recommendation
 * (§8), styled as an instrument readout. Headline metrics live in the
 * leaderboard and highlight cards.
 */
export function RecommendationBanner({
  winner,
  recommendation,
}: {
  winner: ConfigScore;
  recommendation: string;
}) {
  return (
    <div className="card group relative h-full overflow-hidden bg-gradient-to-br from-accent-soft via-accent-soft/40 to-transparent p-6 shadow-sm ring-1 ring-accent/10 transition duration-300 hover:shadow-xl hover:shadow-accent/10 hover:ring-accent/25 dark:from-accent/20 dark:via-accent/10 dark:to-transparent">
      {/* oversized watermark trophy, barely-there texture in the corner */}
      <Trophy
        aria-hidden
        size={168}
        strokeWidth={1}
        className="pointer-events-none absolute -bottom-8 -right-8 rotate-[-12deg] text-accent opacity-[0.05] transition-transform duration-500 group-hover:rotate-[-6deg] dark:opacity-[0.07]"
      />
      {/* a slow diagonal sheen sweeping across the card */}
      <span
        aria-hidden
        className="pointer-events-none absolute inset-0 -translate-x-full bg-gradient-to-r from-transparent via-white/40 to-transparent transition-transform duration-1000 ease-out group-hover:translate-x-full dark:via-white/10"
      />

      <div className="relative flex h-full flex-col gap-3">
        <div className="flex items-center justify-between gap-3">
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-400">
            Recommended configuration
          </p>
          <span className="rounded-full bg-white/70 px-2.5 py-1 font-mono text-xs font-semibold text-accent shadow-sm ring-1 ring-accent/15 dark:bg-slate-900/50 dark:ring-accent/20">
            {formatScore(winner.composite)} composite
          </span>
        </div>

        <div className="flex items-center gap-6 mb-2">
          <div className="relative flex h-24 w-24 shrink-0 items-center justify-center text-accent">
            <span
              aria-hidden
              className="absolute h-16 w-16 rounded-full bg-amber-400/30 blur-xl dark:bg-amber-400/20"
            />
            <Trophy
              size={64}
              strokeWidth={1.6}
              className="relative animate-trophy-float text-amber-500 drop-shadow-[0_2px_6px_rgba(251,191,36,0.45)] motion-reduce:animate-none dark:text-amber-400"
            />
          </div>

          {/* Config as a two-segment instrument readout. */}
          <div className="flex items-end gap-5">
            <div>
              <p className="text-[10px] font-medium uppercase tracking-[0.16em] text-slate-400">
                Chunk size
              </p>
              <p className="font-mono text-6xl font-bold leading-none tracking-tight text-slate-900 dark:text-white">
                {winner.chunk_size}
              </p>
            </div>
            <span className="pb-1.5 font-mono text-4xl font-light text-slate-300 dark:text-slate-600">
              /
            </span>
            <div>
              <p className="text-[10px] font-medium uppercase tracking-[0.16em] text-slate-400">
                Strategy
              </p>
              <p className="font-display text-5xl font-bold capitalize leading-none tracking-tight text-slate-900 dark:text-white">
                {winner.strategy}
              </p>
            </div>
          </div>
        </div>

        <p className="max-w-md text-sm leading-relaxed text-slate-600 dark:text-slate-300">
          {recommendation}
        </p>
      </div>
    </div>
  );
}

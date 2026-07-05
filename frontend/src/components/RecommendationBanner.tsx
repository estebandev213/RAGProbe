import { Trophy } from "lucide-react";
import { strategyDetail } from "../lib/format";
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
    <div className="card relative h-full overflow-hidden bg-gradient-to-br from-accent-soft via-accent-soft/40 to-transparent p-6 dark:from-accent/20 dark:via-accent/10 dark:to-transparent">
      <div className="relative flex h-full flex-col justify-center gap-5">
        <p className="inline-flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.18em] text-accent">
          <span className="relative flex h-2 w-2">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-accent/60 [animation-duration:2.4s] motion-reduce:hidden" />
            <span className="relative inline-flex h-2 w-2 rounded-full bg-accent" />
          </span>
          Recommended configuration
        </p>

        <div className="flex items-center gap-5">
          <div className="flex h-16 w-16 shrink-0 items-center justify-center text-accent">
            <Trophy
              size={44}
              strokeWidth={1.75}
              className="animate-trophy-float motion-reduce:animate-none"
            />
          </div>

          {/* Config as a two-segment instrument readout. */}
          <div className="flex items-end gap-4">
            <div>
              <p className="text-[10px] font-medium uppercase tracking-[0.16em] text-slate-400">
                Chunk size
              </p>
              <p className="font-mono text-4xl font-bold leading-none tracking-tight text-slate-900 dark:text-white">
                {winner.chunk_size}
              </p>
            </div>
            <span className="pb-1 font-mono text-2xl font-light text-slate-300 dark:text-slate-600">
              /
            </span>
            <div>
              <p className="text-[10px] font-medium uppercase tracking-[0.16em] text-slate-400">
                Strategy
              </p>
              <p className="font-display text-3xl font-bold capitalize leading-none tracking-tight text-slate-900 dark:text-white">
                {winner.strategy}
              </p>
            </div>
          </div>
        </div>

        <p className="font-mono text-xs uppercase tracking-wider text-accent/80">
          {strategyDetail(winner.strategy)}
        </p>

        <p className="max-w-md text-sm leading-relaxed text-slate-600 dark:text-slate-300">
          {recommendation}
        </p>
      </div>
    </div>
  );
}

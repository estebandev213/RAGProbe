/** Which config holds the best value for each leaderboard metric. */

import type { ConfigScore } from "../types";

export type Metric =
  | "composite"
  | "correctness"
  | "faithfulness"
  | "retrieval_hit"
  | "mean_latency_ms";

/** Metrics where a lower value is better (just latency, for now). */
const LOWER_IS_BETTER: ReadonlySet<Metric> = new Set<Metric>([
  "mean_latency_ms",
]);

/**
 * The `config_id` that wins each metric — max, or min for latency. Null-valued
 * metrics (e.g. retrieval for a config that answered no answerable question) are
 * skipped; a metric with no comparable value resolves to `null`.
 */
export function bestByMetric(
  rows: ConfigScore[],
): Record<Metric, string | null> {
  const metrics: Metric[] = [
    "composite",
    "correctness",
    "faithfulness",
    "retrieval_hit",
    "mean_latency_ms",
  ];
  const best: Record<Metric, string | null> = {
    composite: null,
    correctness: null,
    faithfulness: null,
    retrieval_hit: null,
    mean_latency_ms: null,
  };

  for (const metric of metrics) {
    const lower = LOWER_IS_BETTER.has(metric);
    let bestValue = lower ? Infinity : -Infinity;
    for (const row of rows) {
      const value = row[metric];
      if (value === null) continue;
      if (lower ? value < bestValue : value > bestValue) {
        bestValue = value;
        best[metric] = row.config_id;
      }
    }
  }
  return best;
}

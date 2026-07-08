import type { JudgeConfidence } from "../types";

/** Shared confidence-badge treatment for the judge — used by the failure
 * explorer's grade rows and the live run transcript's judge turns, so a
 * confidence level looks the same wherever it appears. */
export const CONFIDENCE_STYLE: Record<JudgeConfidence, string> = {
  low: "bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300",
  medium:
    "bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300",
  high: "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300",
};

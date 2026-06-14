import { BarChart3 } from "lucide-react";
import { Link, useParams } from "react-router-dom";

/**
 * Placeholder for the report card. The leaderboard, breakdown chart, and failure
 * explorer are built in the next commit against the aggregation endpoints (§8).
 */
export function ReportPage() {
  const { runId = "" } = useParams();
  return (
    <div className="animate-fade-in">
      <h1 className="font-display text-4xl font-bold tracking-tight text-slate-900 dark:text-white">
        Report card
      </h1>
      <p className="mt-2 text-sm text-slate-500 dark:text-slate-400">
        Run ID:{" "}
        <span className="font-mono text-slate-700 dark:text-slate-200">
          {runId}
        </span>
      </p>

      <div className="card mt-8 flex flex-col items-center gap-3 p-12 text-center">
        <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-accent-soft text-accent">
          <BarChart3 size={26} />
        </div>
        <p className="font-display text-lg font-semibold text-slate-800 dark:text-slate-100">
          The report card lands in the next step
        </p>
        <p className="max-w-md text-sm text-slate-500 dark:text-slate-400">
          Grading finished and the results are stored. The leaderboard,
          per-question-type breakdown, and failure explorer render here next.
        </p>
        <Link
          to={`/runs/${runId}`}
          className="mt-2 rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium text-slate-600 transition hover:bg-slate-50 dark:border-slate-600 dark:text-slate-300 dark:hover:bg-slate-800"
        >
          Back to run progress
        </Link>
      </div>
    </div>
  );
}

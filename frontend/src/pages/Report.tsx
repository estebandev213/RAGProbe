import {
  ArrowLeft,
  CheckCircle2,
  Copy,
  ListChecks,
  Search,
  Target,
  Zap,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { ApiRequestError, getReport, getRun } from "../api/client";
import { FailureExplorer } from "../components/FailureExplorer";
import { Leaderboard } from "../components/Leaderboard";
import { RecommendationBanner } from "../components/RecommendationBanner";
import { ScoreBreakdownChart } from "../components/ScoreBreakdownChart";
import {
  formatDateTime,
  formatLatency,
  formatRelative,
  formatScore,
} from "../lib/format";
import { bestByMetric } from "../lib/leaderboard";
import type { ConfigScore, ReportResponse } from "../types";

/** A single highlight tile in the strip beneath the leaderboard and chart. */
function Highlight({
  icon,
  label,
  value,
  caption,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  caption: string;
}) {
  return (
    <div className="card group relative flex items-center justify-between gap-4 overflow-hidden px-5 py-7 transition hover:-translate-y-0.5 hover:shadow-lg">
      <div className="absolute inset-x-0 top-0 h-0.5 bg-accent/25 transition group-hover:bg-accent/60" />
      <div className="min-w-0">
        <p className="text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
          {label}
        </p>
        <p className="mt-1.5 font-mono text-4xl font-semibold tracking-tight text-slate-800 dark:text-slate-100">
          {value}
        </p>
        <p className="truncate text-xs text-slate-400">{caption}</p>
      </div>
      <div className="flex h-14 w-14 shrink-0 items-center justify-center rounded-xl bg-accent-soft text-accent ring-1 ring-accent/15 transition group-hover:ring-accent/30">
        {icon}
      </div>
    </div>
  );
}

function configById(
  rows: ConfigScore[],
  id: string | null,
): ConfigScore | null {
  return rows.find((row) => row.config_id === id) ?? null;
}

export function ReportPage() {
  const { runId = "" } = useParams();
  const [report, setReport] = useState<ReportResponse | null>(null);
  const [created, setCreated] = useState<Date | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refetchReport = useCallback(() => {
    if (!runId) return;
    getReport(runId)
      .then(setReport)
      .catch(() => undefined);
  }, [runId]);

  useEffect(() => {
    if (!runId) return;
    let active = true;
    // State is mutated only inside the async continuations below — a synchronous
    // reset here would trigger a cascading render the effect lint rule forbids.
    Promise.all([getReport(runId), getRun(runId).catch(() => null)])
      .then(([reportResponse, run]) => {
        if (!active) return;
        setReport(reportResponse);
        setError(null);
        if (run) {
          const date = new Date(run.created_at);
          if (!Number.isNaN(date.getTime())) setCreated(date);
        }
      })
      .catch((cause) => {
        if (!active) return;
        setError(
          cause instanceof ApiRequestError
            ? cause.message
            : "Could not load the report.",
        );
      })
      .finally(() => active && setLoading(false));
    return () => {
      active = false;
    };
  }, [runId]);

  const backLink = (
    <Link
      to={`/runs/${runId}`}
      className="inline-flex items-center gap-1.5 text-sm font-medium text-accent hover:underline"
    >
      <ArrowLeft size={16} /> Back to progress
    </Link>
  );

  if (loading) {
    return (
      <div className="animate-fade-in">
        {backLink}
        <div className="card mt-6 flex items-center justify-center p-16 text-sm text-slate-400">
          Loading the report card…
        </div>
      </div>
    );
  }

  if (error || !report) {
    return (
      <div className="animate-fade-in">
        {backLink}
        <div className="card mt-6 flex flex-col items-center gap-2 p-12 text-center">
          <p className="font-display text-lg font-semibold text-slate-800 dark:text-slate-100">
            Couldn't load this report
          </p>
          <p className="max-w-md text-sm text-slate-500 dark:text-slate-400">
            {error ?? "The report is not available yet."}
          </p>
        </div>
      </div>
    );
  }

  const { leaderboard, breakdown } = report;
  const winner = leaderboard[0] ?? null;

  if (!winner) {
    return (
      <div className="animate-fade-in">
        {backLink}
        <div className="card mt-6 flex flex-col items-center gap-2 p-12 text-center">
          <p className="font-display text-lg font-semibold text-slate-800 dark:text-slate-100">
            No graded answers yet
          </p>
          <p className="max-w-md text-sm text-slate-500 dark:text-slate-400">
            This run produced no grades, so there's nothing to rank. Start a new
            evaluation from the upload screen.
          </p>
        </div>
      </div>
    );
  }

  const totalQuestions = breakdown[0]?.by_qtype.reduce(
    (sum, entry) => sum + entry.n,
    0,
  );
  const best = bestByMetric(leaderboard);
  const bestCorrectness = configById(leaderboard, best.correctness);
  const bestRetrieval = configById(leaderboard, best.retrieval_hit);
  const fastest = configById(leaderboard, best.mean_latency_ms);

  return (
    <div className="animate-fade-in">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          {backLink}
          <h1 className="mt-3 font-display text-4xl font-bold tracking-tight text-slate-900 dark:text-white">
            Evaluation report
          </h1>
          <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-slate-500 dark:text-slate-400">
            <span>{totalQuestions} questions</span>
            <span aria-hidden>·</span>
            <span>{leaderboard.length} configurations</span>
            <span aria-hidden>·</span>
            <span className="inline-flex items-center gap-1 text-emerald-600 dark:text-emerald-400">
              <CheckCircle2 size={14} />
              Completed{created ? ` ${formatRelative(created)}` : ""}
            </span>
          </div>
        </div>

        <div className="card flex items-start gap-8 px-5 py-3">
          <div>
            <p className="text-xs text-slate-400">Run ID</p>
            <div className="flex items-center gap-1.5">
              <span className="font-mono text-sm text-slate-700 dark:text-slate-200">
                {runId}
              </span>
              <button
                type="button"
                aria-label="Copy run id"
                onClick={() => navigator.clipboard?.writeText(runId)}
                className="text-slate-400 transition hover:text-slate-700 dark:hover:text-slate-200"
              >
                <Copy size={14} />
              </button>
            </div>
          </div>
          {created && (
            <div>
              <p className="text-xs text-slate-400">Date</p>
              <p className="font-mono text-sm text-slate-700 dark:text-slate-200">
                {formatDateTime(created)}
              </p>
            </div>
          )}
        </div>
      </div>

      <RecommendationBanner
        winner={winner}
        leaderboard={leaderboard}
        recommendation={report.recommendation}
      />

      <div className="mt-6 grid gap-6 xl:grid-cols-2">
        <Leaderboard rows={leaderboard} />
        <ScoreBreakdownChart breakdown={breakdown} />
      </div>

      <div className="mt-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Highlight
          icon={<Target size={20} />}
          label="Highest correctness"
          value={formatScore(bestCorrectness?.correctness ?? null)}
          caption={bestCorrectness?.label ?? "—"}
        />
        <Highlight
          icon={<Search size={20} />}
          label="Best retrieval"
          value={formatScore(bestRetrieval?.retrieval_hit ?? null)}
          caption={bestRetrieval?.label ?? "—"}
        />
        <Highlight
          icon={<Zap size={20} />}
          label="Lowest latency"
          value={fastest ? formatLatency(fastest.mean_latency_ms) : "—"}
          caption={fastest?.label ?? "—"}
        />
        <a
          href="#failures"
          className="card group relative flex items-center justify-between gap-4 overflow-hidden bg-accent-soft/60 px-5 py-7 transition hover:-translate-y-0.5 hover:bg-accent-soft hover:shadow-lg dark:bg-accent/10 dark:hover:bg-accent/20"
        >
          <div className="absolute inset-x-0 top-0 h-0.5 bg-accent/25 transition group-hover:bg-accent/60" />
          <div className="min-w-0">
            <p className="font-display text-lg font-semibold text-slate-800 dark:text-slate-100">
              Inspect failures
            </p>
            <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
              Explore where each configuration succeeded and failed.
            </p>
          </div>
          <div className="flex h-14 w-14 shrink-0 items-center justify-center rounded-xl bg-white text-accent ring-1 ring-accent/15 transition group-hover:ring-accent/30 dark:bg-slate-900">
            <ListChecks size={20} />
          </div>
        </a>
      </div>

      <FailureExplorer
        runId={runId}
        leaderboard={leaderboard}
        onGradeChanged={refetchReport}
      />

      <p className="mt-6 text-center text-xs text-slate-400">
        Scores are LLM-judged and may vary. Review failures for details.
      </p>
    </div>
  );
}

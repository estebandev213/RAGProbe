import {
  AlertCircle,
  CheckCircle2,
  ChevronRight,
  FileText,
  Loader2,
} from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { ApiRequestError, listRuns } from "../api/client";
import { formatDateTime, formatRelative } from "../lib/format";
import type { RunStatus, RunSummary } from "../types";

/** Human label per run status (phase labels mirror RunProgress's `PHASES`). */
const STATUS_LABEL: Record<RunStatus, string> = {
  pending: "Queued",
  generating_exam: "Generating exam",
  indexing: "Indexing",
  answering: "Answering",
  judging: "Judging",
  done: "Completed",
  error: "Failed",
};

/** "1 doc" / "3 docs" — pluralize a count against a singular noun. */
function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

type StatusKind = "done" | "error" | "running";

function statusKind(status: RunStatus): StatusKind {
  if (status === "done") return "done";
  if (status === "error") return "error";
  return "running";
}

interface StatusVisual {
  Icon: typeof CheckCircle2;
  tile: string;
  ring: string;
  badge: string;
  bar: string;
  dot: string;
  spin: boolean;
  pulse: boolean;
}

const STATUS_VISUAL: Record<StatusKind, StatusVisual> = {
  done: {
    Icon: CheckCircle2,
    tile: "bg-emerald-50 text-emerald-600 dark:bg-emerald-500/10 dark:text-emerald-400",
    ring: "ring-emerald-500/20 dark:ring-emerald-400/20",
    badge:
      "bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-400",
    bar: "bg-emerald-400 dark:bg-emerald-500/70",
    dot: "bg-emerald-500",
    spin: false,
    pulse: false,
  },
  error: {
    Icon: AlertCircle,
    tile: "bg-red-50 text-red-600 dark:bg-red-500/10 dark:text-red-400",
    ring: "ring-red-500/20 dark:ring-red-400/20",
    badge: "bg-red-50 text-red-700 dark:bg-red-500/10 dark:text-red-400",
    bar: "bg-red-400 dark:bg-red-500/70",
    dot: "bg-red-500",
    spin: false,
    pulse: false,
  },
  running: {
    Icon: Loader2,
    tile: "bg-amber-50 text-amber-600 dark:bg-amber-500/10 dark:text-amber-400",
    ring: "ring-amber-500/20 dark:ring-amber-400/20",
    badge:
      "bg-amber-50 text-amber-700 dark:bg-amber-500/10 dark:text-amber-400",
    bar: "bg-amber-400 dark:bg-amber-500/70",
    dot: "bg-amber-500",
    spin: true,
    pulse: true,
  },
};

/** Page heading with a subtitle and a shortcut back to a fresh evaluation. */
function Header({ subtitle }: { subtitle: string }) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-4">
      <div>
        <h1 className="font-display text-4xl font-bold tracking-tight text-slate-900 dark:text-white">
          History
        </h1>
        <p className="mt-2 text-sm text-slate-500 dark:text-slate-400">
          {subtitle}
        </p>
      </div>
      <Link
        to="/"
        className="rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 shadow-sm transition hover:bg-slate-50 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-200 dark:hover:bg-slate-700"
      >
        New evaluation
      </Link>
    </div>
  );
}

/** A single source-document chip. */
function DocChip({ children }: { children: ReactNode }) {
  return (
    <span className="inline-flex max-w-[16rem] items-center gap-1 rounded-md border border-slate-200/70 bg-slate-50 px-1.5 py-0.5 font-mono text-[11px] text-slate-500 transition group-hover:border-slate-300 dark:border-slate-700/60 dark:bg-slate-800/60 dark:text-slate-400 dark:group-hover:border-slate-600">
      {children}
    </span>
  );
}

/** One run as a clickable log entry: completed → report, otherwise → progress. */
function RunRow({ run }: { run: RunSummary }) {
  const created = new Date(run.created_at);
  const validDate = !Number.isNaN(created.getTime());
  const target =
    run.status === "done" ? `/runs/${run.id}/report` : `/runs/${run.id}`;
  const { Icon, tile, ring, badge, bar, dot, spin, pulse } =
    STATUS_VISUAL[statusKind(run.status)];
  const shownDocs = run.document_names.slice(0, 3);
  const extraDocs = run.document_names.length - shownDocs.length;

  return (
    <li>
      <Link
        to={target}
        className="card group relative flex items-start gap-4 overflow-hidden py-4 pl-6 pr-5 transition duration-200 hover:-translate-y-0.5 hover:border-accent/40 hover:shadow-xl hover:shadow-accent/5"
      >
        {/* status accent rail */}
        <span
          aria-hidden
          className={`absolute inset-y-0 left-0 w-1 ${bar} opacity-80 transition-opacity group-hover:opacity-100`}
        />

        {/* status icon tile, with a live ping for in-progress runs */}
        <div className="relative mt-0.5 shrink-0">
          <div
            className={`flex h-11 w-11 items-center justify-center rounded-xl shadow-sm ring-1 ring-inset ${tile} ${ring}`}
          >
            <Icon
              size={20}
              className={
                spin ? "animate-spin motion-reduce:animate-none" : undefined
              }
            />
          </div>
          {pulse && (
            <span
              aria-hidden
              className="absolute -right-0.5 -top-0.5 flex h-2.5 w-2.5"
            >
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-amber-400 opacity-75 motion-reduce:animate-none" />
              <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-amber-400" />
            </span>
          )}
        </div>

        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-3">
            <p className="truncate font-display text-[15px] font-semibold tracking-tight text-slate-900 dark:text-white">
              {run.title}
            </p>
            <div className="flex shrink-0 items-center gap-2">
              <span
                className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium ${badge}`}
              >
                <span className={`h-1.5 w-1.5 rounded-full ${dot}`} />
                {STATUS_LABEL[run.status]}
              </span>
              <ChevronRight
                size={18}
                className="text-slate-300 transition group-hover:translate-x-0.5 group-hover:text-accent dark:text-slate-600"
              />
            </div>
          </div>

          <p className="mt-1 flex flex-wrap items-center gap-x-2 font-mono text-xs tabular-nums text-slate-400">
            {validDate && <span>{formatDateTime(created)}</span>}
            {validDate && <span aria-hidden>·</span>}
            {validDate && <span>{formatRelative(created)}</span>}
            {validDate && <span aria-hidden>·</span>}
            <span>{plural(run.n_questions, "question")}</span>
            <span aria-hidden>·</span>
            <span>{plural(run.n_configs, "config")}</span>
            {run.demo_mode && (
              <>
                <span aria-hidden>·</span>
                <span className="rounded bg-slate-100 px-1 text-[10px] font-medium uppercase tracking-wide text-slate-400 dark:bg-slate-800">
                  demo
                </span>
              </>
            )}
          </p>

          {run.document_names.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {shownDocs.map((name, i) => (
                <DocChip key={`${i}-${name}`}>
                  <FileText size={11} className="shrink-0 text-slate-400" />
                  <span className="truncate">{name}</span>
                </DocChip>
              ))}
              {extraDocs > 0 && <DocChip>+{extraDocs} more</DocChip>}
            </div>
          )}
        </div>
      </Link>
    </li>
  );
}

/** Empty state: no runs recorded yet. */
function EmptyState() {
  return (
    <div className="animate-fade-in">
      <h1 className="font-display text-4xl font-bold tracking-tight text-slate-900 dark:text-white">
        History
      </h1>
      <div className="card mt-8 flex flex-col items-center gap-3 p-12 text-center">
        <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-accent-soft text-accent">
          <FileText size={26} />
        </div>
        <p className="font-display text-lg font-semibold text-slate-800 dark:text-slate-100">
          No runs yet
        </p>
        <p className="max-w-md text-sm text-slate-500 dark:text-slate-400">
          Every evaluation you run shows up here. Start one from the upload
          screen and it will be one click away afterwards.
        </p>
        <Link
          to="/"
          className="mt-2 rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white transition hover:bg-accent-fg"
        >
          New evaluation
        </Link>
      </div>
    </div>
  );
}

/** History screen: a run log linking each evaluation to its report (§8). */
export function HistoryPage() {
  const [runs, setRuns] = useState<RunSummary[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    listRuns()
      .then((rows) => {
        if (!active) return;
        setRuns(rows);
        setError(null);
      })
      .catch((cause) => {
        if (!active) return;
        setError(
          cause instanceof ApiRequestError
            ? cause.message
            : "Could not load run history.",
        );
      })
      .finally(() => active && setLoading(false));
    return () => {
      active = false;
    };
  }, []);

  if (loading) {
    return (
      <div className="animate-fade-in">
        <Header subtitle="Past evaluations, newest first." />
        <div className="card mt-8 flex items-center justify-center p-16 text-sm text-slate-400">
          Loading run history…
        </div>
      </div>
    );
  }

  if (error || !runs) {
    return (
      <div className="animate-fade-in">
        <Header subtitle="Past evaluations, newest first." />
        <div className="card mt-8 flex flex-col items-center gap-2 p-12 text-center">
          <p className="font-display text-lg font-semibold text-slate-800 dark:text-slate-100">
            Couldn't load run history
          </p>
          <p className="max-w-md text-sm text-slate-500 dark:text-slate-400">
            {error ?? "The run history is not available right now."}
          </p>
        </div>
      </div>
    );
  }

  if (runs.length === 0) {
    return <EmptyState />;
  }

  const completed = runs.filter((run) => run.status === "done").length;
  const noun = runs.length === 1 ? "evaluation" : "evaluations";

  return (
    <div className="animate-fade-in">
      <Header subtitle={`${runs.length} ${noun} · ${completed} completed`} />
      <ul className="mt-8 space-y-3">
        {runs.map((run) => (
          <RunRow key={run.id} run={run} />
        ))}
      </ul>
    </div>
  );
}

import {
  AlertTriangle,
  Check,
  ChevronDown,
  ChevronRight,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { ApiRequestError, getFailures, overrideGrade } from "../api/client";
import { configColor } from "../lib/configColors";
import { formatScore } from "../lib/format";
import { QTYPE_LABEL, QTYPE_ORDER } from "../lib/qtype";
import type { ConfigScore, FailureRow, JudgeConfidence, QType } from "../types";

const CONFIDENCE_STYLE: Record<JudgeConfidence, string> = {
  low: "bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300",
  medium:
    "bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300",
  high: "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300",
};

const SCORE_OPTIONS = [0, 0.5, 1];

/** A pass/fail pill for one of the three metrics in the collapsed row. */
function MetricPill({ label, failed }: { label: string; failed: boolean }) {
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium ${
        failed
          ? "bg-rose-100 text-rose-600 dark:bg-rose-900/40 dark:text-rose-300"
          : "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300"
      }`}
    >
      {failed ? <X size={11} /> : <Check size={11} />}
      {label}
    </span>
  );
}

/** Three-way override control for one metric (0 / 0.5 / 1). */
function OverrideControl({
  label,
  value,
  disabled,
  onPick,
}: {
  label: string;
  value: number;
  disabled: boolean;
  onPick: (score: number) => void;
}) {
  return (
    <div className="flex items-center gap-2">
      <span className="w-24 text-xs font-medium text-slate-500 dark:text-slate-400">
        {label}
      </span>
      <div className="flex gap-1">
        {SCORE_OPTIONS.map((option) => {
          const active = option === value;
          return (
            <button
              key={option}
              type="button"
              disabled={disabled}
              onClick={() => onPick(option)}
              className={`rounded-md px-2.5 py-1 font-mono text-xs font-semibold transition disabled:opacity-50 ${
                active
                  ? "bg-accent text-white"
                  : "bg-slate-100 text-slate-600 hover:bg-slate-200 dark:bg-slate-800 dark:text-slate-300 dark:hover:bg-slate-700"
              }`}
            >
              {option}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function FailureCard({
  row,
  expanded,
  onToggle,
  colorIndex,
  busy,
  onOverride,
}: {
  row: FailureRow;
  expanded: boolean;
  onToggle: () => void;
  colorIndex: number;
  busy: boolean;
  onOverride: (patch: { correctness?: number; faithfulness?: number }) => void;
}) {
  const color = configColor(colorIndex);
  return (
    <div className="overflow-hidden rounded-xl border border-slate-200 dark:border-slate-700">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={expanded}
        className="flex w-full items-center gap-3 px-4 py-3 text-left transition hover:bg-slate-50 dark:hover:bg-slate-800/50"
      >
        {expanded ? (
          <ChevronDown size={16} className="shrink-0 text-slate-400" />
        ) : (
          <ChevronRight size={16} className="shrink-0 text-slate-400" />
        )}
        <span
          className={`shrink-0 rounded-md px-2 py-0.5 font-mono text-xs font-semibold text-white ${color.bar}`}
        >
          {row.config_label}
        </span>
        <span className="shrink-0 rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-medium text-slate-600 dark:bg-slate-800 dark:text-slate-300">
          {QTYPE_LABEL[row.qtype]}
        </span>
        <span className="min-w-0 flex-1 truncate text-sm text-slate-700 dark:text-slate-200">
          {row.question}
        </span>
        {row.overridden && (
          <span className="shrink-0 rounded-full bg-accent-soft px-2 py-0.5 text-[11px] font-medium text-accent">
            Overridden
          </span>
        )}
        <span className="shrink-0 font-mono text-sm font-semibold text-slate-700 dark:text-slate-200">
          {formatScore(row.composite)}
        </span>
      </button>

      {expanded && (
        <div className="space-y-4 border-t border-slate-100 px-4 py-4 text-sm dark:border-slate-800">
          <div className="flex flex-wrap gap-2">
            <MetricPill label="Correctness" failed={row.correctness_failed} />
            <MetricPill label="Faithfulness" failed={row.faithfulness_failed} />
            {row.retrieval_hit !== null && (
              <MetricPill label="Retrieval" failed={row.retrieval_failed} />
            )}
          </div>

          <Field label="Question">{row.question}</Field>
          <Field label="Gold answer">
            <span className="font-mono text-xs">{row.gold_answer}</span>
          </Field>
          <Field label="Model answer">{row.answer_text}</Field>

          {row.gold_span_hits.length > 0 && (
            <div>
              <p className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-slate-400">
                Gold spans
              </p>
              <div className="flex flex-wrap gap-2">
                {row.gold_span_hits.map((hit, index) => (
                  <span
                    key={`${hit.span.start_char}-${index}`}
                    className={`inline-flex items-center gap-1 rounded-md px-2 py-0.5 font-mono text-[11px] ${
                      hit.hit
                        ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300"
                        : "bg-rose-100 text-rose-600 dark:bg-rose-900/40 dark:text-rose-300"
                    }`}
                  >
                    {hit.hit ? <Check size={11} /> : <X size={11} />}
                    {hit.span.start_char}–{hit.span.end_char}
                  </span>
                ))}
              </div>
            </div>
          )}

          <div>
            <p className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-slate-400">
              Retrieved chunks ({row.retrieved_chunks.length})
            </p>
            <div className="space-y-2">
              {row.retrieved_chunks.map((chunk) => (
                <div
                  key={chunk.chunk_id}
                  className="rounded-lg bg-slate-50 p-2.5 dark:bg-slate-800/50"
                >
                  <p className="mb-1 font-mono text-[11px] text-slate-400">
                    {chunk.document_id} · [{chunk.start_char}–{chunk.end_char}]
                  </p>
                  <p className="line-clamp-3 font-mono text-xs text-slate-600 dark:text-slate-300">
                    {chunk.text}
                  </p>
                </div>
              ))}
            </div>
          </div>

          <div className="rounded-lg border border-slate-200 bg-white p-3 dark:border-slate-700 dark:bg-slate-900/40">
            <div className="flex items-center justify-between">
              <p className="text-xs font-semibold uppercase tracking-wide text-slate-400">
                Judge rationale
              </p>
              <span
                className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${CONFIDENCE_STYLE[row.judge_confidence]}`}
              >
                {row.judge_confidence} confidence
              </span>
            </div>
            <p className="mt-1.5 text-slate-600 dark:text-slate-300">
              {row.judge_rationale}
            </p>
          </div>

          <div className="space-y-2 rounded-lg bg-slate-50 p-3 dark:bg-slate-800/50">
            <p className="text-xs font-semibold uppercase tracking-wide text-slate-400">
              Override grade
            </p>
            <OverrideControl
              label="Correctness"
              value={row.correctness}
              disabled={busy}
              onPick={(score) => onOverride({ correctness: score })}
            />
            <OverrideControl
              label="Faithfulness"
              value={row.faithfulness}
              disabled={busy}
              onPick={(score) => onOverride({ faithfulness: score })}
            />
            <p className="text-[11px] text-slate-400">
              Overriding a metric re-aggregates the leaderboard.
            </p>
          </div>
        </div>
      )}
    </div>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-400">
        {label}
      </p>
      <p className="text-slate-700 dark:text-slate-200">{children}</p>
    </div>
  );
}

/**
 * Failure explorer (§8): every graded answer, ranked worst-first and filterable
 * by config and question type, each row drilling into retrieved chunks, judge
 * rationale, and a manual grade override that re-aggregates the leaderboard.
 *
 * Rows are fetched once and filtered client-side (demo scale is tiny); an
 * override patches the server then refetches both these rows and the report.
 */
export function FailureExplorer({
  runId,
  leaderboard,
  onGradeChanged,
}: {
  runId: string;
  leaderboard: ConfigScore[];
  onGradeChanged: () => void;
}) {
  const [rows, setRows] = useState<FailureRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [configId, setConfigId] = useState<string>("all");
  const [qtype, setQtype] = useState<QType | "all">("all");
  const [onlyFailures, setOnlyFailures] = useState(true);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  // A stable config_id → color-index map matching leaderboard order.
  const colorIndex = useMemo(() => {
    const map: Record<string, number> = {};
    leaderboard.forEach((config, index) => {
      map[config.config_id] = index;
    });
    return map;
  }, [leaderboard]);

  // State is set only inside the async continuations so the effect that calls
  // this never mutates state synchronously (the set-state-in-effect rule).
  const load = useCallback(() => {
    let active = true;
    getFailures(runId)
      .then((response) => {
        if (!active) return;
        setRows(response.failures);
        setError(null);
      })
      .catch((cause) => {
        if (!active) return;
        setError(
          cause instanceof ApiRequestError
            ? cause.message
            : "Could not load failures.",
        );
      })
      .finally(() => active && setLoading(false));
    return () => {
      active = false;
    };
  }, [runId]);

  useEffect(() => load(), [load]);

  const visible = rows.filter((row) => {
    if (configId !== "all" && row.config_id !== configId) return false;
    if (qtype !== "all" && row.qtype !== qtype) return false;
    if (onlyFailures && !row.is_failure) return false;
    return true;
  });

  async function handleOverride(
    row: FailureRow,
    patch: { correctness?: number; faithfulness?: number },
  ) {
    setBusyId(row.answer_id);
    try {
      await overrideGrade(row.grade_id, patch);
      load();
      onGradeChanged();
    } catch {
      setError("Could not save the override.");
    } finally {
      setBusyId(null);
    }
  }

  return (
    <section id="failures" className="card mt-6 scroll-mt-6 p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="font-display text-base font-semibold text-slate-800 dark:text-slate-100">
          Failure explorer
        </h2>
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <select
            value={configId}
            onChange={(event) => setConfigId(event.target.value)}
            className="rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 text-sm text-slate-700 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-200"
          >
            <option value="all">All configurations</option>
            {leaderboard.map((config) => (
              <option key={config.config_id} value={config.config_id}>
                {config.label}
              </option>
            ))}
          </select>
          <select
            value={qtype}
            onChange={(event) => setQtype(event.target.value as QType | "all")}
            className="rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 text-sm text-slate-700 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-200"
          >
            <option value="all">All question types</option>
            {QTYPE_ORDER.map((type) => (
              <option key={type} value={type}>
                {QTYPE_LABEL[type]}
              </option>
            ))}
          </select>
          <label className="flex items-center gap-1.5 text-xs font-medium text-slate-500 dark:text-slate-400">
            <input
              type="checkbox"
              checked={onlyFailures}
              onChange={(event) => setOnlyFailures(event.target.checked)}
              className="h-4 w-4 rounded border-slate-300 text-accent focus:ring-accent"
            />
            Only failures
          </label>
        </div>
      </div>

      <div className="mt-4 space-y-2">
        {loading ? (
          <p className="py-8 text-center text-sm text-slate-400">
            Loading graded answers…
          </p>
        ) : error ? (
          <div className="flex items-center justify-center gap-2 py-8 text-sm text-rose-600">
            <AlertTriangle size={16} /> {error}
          </div>
        ) : visible.length === 0 ? (
          <p className="py-8 text-center text-sm text-slate-400">
            {onlyFailures
              ? "No failures match these filters — every answer scored a perfect composite."
              : "No graded answers match these filters."}
          </p>
        ) : (
          visible.map((row) => (
            <FailureCard
              key={row.answer_id}
              row={row}
              expanded={expanded === row.answer_id}
              onToggle={() =>
                setExpanded((current) =>
                  current === row.answer_id ? null : row.answer_id,
                )
              }
              colorIndex={colorIndex[row.config_id] ?? 0}
              busy={busyId === row.answer_id}
              onOverride={(patch) => handleOverride(row, patch)}
            />
          ))
        )}
      </div>
    </section>
  );
}

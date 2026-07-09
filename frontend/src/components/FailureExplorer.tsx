import {
  AlertTriangle,
  Check,
  ChevronDown,
  ChevronRight,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { ApiRequestError, getFailures, overrideGrade } from "../api/client";
import { CONFIDENCE_STYLE } from "../lib/confidence";
import { configColor } from "../lib/configColors";
import { formatScore } from "../lib/format";
import { qtypeLabel, useI18n } from "../lib/i18n";
import { QTYPE_LABEL, QTYPE_ORDER } from "../lib/qtype";
import type { ConfigScore, FailureRow, QType } from "../types";

const SCORE_OPTIONS = [0, 0.5, 1];

function formatJudgeRationale(rationale: string): string[] {
  const normalized = rationale
    .replace(
      /\s*(Correctness|Faithfulness)\s*(?::|\u2013|\u2014|-)\s*/gi,
      (_match, label: string) => `\n${label}: `,
    )
    .trim();
  return normalized.split(/\n+/).filter(Boolean);
}

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
  const judgeRationale = formatJudgeRationale(row.judge_rationale);
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
            <div className="mt-2 space-y-1.5 text-slate-600 dark:text-slate-300">
              {judgeRationale.map((line, index) => (
                <p key={`${row.grade_id}-rationale-${index}`}>{line}</p>
              ))}
            </div>
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

/** A styled filter dropdown: roomy padding, custom chevron, accent focus ring. */
function FilterSelect({
  value,
  onChange,
  children,
}: {
  value: string;
  onChange: (value: string) => void;
  children: React.ReactNode;
}) {
  return (
    <div className="relative">
      <select
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="w-full cursor-pointer appearance-none rounded-xl border border-slate-300 bg-white py-2.5 pl-4 pr-10 text-sm font-medium text-slate-700 shadow-sm transition hover:border-accent/50 focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/25 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-200 dark:hover:border-accent/60"
      >
        {children}
      </select>
      <ChevronDown
        size={16}
        className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-slate-400"
      />
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
  const { language, t } = useI18n();
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

  // Group by question so the same question across multiple configs renders
  // side by side instead of as duplicate stacked rows.
  const groupOrder: string[] = [];
  const groupsByQuestion = new Map<string, FailureRow[]>();
  for (const row of visible) {
    if (!groupsByQuestion.has(row.question_id)) {
      groupsByQuestion.set(row.question_id, []);
      groupOrder.push(row.question_id);
    }
    groupsByQuestion.get(row.question_id)!.push(row);
  }
  // Sort each group by the leaderboard's config order so a given config
  // always lands in the same column across every question — never swapping
  // sides depending on fetch order.
  const groups = groupOrder.map((id) =>
    [...groupsByQuestion.get(id)!].sort(
      (a, b) => (colorIndex[a.config_id] ?? 0) - (colorIndex[b.config_id] ?? 0),
    ),
  );

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
          {t("failure.title")}
        </h2>
        <div className="flex flex-wrap items-center gap-3 text-sm">
          <FilterSelect value={configId} onChange={setConfigId}>
            <option value="all">{t("failure.allConfigs")}</option>
            {leaderboard.map((config) => (
              <option key={config.config_id} value={config.config_id}>
                {config.label}
              </option>
            ))}
          </FilterSelect>
          <FilterSelect
            value={qtype}
            onChange={(value) => setQtype(value as QType | "all")}
          >
            <option value="all">{t("failure.allTypes")}</option>
            {QTYPE_ORDER.map((type) => (
              <option key={type} value={type}>
                {qtypeLabel(language, type)}
              </option>
            ))}
          </FilterSelect>
          <label className="flex cursor-pointer items-center gap-2 px-4 py-2.5 text-xs font-medium text-slate-500 transition hover:text-accent dark:text-slate-400 dark:hover:text-accent">
            <input
              type="checkbox"
              checked={onlyFailures}
              onChange={(event) => setOnlyFailures(event.target.checked)}
              className="h-4 w-4 rounded border-slate-300 text-accent focus:ring-accent focus:ring-offset-0"
            />
            {t("failure.only")}
          </label>
        </div>
      </div>

      <div className="mt-4 space-y-2">
        {loading ? (
          <p className="py-8 text-center text-sm text-slate-400">
            {t("failure.loading")}
          </p>
        ) : error ? (
          <div className="flex items-center justify-center gap-2 py-8 text-sm text-rose-600">
            <AlertTriangle size={16} /> {error}
          </div>
        ) : visible.length === 0 ? (
          <p className="py-8 text-center text-sm text-slate-400">
            {onlyFailures
              ? t("failure.noneFailures")
              : t("failure.noneAnswers")}
          </p>
        ) : (
          groups.map((group) => (
            <div
              key={group[0].question_id}
              className={
                group.length > 1
                  ? "grid gap-3 md:grid-cols-2 items-start"
                  : undefined
              }
            >
              {group.map((row) => (
                <FailureCard
                  key={row.answer_id}
                  row={row}
                  expanded={expanded === row.question_id}
                  onToggle={() =>
                    setExpanded((current) =>
                      current === row.question_id ? null : row.question_id,
                    )
                  }
                  colorIndex={colorIndex[row.config_id] ?? 0}
                  busy={busyId === row.answer_id}
                  onOverride={(patch) => handleOverride(row, patch)}
                />
              ))}
            </div>
          ))
        )}
      </div>
    </section>
  );
}

import {
  Boxes,
  ClipboardCheck,
  Files,
  FlaskConical,
  Gavel,
  PlayCircle,
  ScrollText,
  SlidersHorizontal,
  Upload,
} from "lucide-react";
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  ApiRequestError,
  createRun,
  loadSampleDocuments,
  uploadDocument,
} from "../api/client";
import { ConfigEditor } from "../components/ConfigEditor";
import { DocumentRow } from "../components/DocumentRow";
import { Dropzone } from "../components/Dropzone";
import { Switch } from "../components/Switch";
import { hasDuplicateConfigs } from "../lib/configs";
import { qtypeLabel, useI18n } from "../lib/i18n";
import { setActiveRunId } from "../lib/session";
import type { ConfigSpec, DocumentSummary } from "../types";

const MAX_FILES = 5;
const MAX_BYTES = 2 * 1024 * 1024;
const ACCEPTED = new Set(["pdf", "md", "txt"]);

// Config-count caps per mode, mirroring app/core/runner.py. Demo halves the
// ceiling to keep free-tier LLM-call volume low.
const MAX_CONFIGS_DEMO = 2;
const MAX_CONFIGS_FULL = 4;

// Seed matrix the Sandbox editor starts from: mirrors the derived demo default
// (both chunk sizes at the hybrid strategy). Turning demo off only raises the
// cap — it never overwrites what the user has already set up.
const DEFAULT_CONFIGS: ConfigSpec[] = [
  { chunk_size: 400, strategy: "hybrid", top_k: 5 },
  { chunk_size: 800, strategy: "hybrid", top_k: 5 },
];

interface UploadedDoc {
  summary: DocumentSummary;
  sizeBytes: number;
}

const STEPS = [
  { icon: Upload, text: "upload.step.docs" },
  { icon: ScrollText, text: "upload.step.exam" },
  { icon: Boxes, text: "upload.step.configs" },
  { icon: Gavel, text: "upload.step.grade" },
  { icon: ClipboardCheck, text: "upload.step.report" },
];

// The three graded metrics and their weight in the composite score. Mirrors
// the weighting in app/core/scoring.py.
const METRICS = [
  {
    weight: "50%",
    label: "metric.correctness",
    detail: "metric.correctness.detail",
  },
  {
    weight: "30%",
    label: "metric.faithfulness",
    detail: "metric.faithfulness.detail",
  },
  {
    weight: "20%",
    label: "metric.retrieval",
    detail:
      "Gold span ≥50% overlapped by a retrieved chunk. Pure math, no LLM.",
  },
] as const;

// Target mix of auto-generated question types, each stressing a different part
// of the pipeline. Percentages mirror the exam generator's taxonomy.
const TAXONOMY = [
  { label: "factual", pct: 40, bar: "bg-accent", dot: "bg-accent" },
  { label: "multihop", pct: 25, bar: "bg-accent/70", dot: "bg-accent/70" },
  { label: "paraphrase", pct: 20, bar: "bg-accent/45", dot: "bg-accent/45" },
  {
    label: "unanswerable",
    pct: 15,
    bar: "bg-accent/25",
    dot: "bg-accent/25",
  },
] as const;

export function UploadPage() {
  const { language, t } = useI18n();
  const navigate = useNavigate();
  const [docs, setDocs] = useState<UploadedDoc[]>([]);
  const [demoMode, setDemoMode] = useState(true);
  const [configs, setConfigs] = useState<ConfigSpec[]>(DEFAULT_CONFIGS);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const maxConfigs = demoMode ? MAX_CONFIGS_DEMO : MAX_CONFIGS_FULL;
  const duplicateConfigs = hasDuplicateConfigs(configs);

  // Toggling demo on tightens the cap: trim any excess configurations so the
  // list can never exceed what the backend will accept for the mode.
  function changeDemoMode(next: boolean) {
    setDemoMode(next);
    if (next) setConfigs((current) => current.slice(0, MAX_CONFIGS_DEMO));
  }

  async function ingest(files: File[]) {
    setError(null);
    const room = MAX_FILES - docs.length;
    if (room <= 0) {
      setError(`You can upload at most ${MAX_FILES} files.`);
      return;
    }

    const accepted: File[] = [];
    for (const file of files.slice(0, room)) {
      const ext = file.name.split(".").pop()?.toLowerCase() ?? "";
      if (!ACCEPTED.has(ext)) {
        setError(
          `${file.name}: only PDF, Markdown, or Text files are supported.`,
        );
        continue;
      }
      if (file.size > MAX_BYTES) {
        setError(`${file.name}: exceeds the 2MB limit.`);
        continue;
      }
      accepted.push(file);
    }
    if (accepted.length === 0) return;

    setBusy(true);
    try {
      for (const file of accepted) {
        const summary = await uploadDocument(file);
        setDocs((current) => [...current, { summary, sizeBytes: file.size }]);
      }
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : "Upload failed.");
    } finally {
      setBusy(false);
    }
  }

  async function useSamples() {
    setError(null);
    setBusy(true);
    try {
      const summaries = await loadSampleDocuments();
      setDocs(
        summaries.map((summary) => ({
          summary,
          sizeBytes: summary.char_count,
        })),
      );
    } catch (err) {
      setError(
        err instanceof ApiRequestError
          ? err.message
          : "Could not load sample documents.",
      );
    } finally {
      setBusy(false);
    }
  }

  function remove(id: string) {
    setDocs((current) => current.filter((doc) => doc.summary.id !== id));
  }

  async function run() {
    if (docs.length === 0) return;
    setError(null);
    setBusy(true);
    try {
      const summaries = docs.map((doc) => doc.summary);
      const { run_id, n_questions, n_configs } = await createRun(
        summaries.map((summary) => summary.id),
        demoMode,
        configs,
      );
      setActiveRunId(run_id);
      navigate(`/runs/${run_id}`, {
        state: {
          documents: summaries,
          demoMode,
          nQuestions: n_questions,
          nConfigs: n_configs,
        },
      });
    } catch (err) {
      setError(
        err instanceof ApiRequestError
          ? err.message
          : "Could not start the run.",
      );
      setBusy(false);
    }
  }

  const configStatus = `${configs.length} ${
    language === "es"
      ? configs.length === 1
        ? "configuracion"
        : "configuraciones"
      : `configuration${configs.length === 1 ? "" : "s"}`
  } · ${demoMode ? t("upload.mode.demo") : t("upload.mode.full")} ${
    language === "es" ? "modo" : "mode"
  }`;

  return (
    <div className="animate-fade-in">
      <div className="grid gap-10 lg:grid-cols-2 lg:items-center">
        <div>
          <p className="font-display text-xs font-semibold uppercase tracking-[0.18em] text-accent">
            {t("upload.eyebrow")}
          </p>
          <h1 className="mt-3 font-display text-4xl font-bold leading-tight tracking-tight text-slate-900 dark:text-white sm:text-5xl">
            {t("upload.title1")} <br className="hidden md:block" />
            {t("upload.title2")}
          </h1>
          <p className="mt-4 max-w-xl text-slate-500 dark:text-slate-400">
            {t("upload.body")}
          </p>

          <div className="mt-6 max-w-xs">
            <button
              type="button"
              disabled={busy || docs.length === 0 || duplicateConfigs}
              onClick={run}
              className="flex w-full items-center justify-center gap-2 rounded-xl bg-accent px-6 py-3.5 font-display font-semibold text-white shadow-lg shadow-accent/25 transition hover:bg-accent-fg disabled:cursor-not-allowed disabled:opacity-50"
            >
              <PlayCircle size={20} />
              {t("upload.run")}
            </button>
            <p className="mt-2 text-center text-xs text-slate-400">
              {duplicateConfigs ? t("upload.duplicateContinue") : configStatus}
            </p>
          </div>
        </div>

        <ol className="flex items-start gap-4 self-center xl:gap-8">
          {STEPS.map((step, index) => {
            const Icon = step.icon;
            return (
              <li
                key={step.text}
                className="group relative flex flex-1 flex-col items-center text-center"
              >
                {index < STEPS.length - 1 && (
                  <span
                    aria-hidden
                    style={{ animationDelay: `${index * 160 + 260}ms` }}
                    className="absolute left-[calc(50%+2rem)] right-[calc(-50%+1rem)] top-8 h-0.5 origin-left animate-line-grow bg-gradient-to-r from-accent/40 to-accent/10 motion-reduce:animate-none xl:right-[-50%]"
                  />
                )}
                <span
                  style={{ animationDelay: `${index * 160}ms` }}
                  className="relative z-10 flex h-16 w-16 shrink-0 animate-pop-in items-center justify-center rounded-full bg-accent-soft text-accent ring-1 ring-accent/20 transition-transform duration-300 ease-out motion-reduce:animate-none dark:bg-accent/15 dark:text-slate-300 group-hover:-translate-y-1 group-hover:shadow-lg group-hover:shadow-accent/25"
                >
                  <Icon size={28} />
                </span>
                <p
                  style={{ animationDelay: `${index * 160 + 180}ms` }}
                  className="mt-2.5 animate-text-rise font-mono text-[11px] font-semibold uppercase tracking-wider text-accent motion-reduce:animate-none"
                >
                  {t("upload.step")} {index + 1}
                </p>
                <p
                  style={{ animationDelay: `${index * 160 + 220}ms` }}
                  className="mt-1 animate-text-rise text-sm leading-snug text-slate-600 motion-reduce:animate-none dark:text-slate-300"
                >
                  {t(step.text as Parameters<typeof t>[0])}
                </p>
              </li>
            );
          })}
        </ol>
      </div>

      <div className="mt-12 grid gap-8 lg:grid-cols-[1fr_340px] lg:items-start">
        <div className="order-2 flex flex-col gap-4 lg:order-2">
          <div className="card flex items-start gap-4 p-5">
            <div className="flex h-14 w-14 shrink-0 items-center justify-center text-accent">
              <FlaskConical
                size={32}
                strokeWidth={1.75}
                className="animate-float-soft motion-reduce:animate-none"
              />
            </div>
            <div className="flex-1">
              <p className="text-base font-semibold text-slate-800 dark:text-slate-100">
                {demoMode ? t("upload.demo.on") : t("upload.demo.off")}
              </p>
              <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
                {demoMode ? t("upload.demo.onBody") : t("upload.demo.offBody")}
              </p>
            </div>
            <Switch
              checked={demoMode}
              onChange={changeDemoMode}
              label={t("upload.demo.toggle")}
            />
          </div>

          <div className="card p-5">
            <div className="flex items-center gap-2.5">
              <span className="flex shrink-0 items-center justify-center text-accent">
                <SlidersHorizontal size={30} strokeWidth={1.75} />
              </span>
              <p className="font-display text-base font-semibold text-slate-800 dark:text-slate-100">
                {t("upload.scoring")}
              </p>
            </div>

            <p className="mt-5 text-xs font-semibold uppercase tracking-wider text-slate-400">
              {t("upload.composite")}
            </p>
            <ul className="mt-3 flex flex-col gap-4">
              {METRICS.map((metric, index) => (
                <li
                  key={metric.label}
                  style={{ animationDelay: `${index * 90}ms` }}
                  className="group flex items-center gap-4 rounded-xl px-2 py-1.5 -mx-2 animate-text-rise transition-colors duration-200 motion-reduce:animate-none hover:bg-accent-soft/60 dark:hover:bg-accent/10"
                >
                  <span className="w-14 shrink-0 text-right font-mono text-xl font-bold tabular-nums text-accent transition-transform duration-200 group-hover:scale-110">
                    {metric.weight}
                  </span>
                  <span className="flex-1 pl-4">
                    <span className="block text-sm font-semibold text-slate-700 dark:text-slate-200">
                      {t(metric.label as Parameters<typeof t>[0])}
                    </span>
                    <span className="mt-0.5 block text-xs leading-snug text-slate-500 dark:text-slate-400">
                      {metric.label === "metric.correctness"
                        ? t("metric.correctness.detail")
                        : metric.label === "metric.faithfulness"
                          ? t("metric.faithfulness.detail")
                          : t("metric.retrieval.detail")}
                    </span>
                  </span>
                </li>
              ))}
            </ul>

            <div className="mt-6">
              <p className="text-xs font-semibold uppercase tracking-wider text-slate-400">
                {t("upload.taxonomy")}
              </p>
              <div className="mt-3 flex h-2.5 overflow-hidden rounded-full bg-slate-100 dark:bg-slate-800">
                {TAXONOMY.map((slice, index) => (
                  <span
                    key={slice.label}
                    style={{
                      width: `${slice.pct}%`,
                      animationDelay: `${index * 120}ms`,
                    }}
                    className={`origin-left animate-line-grow border-r border-white/40 motion-reduce:animate-none last:border-r-0 dark:border-slate-900/60 ${slice.bar}`}
                  />
                ))}
              </div>
              <ul className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2.5">
                {TAXONOMY.map((slice, index) => (
                  <li
                    key={slice.label}
                    style={{ animationDelay: `${index * 90 + 200}ms` }}
                    className="flex animate-text-rise items-center gap-2 motion-reduce:animate-none"
                  >
                    <span
                      className={`h-2.5 w-2.5 shrink-0 rounded-full ${slice.dot}`}
                    />
                    <span className="flex-1 text-xs text-slate-500 dark:text-slate-400">
                      {qtypeLabel(language, slice.label)}
                    </span>
                    <span className="font-mono text-sm font-bold tabular-nums text-slate-700 dark:text-slate-200">
                      {slice.pct}%
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </div>

        <div className="order-1 flex flex-col gap-6 lg:order-1">
          <div className="card overflow-hidden">
            <div className="flex w-full items-center gap-3 px-5 py-4 text-left">
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-accent-soft text-accent dark:bg-accent/10">
                <Upload size={18} />
              </span>
              <span className="flex-1">
                <span className="block font-display font-semibold text-slate-800 dark:text-slate-100">
                  {t("upload.card.title")}
                </span>
                <span className="mt-0.5 block text-sm text-slate-500 dark:text-slate-400">
                  {t("upload.card.subtitle")}
                </span>
              </span>
              <span className="hidden items-center gap-2 font-mono text-xs text-slate-400 sm:flex">
                <Files size={13} />
                {docs.length}/{MAX_FILES}
              </span>
            </div>

            <div className="border-t border-slate-200/70 px-5 pb-5 pt-4 dark:border-slate-700/60">
              {docs.length === 0 ? (
                <Dropzone
                  onFiles={ingest}
                  disabled={busy}
                  onUseSamples={useSamples}
                />
              ) : (
                <div className="flex flex-col gap-3">
                  {docs.map((doc) => (
                    <DocumentRow
                      key={doc.summary.id}
                      doc={doc.summary}
                      sizeBytes={doc.sizeBytes}
                      onRemove={remove}
                    />
                  ))}
                  {docs.length < MAX_FILES && (
                    <Dropzone compact onFiles={ingest} disabled={busy} />
                  )}
                </div>
              )}

              {error && (
                <p
                  role="alert"
                  className="mt-4 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-900/50 dark:bg-red-950/40 dark:text-red-300"
                >
                  {error}
                </p>
              )}
            </div>
          </div>

          <ConfigEditor
            configs={configs}
            onChange={setConfigs}
            maxConfigs={maxConfigs}
            demoMode={demoMode}
          />
        </div>
      </div>
    </div>
  );
}

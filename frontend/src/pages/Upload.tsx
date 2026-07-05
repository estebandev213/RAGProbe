import { FileText, FlaskConical, PlayCircle } from "lucide-react";
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  ApiRequestError,
  createRun,
  loadSampleDocuments,
  uploadDocument,
} from "../api/client";
import { DocumentRow } from "../components/DocumentRow";
import { Dropzone } from "../components/Dropzone";
import { Switch } from "../components/Switch";
import { setLastRunId } from "../lib/session";
import type { DocumentSummary } from "../types";

const MAX_FILES = 5;
const MAX_BYTES = 2 * 1024 * 1024;
const ACCEPTED = new Set(["pdf", "md", "txt"]);

interface UploadedDoc {
  summary: DocumentSummary;
  sizeBytes: number;
}

const STEPS = [
  "Generate an exam from your docs",
  "Run against multiple RAG configs",
  "Grade every answer with an LLM judge",
  "Get a report with clear recommendations",
];

export function UploadPage() {
  const navigate = useNavigate();
  const [docs, setDocs] = useState<UploadedDoc[]>([]);
  const [demoMode, setDemoMode] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
      );
      setLastRunId(run_id);
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

  return (
    <div className="animate-fade-in">
      <div className="grid gap-8 lg:grid-cols-[1fr_340px] lg:items-center">
        <div>
          <p className="font-display text-xs font-semibold uppercase tracking-[0.18em] text-accent">
            Evaluate your RAG pipelines
          </p>
          <h1 className="mt-3 font-display text-4xl font-bold leading-tight tracking-tight text-slate-900 dark:text-white sm:text-5xl">
            Upload documents and run an evaluation
          </h1>
          <p className="mt-4 max-w-xl text-slate-500 dark:text-slate-400">
            RAGProbe will generate an exam from your documents, run it against
            multiple RAG configurations, and deliver a detailed report card.
          </p>
        </div>

        <div className="flex flex-col gap-4">
          <div className="card flex items-start gap-4 p-5">
            <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-accent-soft text-accent">
              <FlaskConical size={22} />
            </div>
            <div className="flex-1">
              <p className="font-semibold text-slate-800 dark:text-slate-100">
                Demo mode is {demoMode ? "ON" : "OFF"}
              </p>
              <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
                {demoMode
                  ? "Runs a reduced exam over a smaller configuration matrix so the evaluation fits free-tier rate limits. Exact counts are shown when the run starts."
                  : "Runs the full exam across the complete configuration matrix (every chunk size × every retrieval strategy)."}
              </p>
            </div>
            <Switch
              checked={demoMode}
              onChange={setDemoMode}
              label="Toggle demo mode"
            />
          </div>

          <div>
            <button
              type="button"
              disabled={busy || docs.length === 0}
              onClick={run}
              className="flex w-full items-center justify-center gap-2 rounded-xl bg-accent px-6 py-3.5 font-display font-semibold text-white shadow-lg shadow-accent/25 transition hover:bg-accent-fg disabled:cursor-not-allowed disabled:opacity-50"
            >
              <PlayCircle size={20} />
              Run evaluation
            </button>
            <p className="mt-2 text-center text-xs text-slate-400">
              This will start a new evaluation run
            </p>
          </div>
        </div>
      </div>

      <div className="mt-6">
        <h2 className="font-display text-lg font-semibold text-slate-800 dark:text-slate-100">
          Documents ({docs.length}/{MAX_FILES})
        </h2>
        <p className="text-sm text-slate-400">
          You can upload up to 5 files. Max 2MB each.
        </p>

        <div className="card mt-4 p-5">
          <Dropzone
            onFiles={ingest}
            disabled={busy || docs.length >= MAX_FILES}
          />

          {docs.length > 0 && (
            <div className="mt-4 flex flex-col gap-3">
              {docs.map((doc) => (
                <DocumentRow
                  key={doc.summary.id}
                  doc={doc.summary}
                  sizeBytes={doc.sizeBytes}
                  onRemove={remove}
                />
              ))}
            </div>
          )}
        </div>

        {error && (
          <p
            role="alert"
            className="mt-4 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-900/50 dark:bg-red-950/40 dark:text-red-300"
          >
            {error}
          </p>
        )}
      </div>

      <div className="mt-8 grid gap-8 lg:grid-cols-2">
        <div className="flex items-start gap-3">
          <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-accent-soft text-accent">
            <FileText size={20} />
          </div>
          <div>
            <p className="font-semibold text-slate-800 dark:text-slate-100">
              Use sample documents
            </p>
            <p className="mt-0.5 max-w-xs text-sm text-slate-500 dark:text-slate-400">
              Load our sample docs to try RAGProbe in seconds. No setup
              required.
            </p>
          </div>
          <button
            type="button"
            disabled={busy}
            onClick={useSamples}
            className="ml-auto shrink-0 rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 shadow-sm transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-60 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-200"
          >
            Use sample documents
          </button>
        </div>

        <div>
          <p className="font-semibold text-slate-800 dark:text-slate-100">
            What happens next?
          </p>
          <ol className="mt-3 grid gap-2 sm:grid-cols-2">
            {STEPS.map((step, index) => (
              <li
                key={step}
                className="flex items-start gap-2 text-sm text-slate-500 dark:text-slate-400"
              >
                <span className="mt-0.5 font-mono text-xs font-semibold text-accent">
                  {index + 1}
                </span>
                {step}
              </li>
            ))}
          </ol>
        </div>
      </div>
    </div>
  );
}

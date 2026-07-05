import {
  ArrowLeft,
  Copy,
  FileText,
  FlaskConical,
  Layers,
  Timer,
  Wifi,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useLocation, useNavigate, useParams } from "react-router-dom";
import { getRun, subscribeToRun } from "../api/client";
import {
  ConfigProgressList,
  type ConfigProgress,
} from "../components/ConfigProgress";
import { EventLog, type LogEntry, type LogKind } from "../components/EventLog";
import {
  PhaseTimeline,
  type PhaseState,
  type PhaseView,
} from "../components/PhaseTimeline";
import { StatCard } from "../components/StatCard";
import { formatClock, formatElapsed, formatNumber } from "../lib/format";
import { setLastRunId } from "../lib/session";
import type { DocumentSummary, RunEvent, RunStatus } from "../types";

const PHASES: { key: RunStatus; label: string }[] = [
  { key: "generating_exam", label: "Generating exam" },
  { key: "indexing", label: "Indexing" },
  { key: "answering", label: "Answering" },
  { key: "judging", label: "Judging" },
  { key: "done", label: "Done" },
];

interface RunNavState {
  documents?: DocumentSummary[];
  demoMode?: boolean;
  /** Backend-resolved counts from POST /api/runs — no client-side guessing. */
  nQuestions?: number;
  nConfigs?: number;
}

function phaseLogLine(event: RunEvent): { text: string; kind: LogKind } | null {
  if (event.type === "phase") {
    switch (event.phase) {
      case "generating_exam":
        return { text: "Generating exam with LLM…", kind: "phase" };
      case "indexing":
        return { text: "Indexing documents…", kind: "phase" };
      case "answering":
        return { text: "Starting answering phase", kind: "phase" };
      case "judging":
        return { text: "Judging answers…", kind: "phase" };
      default:
        return null;
    }
  }
  if (event.type === "progress") {
    if (event.config_label) {
      return {
        text: `[${event.config_label}] Answering question ${event.done}/${event.total}`,
        kind: "progress",
      };
    }
    return {
      text: `Judging answer ${event.done}/${event.total}`,
      kind: "progress",
    };
  }
  if (event.type === "config_done") {
    return { text: `[${event.config_label}] Completed`, kind: "success" };
  }
  if (event.type === "run_done")
    return { text: "Run complete", kind: "success" };
  if (event.type === "error")
    return { text: event.message ?? "Run failed", kind: "error" };
  return null;
}

export function RunProgressPage() {
  const { runId = "" } = useParams();
  const navigate = useNavigate();
  const navState = (useLocation().state as RunNavState | null) ?? {};

  const [status, setStatus] = useState<RunStatus>("pending");
  const [error, setError] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);
  const [configs, setConfigs] = useState<ConfigProgress[]>([]);
  const [log, setLog] = useState<LogEntry[]>([]);
  const [elapsed, setElapsed] = useState(0);
  const [phaseEntry, setPhaseEntry] = useState<Record<string, number>>({});
  const [startedLabel, setStartedLabel] = useState("");

  const startMsRef = useRef<number>(0);
  const logIdRef = useRef(0);

  const pushLog = useCallback((text: string, kind: LogKind) => {
    const entry: LogEntry = {
      id: logIdRef.current++,
      time: formatClock(new Date()),
      text,
      kind,
    };
    setLog((current) => [...current, entry].slice(-200));
  }, []);

  // Seed the log and remember this run for the sidebar's quick links.
  useEffect(() => {
    if (!runId) return;
    setLastRunId(runId);
    pushLog("Run created", "info");
    if (navState.demoMode !== undefined) {
      pushLog(
        `Demo mode: ${navState.demoMode ? "ON (limits enabled)" : "OFF"}`,
        "info",
      );
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runId]);

  // Snapshot first (covers a reload onto a run already in flight), then stream.
  useEffect(() => {
    if (!runId) return;
    let active = true;

    // Provisional start (refined below from the run's created_at).
    startMsRef.current = Date.now();
    setStartedLabel(formatClock(new Date(startMsRef.current)));

    getRun(runId)
      .then((snapshot) => {
        if (!active) return;
        const started = Date.parse(snapshot.created_at);
        if (!Number.isNaN(started)) {
          startMsRef.current = started;
          setStartedLabel(formatClock(new Date(started)));
        }
        setStatus(snapshot.status);
        if (snapshot.error) setError(snapshot.error);
      })
      .catch(() => undefined);

    const source = subscribeToRun(runId, {
      onEvent: (event) => {
        if (!active) return;
        setConnected(true);
        handleEvent(event);
      },
      onError: () => active && setConnected(false),
    });

    function handleEvent(event: RunEvent) {
      const line = phaseLogLine(event);
      if (line) pushLog(line.text, line.kind);

      if (event.type === "phase" && event.phase) {
        const phase = event.phase;
        setStatus(phase);
        setPhaseEntry((current) =>
          phase in current
            ? current
            : { ...current, [phase]: (Date.now() - startMsRef.current) / 1000 },
        );
      } else if (event.type === "progress" && event.config_label) {
        const label = event.config_label;
        const done = event.done ?? 0;
        const total = event.total ?? 0;
        setConfigs((current) => {
          const existing = current.find((config) => config.label === label);
          if (existing) {
            return current.map((config) =>
              config.label === label ? { ...config, done, total } : config,
            );
          }
          return [...current, { label, done, total }];
        });
      } else if (event.type === "config_done" && event.config_label) {
        const label = event.config_label;
        setConfigs((current) =>
          current.map((config) =>
            config.label === label ? { ...config, done: config.total } : config,
          ),
        );
      } else if (event.type === "run_done") {
        setStatus("done");
        setPhaseEntry((current) =>
          "done" in current
            ? current
            : { ...current, done: (Date.now() - startMsRef.current) / 1000 },
        );
      } else if (event.type === "error") {
        setStatus("error");
        setError(event.message ?? "The run failed.");
      }
    }

    return () => {
      active = false;
      source.close();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runId]);

  // Tick the elapsed clock until the run reaches a terminal state.
  const terminal = status === "done" || status === "error";
  useEffect(() => {
    if (terminal) return;
    const id = window.setInterval(() => {
      setElapsed((Date.now() - startMsRef.current) / 1000);
    }, 1000);
    return () => window.clearInterval(id);
  }, [terminal]);

  // On completion, hand off to the report card.
  useEffect(() => {
    if (status !== "done") return;
    const id = window.setTimeout(() => navigate(`/runs/${runId}/report`), 700);
    return () => window.clearTimeout(id);
  }, [status, runId, navigate]);

  // Prefer counts observed from live progress events; before any arrive, fall
  // back to the run-creation response passed through navigation state. A page
  // opened directly (no state) shows placeholders until events flow.
  const totalQuestions = useMemo(() => {
    const seen = configs.reduce(
      (max, config) => Math.max(max, config.total),
      0,
    );
    return seen > 0 ? seen : (navState.nQuestions ?? 0);
  }, [configs, navState.nQuestions]);

  const configCount =
    configs.length > 0 ? configs.length : (navState.nConfigs ?? 0);

  const docCount = navState.documents?.length ?? 0;
  const totalChars =
    navState.documents?.reduce((sum, doc) => sum + doc.char_count, 0) ?? 0;

  const phaseViews: PhaseView[] = useMemo(() => {
    const activeIndex =
      status === "done"
        ? PHASES.length
        : PHASES.findIndex((p) => p.key === status);
    return PHASES.map((phase, index) => {
      let state: PhaseState = "pending";
      if (status === "done" || index < activeIndex) state = "completed";
      else if (index === activeIndex) state = "active";

      const entry = phaseEntry[phase.key];
      let time: string | undefined;
      if (entry !== undefined) {
        const nextEntry = phaseEntry[PHASES[index + 1]?.key];
        if (state === "completed" && nextEntry !== undefined)
          time = formatElapsed(nextEntry - entry);
        else if (state === "active") time = formatElapsed(elapsed - entry);
      }
      const caption =
        state === "completed"
          ? "Completed"
          : state === "active"
            ? "In progress"
            : "Pending";
      return { label: phase.label, state, caption, time };
    });
  }, [status, phaseEntry, elapsed]);

  const connection = error
    ? { dot: "bg-red-500", title: "Disconnected", note: error }
    : terminal
      ? { dot: "bg-emerald-500", title: "Completed", note: "Run finished" }
      : connected
        ? {
            dot: "bg-emerald-500",
            title: "SSE Active",
            note: "Receiving live updates",
          }
        : {
            dot: "bg-amber-500",
            title: "Connecting…",
            note: "Opening the event stream",
          };

  return (
    <div className="animate-fade-in">
      <Link
        to="/"
        className="inline-flex items-center gap-1.5 text-sm font-medium text-accent hover:underline"
      >
        <ArrowLeft size={16} /> Back to upload
      </Link>

      <div className="mt-4 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="font-display text-4xl font-bold tracking-tight text-slate-900 dark:text-white">
            Run progress
          </h1>
          <div className="mt-2 flex items-center gap-3 text-sm text-slate-500 dark:text-slate-400">
            <span>
              Run ID:{" "}
              <span className="font-mono text-slate-700 dark:text-slate-200">
                {runId}
              </span>
            </span>
            <button
              type="button"
              aria-label="Copy run id"
              onClick={() => navigator.clipboard?.writeText(runId)}
              className="text-slate-400 transition hover:text-slate-700 dark:hover:text-slate-200"
            >
              <Copy size={15} />
            </button>
            {navState.demoMode && (
              <span className="rounded-full bg-accent-soft px-2.5 py-0.5 text-xs font-medium text-accent">
                Demo mode
              </span>
            )}
          </div>
        </div>

        <div className="flex flex-wrap gap-3">
          <div className="card flex items-center gap-3 px-4 py-3">
            <Timer size={18} className="text-accent" />
            <div>
              <p className="text-xs text-slate-400">Elapsed time</p>
              <p className="font-mono text-lg font-semibold text-slate-800 dark:text-slate-100">
                {formatElapsed(elapsed)}
              </p>
              <p className="text-xs text-slate-400">Started {startedLabel}</p>
            </div>
          </div>
          <div className="card flex items-start gap-3 px-4 py-3">
            <Wifi size={18} className="mt-0.5 text-accent" />
            <div>
              <p className="flex items-center gap-1.5 text-xs text-slate-400">
                <span className={`h-2 w-2 rounded-full ${connection.dot}`} />{" "}
                Connection
              </p>
              <p className="font-semibold text-slate-800 dark:text-slate-100">
                {connection.title}
              </p>
              <p className="max-w-[180px] truncate text-xs text-slate-400">
                {connection.note}
              </p>
            </div>
          </div>
        </div>
      </div>

      <div className="mt-6 grid gap-3 sm:grid-cols-3">
        <StatCard
          icon={
            <FileText
              size={28}
              strokeWidth={1.75}
              className="animate-float-soft motion-reduce:animate-none"
            />
          }
          label="Documents"
          value={
            docCount > 0
              ? `${docCount} files · ${formatNumber(totalChars)} characters`
              : "—"
          }
        />
        <StatCard
          icon={
            <FlaskConical
              size={28}
              strokeWidth={1.75}
              className="animate-float-soft motion-reduce:animate-none [animation-delay:1.2s]"
            />
          }
          label="Exam"
          value={
            totalQuestions > 0 ? `${totalQuestions} questions · 4 types` : "—"
          }
        />
        <StatCard
          icon={
            <Layers
              size={28}
              strokeWidth={1.75}
              className="animate-float-soft motion-reduce:animate-none [animation-delay:2.4s]"
            />
          }
          label="Configurations"
          value={configCount > 0 ? `${configCount} configurations` : "—"}
        />
      </div>

      <div className="card mt-6 p-6">
        <PhaseTimeline phases={phaseViews} />
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-[1.3fr_1fr]">
        <ConfigProgressList configs={configs} totalQuestions={totalQuestions} />
        <EventLog entries={log} onClear={() => setLog([])} />
      </div>

      {error ? (
        <div
          role="alert"
          className="mt-6 flex items-start gap-3 rounded-xl border border-red-200 bg-red-50 p-4 dark:border-red-900/50 dark:bg-red-950/40"
        >
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-red-100 text-red-600 dark:bg-red-900/50">
            <FlaskConical size={20} />
          </div>
          <div>
            <p className="font-semibold text-red-700 dark:text-red-300">
              Run failed
            </p>
            <p className="text-sm text-red-600 dark:text-red-400">{error}</p>
          </div>
        </div>
      ) : (
        <div className="card mt-6 flex items-center gap-3 p-5">
          <div className="flex h-14 w-14 shrink-0 items-center justify-center text-accent">
            <FlaskConical
              size={30}
              strokeWidth={1.75}
              className="animate-float-soft motion-reduce:animate-none"
            />
          </div>
          <div>
            <p className="font-semibold text-slate-800 dark:text-slate-100">
              {terminal ? "Evaluation complete" : "Evaluation in progress"}
            </p>
            <p className="text-sm text-slate-500 dark:text-slate-400">
              {terminal
                ? "Opening the report card…"
                : "RAGProbe is running each configuration against every question. You'll be taken to the report when it finishes."}
            </p>
          </div>
        </div>
      )}
    </div>
  );
}

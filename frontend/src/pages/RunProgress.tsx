import {
  AlertTriangle,
  Ban,
  Clock3,
  Copy,
  FileText,
  FlaskConical,
  Layers,
  Timer,
  Wifi,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate, useParams } from "react-router-dom";
import { cancelRun, getRun, subscribeToRun } from "../api/client";
import {
  ConfigProgressList,
  type ConfigProgress,
} from "../components/ConfigProgress";
import { EventLog, type LogEntry, type LogKind } from "../components/EventLog";
import { LiveProcess, type TranscriptItem } from "../components/LiveProcess";
import {
  PhaseTimeline,
  type PhaseState,
  type PhaseView,
} from "../components/PhaseTimeline";
import { StatCard } from "../components/StatCard";
import { formatClock, formatElapsed, formatNumber } from "../lib/format";
import { useI18n } from "../lib/i18n";
import {
  MOCK_RUN_ID,
  mockConfigs,
  mockElapsedMs,
  mockLog,
  mockPhaseEntry,
  mockStatus,
  mockTranscript,
} from "../lib/mockRun";
import { clearActiveRunId } from "../lib/session";
import type { DocumentSummary, RunEvent, RunStatus } from "../types";

const PHASES: { key: RunStatus; label: string }[] = [
  { key: "generating_exam", label: "Generating exam" },
  { key: "indexing", label: "Indexing" },
  { key: "answering", label: "Answering" },
  { key: "judging", label: "Judging" },
  { key: "done", label: "Done" },
];

// Progress-stream silence thresholds. EventSource ignores the backend's 15s
// keepalive comment frames, so a gap between `onmessage` events is a true "no
// progress" signal. Kept generous: a single slow exam-gen or judging LLM call
// can legitimately go quiet for a while. Warn first, then auto-cancel.
const STALL_WARN_MS = 90_000;
const STALL_AUTO_MS = 240_000;

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

/** Map a content-bearing run event to a transcript item, or null if it carries none. */
function transcriptItem(event: RunEvent, id: number): TranscriptItem | null {
  if (event.type === "thinking" && event.message) {
    return { id, kind: "thinking", text: event.message };
  }
  if (event.type === "question" && event.question) {
    const { idx, qtype, text } = event.question;
    return { id, kind: "question", idx, qtype, text };
  }
  if (event.type === "answer" && event.answer && event.config_label) {
    const a = event.answer;
    return {
      id,
      kind: "answer",
      configLabel: event.config_label,
      idx: a.idx,
      qtype: a.qtype,
      question: a.question,
      text: a.text,
      retrieved: a.retrieved,
      latencyMs: a.latency_ms,
      abstained: a.abstained,
    };
  }
  if (event.type === "grade" && event.grade && event.config_label) {
    const g = event.grade;
    return {
      id,
      kind: "grade",
      configLabel: event.config_label,
      idx: g.idx,
      qtype: g.qtype,
      correctness: g.correctness,
      faithfulness: g.faithfulness,
      retrievalHit: g.retrieval_hit,
      confidence: g.confidence,
      rationale: g.rationale,
    };
  }
  return null;
}

export function RunProgressPage() {
  const { t } = useI18n();
  const { runId = "" } = useParams();
  const navigate = useNavigate();
  const navState = (useLocation().state as RunNavState | null) ?? {};

  const [status, setStatus] = useState<RunStatus>("pending");
  const [error, setError] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);
  const [configs, setConfigs] = useState<ConfigProgress[]>([]);
  const [liveConfigLabel, setLiveConfigLabel] = useState<string | null>(null);
  const [transcript, setTranscript] = useState<TranscriptItem[]>([]);
  const [log, setLog] = useState<LogEntry[]>([]);
  const [elapsed, setElapsed] = useState(0);
  const [phaseEntry, setPhaseEntry] = useState<Record<string, number>>({});
  const [startedLabel, setStartedLabel] = useState("");
  const [stalled, setStalled] = useState(false);
  const [confirmingCancel, setConfirmingCancel] = useState(false);
  const [cancelling, setCancelling] = useState(false);

  const startMsRef = useRef<number>(0);
  const logIdRef = useRef(0);
  const itemIdRef = useRef(0);
  // Timestamp of the last progress event; drives the stall watchdog below.
  const lastEventMsRef = useRef<number>(0);
  // The live EventSource, so the cancel handler can close it before the backend
  // publishes its terminal event (which would otherwise fire the error redirect).
  const sourceRef = useRef<EventSource | null>(null);
  const cancellingRef = useRef(false);
  const autoCancelRef = useRef(false);

  const pushLog = useCallback((text: string, kind: LogKind) => {
    const entry: LogEntry = {
      id: logIdRef.current++,
      time: formatClock(new Date()),
      text,
      kind,
    };
    setLog((current) => [...current, entry].slice(-200));
  }, []);

  // Seed the log. (The static mock run seeds its own log directly below.)
  useEffect(() => {
    if (!runId || runId === MOCK_RUN_ID) return;
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
    lastEventMsRef.current = Date.now();
    cancellingRef.current = false;
    autoCancelRef.current = false;
    itemIdRef.current = 0;
    setTranscript([]);
    setStartedLabel(formatClock(new Date(startMsRef.current)));

    // The static preview run: skip the backend entirely and render fixed
    // sample data, so the transcript/progress styling can be iterated on
    // locally without a Groq key or a real upload.
    if (runId === MOCK_RUN_ID) {
      startMsRef.current = Date.now() - mockElapsedMs;
      setStartedLabel(formatClock(new Date(startMsRef.current)));
      itemIdRef.current = mockTranscript.length;
      setStatus(mockStatus);
      setConfigs(mockConfigs);
      setPhaseEntry(mockPhaseEntry);
      setTranscript(mockTranscript);
      setLog(mockLog);
      setConnected(true);
      return () => {
        active = false;
      };
    }

    // Progress is only shown for a run that is actively processing. The snapshot
    // decides: a finished run hands off to its report, a failed/unknown one (a
    // failed run is deleted, so this 404s) bounces to upload, and only an
    // in-flight run renders here — however the URL was reached.
    getRun(runId)
      .then((snapshot) => {
        if (!active) return;
        if (snapshot.status === "done") {
          navigate(`/runs/${runId}/report`, { replace: true });
          return;
        }
        if (snapshot.status === "error") {
          navigate(`/runs/${runId}/report`, {
            replace: true,
            state: { error: snapshot.error ?? "The run failed." },
          });
          return;
        }
        const started = Date.parse(snapshot.created_at);
        if (!Number.isNaN(started)) {
          startMsRef.current = started;
          setStartedLabel(formatClock(new Date(started)));
        }
        setStatus(snapshot.status);
        if (snapshot.error) setError(snapshot.error);
      })
      .catch(() => {
        // No real run behind this id (a failed run is deleted, so its snapshot
        // 404s) — return to upload rather than render a dead progress screen.
        if (active) navigate("/", { replace: true });
      });

    const source = subscribeToRun(runId, {
      onEvent: (event) => {
        if (!active || cancellingRef.current) return;
        lastEventMsRef.current = Date.now();
        setStalled(false);
        setConnected(true);
        handleEvent(event);
      },
      onError: () => active && setConnected(false),
    });
    sourceRef.current = source;

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
        setLiveConfigLabel(label);
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

      // Content events feed the live transcript (the phase/progress events above
      // still drive the timeline and per-config bars).
      const item = transcriptItem(event, itemIdRef.current);
      if (item) {
        itemIdRef.current += 1;
        setTranscript((current) => [...current, item].slice(-800));
      }
    }

    return () => {
      active = false;
      source.close();
      sourceRef.current = null;
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

  // Cancel the run: close the stream first so the backend's terminal event does
  // not also fire the error redirect, ask the backend to tear it down (which
  // deletes it), then return to upload. Best-effort — even if the request fails
  // we leave the stuck screen.
  const cancelRunNow = useCallback(async () => {
    if (cancellingRef.current) return;
    cancellingRef.current = true;
    setCancelling(true);
    sourceRef.current?.close();
    clearActiveRunId();
    if (runId !== MOCK_RUN_ID) {
      try {
        await cancelRun(runId);
      } catch {
        // Ignore: the run is being abandoned regardless.
      }
    }
    navigate("/", { replace: true });
  }, [runId, navigate]);

  // Stall watchdog: when the progress stream goes silent past the thresholds,
  // warn, then auto-cancel once. Catches both a free-tier crawl and an orphaned
  // run left by a restarted worker (which will never publish again). The mock
  // run never emits events, so it's exempt — otherwise it would auto-cancel
  // itself a few minutes after opening.
  useEffect(() => {
    if (terminal || runId === MOCK_RUN_ID) return;
    const id = window.setInterval(() => {
      const silent = Date.now() - lastEventMsRef.current;
      setStalled(silent >= STALL_WARN_MS);
      if (silent >= STALL_AUTO_MS && !autoCancelRef.current) {
        autoCancelRef.current = true;
        void cancelRunNow();
      }
    }, 1000);
    return () => window.clearInterval(id);
  }, [terminal, runId, cancelRunNow]);

  // On success, hand off to the report card. `replace` keeps the now-finished
  // progress URL out of history.
  useEffect(() => {
    if (status !== "done") return;
    clearActiveRunId();
    const id = window.setTimeout(
      () => navigate(`/runs/${runId}/report`, { replace: true }),
      700,
    );
    return () => window.clearTimeout(id);
  }, [status, runId, navigate]);

  // On failure, hand off to the report page as an error page, carrying the
  // message in navigation state (the run is being deleted, so it can't be
  // re-fetched). `replace` prevents backing into the dead progress URL.
  useEffect(() => {
    if (status !== "error" || cancellingRef.current) return;
    clearActiveRunId();
    navigate(`/runs/${runId}/report`, {
      replace: true,
      state: { error: error ?? "The run failed." },
    });
  }, [status, error, runId, navigate]);

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
    ? { dot: "bg-red-500", title: "Disconnected", note: error, live: false }
    : terminal
      ? {
          dot: "bg-emerald-500",
          title: "Completed",
          note: "Run finished",
          live: false,
        }
      : connected
        ? {
            dot: "bg-emerald-500",
            title: "SSE Active",
            note: "Receiving live updates",
            live: true,
          }
        : {
            dot: "bg-amber-500",
            title: "Connecting…",
            note: "Opening the event stream",
            live: true,
          };

  return (
    // Fits the whole page into one viewport: height is 100vh minus exactly the
    // Layout shell's own vertical padding (pt-10/pb-6 → sm:pt-14 → lg:pt-20/pb-8),
    // so nothing here ever forces the page itself to scroll. Sections above the
    // grid keep their natural height (shrink-0); the grid takes whatever is left
    // (flex-1 min-h-0) and its panels scroll internally instead.
    <div className="flex h-[calc(100vh-4rem)] flex-col overflow-hidden animate-fade-in sm:h-[calc(100vh-5rem)] lg:h-[calc(100vh-7rem)]">
      <div className="flex shrink-0 flex-wrap items-start justify-between gap-4">
        <div className="flex items-start gap-4">
          <Clock3
            size={42}
            strokeWidth={1.8}
            className="mt-1 shrink-0 text-accent dark:text-white"
          />
          <div>
            <h1 className="font-display text-4xl font-bold tracking-tight text-slate-900 dark:text-white">
              {t("run.title")}
            </h1>
            <div className="mt-3 flex flex-wrap items-center gap-3 text-sm text-slate-500 dark:text-slate-400">
              <span>
                {t("run.id")}{" "}
                <span className="font-mono text-slate-700 dark:text-slate-200">
                  {runId}
                </span>
              </span>
              <button
                type="button"
                aria-label={t("run.copy")}
                onClick={() => navigator.clipboard?.writeText(runId)}
                className="text-slate-400 transition hover:text-slate-700 dark:hover:text-slate-200"
              >
                <Copy size={15} />
              </button>
              {navState.demoMode && (
                <span className="rounded-full bg-accent-soft px-2.5 py-0.5 text-xs font-medium text-accent">
                  {t("run.demoMode")}
                </span>
              )}
              {!terminal && !confirmingCancel && (
                <button
                  type="button"
                  onClick={() => setConfirmingCancel(true)}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-red-300 bg-white px-2.5 py-1 text-xs font-medium text-red-600 shadow-sm transition hover:bg-red-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500 focus-visible:ring-offset-2 focus-visible:ring-offset-white dark:border-red-500/40 dark:bg-slate-800 dark:text-red-400 dark:hover:bg-red-500/10 dark:focus-visible:ring-offset-slate-900"
                >
                  <Ban size={13} /> {t("run.cancel")}
                </button>
              )}
            </div>

            {!terminal && confirmingCancel && (
              <div className="mt-3 flex flex-col items-start gap-2">
                <span className="text-sm text-slate-500 dark:text-slate-400">
                  {t("run.discard")}
                </span>
                <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    onClick={() => void cancelRunNow()}
                    disabled={cancelling}
                    className="inline-flex items-center gap-1.5 rounded-lg bg-red-500 px-2.5 py-1 text-xs font-semibold text-white shadow-sm transition hover:bg-red-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500 focus-visible:ring-offset-2 focus-visible:ring-offset-white disabled:opacity-60 dark:focus-visible:ring-offset-slate-900"
                  >
                    <Ban size={13} /> {t("run.confirm")}
                  </button>
                  <button
                    type="button"
                    onClick={() => setConfirmingCancel(false)}
                    disabled={cancelling}
                    className="rounded-lg px-2 py-1 text-xs font-medium text-slate-500 transition hover:text-slate-700 disabled:opacity-60 dark:text-slate-400 dark:hover:text-slate-200"
                  >
                    {t("run.keep")}
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>

        <div className="flex flex-wrap gap-3">
          <div className="card flex min-w-[190px] items-center gap-3.5 px-4 py-3">
            <div className="flex shrink-0 items-center justify-center text-accent">
              <Timer size={32} />
            </div>
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">
                {t("run.elapsed")}
              </p>
              <p className="font-mono text-xl font-semibold leading-tight tabular-nums text-slate-800 dark:text-slate-100">
                {formatElapsed(elapsed)}
              </p>
              <p className="text-xs text-slate-400">
                {t("run.started")} {startedLabel}
              </p>
            </div>
          </div>
          <div className="card flex min-w-[190px] items-center gap-3.5 px-4 py-3">
            <div className="relative flex shrink-0 items-center justify-center text-accent">
              <Wifi size={32} />
              <span className="absolute -bottom-0.5 -right-0.5 flex h-2.5 w-2.5">
                {connection.live && (
                  <span
                    className={`absolute inline-flex h-full w-full animate-ping rounded-full opacity-75 motion-reduce:hidden ${connection.dot}`}
                  />
                )}
                <span
                  className={`relative inline-flex h-2.5 w-2.5 rounded-full ring-2 ring-white dark:ring-slate-900 ${connection.dot}`}
                />
              </span>
            </div>
            <div className="min-w-0">
              <p className="font-semibold leading-tight text-slate-800 dark:text-slate-100">
                {connection.title}
              </p>
              <p className="max-w-[180px] truncate text-xs text-slate-400">
                {connection.note}
              </p>
            </div>
          </div>
        </div>
      </div>

      {stalled && !terminal && (
        <div
          role="status"
          className="mt-4 flex shrink-0 items-start gap-3 rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-sm dark:border-amber-500/30 dark:bg-amber-500/10"
        >
          <AlertTriangle
            size={18}
            className="mt-0.5 shrink-0 text-amber-600 dark:text-amber-400"
          />
          <div className="text-amber-800 dark:text-amber-300">
            <p className="font-semibold">{t("run.stalledTitle")}</p>
            <p className="text-amber-700/90 dark:text-amber-300/80">
              {t("run.stalledBody")}
            </p>
          </div>
        </div>
      )}

      {error && (
        <div
          role="alert"
          className="mt-4 flex shrink-0 items-start gap-3 rounded-xl border border-red-200 bg-red-50 p-4 dark:border-red-900/50 dark:bg-red-950/40"
        >
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-red-100 text-red-600 dark:bg-red-900/50">
            <FlaskConical size={20} />
          </div>
          <div>
            <p className="font-semibold text-red-700 dark:text-red-300">
              {t("run.failed")}
            </p>
            <p className="text-sm text-red-600 dark:text-red-400">{error}</p>
          </div>
        </div>
      )}

      <div className="mt-4 grid min-h-0 flex-1 gap-3 lg:grid-cols-[1fr_1.35fr]">
        <div className="flex min-h-0 min-w-0 flex-col gap-3">
          <ConfigProgressList
            configs={configs}
            liveLabel={terminal ? null : liveConfigLabel}
          />
          <EventLog entries={log} onClear={() => setLog([])} />
        </div>

        <div className="flex min-h-0 min-w-0 flex-col gap-3">
          <div className="card shrink-0 px-4 pb-5">
            <div className="grid gap-2 sm:grid-cols-3">
              <StatCard
                icon={
                  <FileText
                    size={28}
                    strokeWidth={1.75}
                    className="animate-float-soft motion-reduce:animate-none"
                  />
                }
                label={t("run.stat.documents")}
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
                label={t("run.stat.exam")}
                value={
                  totalQuestions > 0
                    ? `${totalQuestions} questions · 4 types`
                    : "—"
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
                label={t("run.stat.configurations")}
                value={configCount > 0 ? `${configCount} configurations` : "—"}
              />
            </div>

            <div className="mt-5">
              <PhaseTimeline phases={phaseViews} />
            </div>
          </div>

          <LiveProcess items={transcript} active={!terminal} />
        </div>
      </div>
    </div>
  );
}

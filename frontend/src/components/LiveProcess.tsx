import {
  Activity,
  Layers,
  PencilLine,
  Scale,
  Sparkles,
  Timer,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { JudgeConfidence, QType } from "../types";
import { CONFIDENCE_STYLE } from "../lib/confidence";
import { configColor, type ConfigColor } from "../lib/configColors";
import { formatLatency, formatScore } from "../lib/format";
import { Switch } from "./Switch";

/**
 * The live run transcript — RAGProbe's answer to "watch the whole thing happen".
 *
 * The run is rendered as a scrolling chat: a running "thinking…" narration, the
 * exam being drafted, then every question posed and each configuration's answer
 * streaming back, and finally the judge's verdict landing on each turn. Content
 * arrives as complete SSE events; the typewriter here supplies the token-by-token
 * feel without the backend having to stream partial tokens.
 */

/** One entry in the transcript. Items are append-only, so each renders once. */
export type TranscriptItem =
  | { id: number; kind: "thinking"; text: string }
  | { id: number; kind: "question"; idx: number; qtype: QType; text: string }
  | {
      id: number;
      kind: "answer";
      configLabel: string;
      idx: number;
      qtype: QType;
      question: string;
      text: string;
      retrieved: number;
      latencyMs: number;
      abstained: boolean;
    }
  | {
      id: number;
      kind: "grade";
      configLabel: string;
      idx: number;
      qtype: QType;
      correctness: number;
      faithfulness: number;
      retrievalHit: number | null;
      confidence: JudgeConfidence;
      rationale: string;
    };

interface ConfigAccent extends ConfigColor {
  /** Dark-aware badge treatment; `ConfigColor`'s `.soft`/`.text` have no dark
   * variants, so the transcript keeps its own chip classes alongside the
   * shared hex/bar values used everywhere else (report, leaderboard, chart). */
  chip: string;
}

// One chip style per configuration, same hue order as lib/configColors.ts's
// CONFIG_COLORS so a config's color identity matches the report page even
// though the ordering here (first-seen in the transcript) necessarily differs
// from the report's leaderboard-rank ordering, which doesn't exist yet mid-run.
const CONFIG_CHIPS = [
  "bg-blue-50 text-blue-700 ring-blue-200/70 dark:bg-blue-500/10 dark:text-blue-300 dark:ring-blue-400/20",
  "bg-violet-50 text-violet-700 ring-violet-200/70 dark:bg-violet-500/10 dark:text-violet-300 dark:ring-violet-400/20",
  "bg-orange-50 text-orange-700 ring-orange-200/70 dark:bg-orange-500/10 dark:text-orange-300 dark:ring-orange-400/20",
  "bg-emerald-50 text-emerald-700 ring-emerald-200/70 dark:bg-emerald-500/10 dark:text-emerald-300 dark:ring-emerald-400/20",
  "bg-rose-50 text-rose-700 ring-rose-200/70 dark:bg-rose-500/10 dark:text-rose-300 dark:ring-rose-400/20",
  "bg-cyan-50 text-cyan-700 ring-cyan-200/70 dark:bg-cyan-500/10 dark:text-cyan-300 dark:ring-cyan-400/20",
];

const QTYPE_DOT: Record<QType, string> = {
  factual: "bg-blue-500",
  multihop: "bg-violet-500",
  paraphrase: "bg-amber-500",
  unanswerable: "bg-slate-400 dark:bg-slate-500",
};

// Verdict-tinted card treatment for a grade turn, keyed off the worst of its
// three scores (mirrors scorePill's own thresholds below).
const VERDICT_STYLE = {
  pass: {
    label: "text-emerald-700 dark:text-emerald-300",
    glow: "bg-emerald-400/25 dark:bg-emerald-400/15",
  },
  partial: {
    label: "text-amber-700 dark:text-amber-300",
    glow: "bg-amber-400/25 dark:bg-amber-400/15",
  },
  fail: {
    label: "text-rose-700 dark:text-rose-300",
    glow: "bg-rose-400/25 dark:bg-rose-400/15",
  },
} as const;

type Verdict = keyof typeof VERDICT_STYLE;

function verdictFor(item: Extract<TranscriptItem, { kind: "grade" }>): Verdict {
  const worst = Math.min(
    item.correctness,
    item.faithfulness,
    item.retrievalHit ?? 1,
  );
  return worst >= 1 ? "pass" : worst >= 0.5 ? "partial" : "fail";
}

function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

/** Reveals `text` progressively on mount, with a blinking caret until complete. */
function Typewriter({ text, className }: { text: string; className?: string }) {
  const [count, setCount] = useState(() =>
    prefersReducedMotion() ? text.length : 0,
  );

  useEffect(() => {
    if (prefersReducedMotion()) return;
    // Reveal in ~90 ticks regardless of length, so short and long answers take a
    // similar, comfortable time to type out rather than crawling on long ones.
    const step = Math.max(1, Math.ceil(text.length / 90));
    let shown = 0;
    const id = window.setInterval(() => {
      shown = Math.min(text.length, shown + step);
      setCount(shown);
      if (shown >= text.length) window.clearInterval(id);
    }, 24);
    return () => window.clearInterval(id);
  }, [text]);

  const done = count >= text.length;
  return (
    <span className={className}>
      {text.slice(0, count)}
      {!done && (
        <span
          aria-hidden
          className="ml-0.5 inline-block animate-pulse text-accent motion-reduce:hidden"
        >
          ▍
        </span>
      )}
    </span>
  );
}

function scorePill(
  label: string,
  value: number | null,
): {
  label: string;
  value: string;
  cls: string;
} {
  const cls =
    value === null
      ? "bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400"
      : value >= 1
        ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300"
        : value >= 0.5
          ? "bg-amber-100 text-amber-700 dark:bg-amber-500/15 dark:text-amber-300"
          : "bg-red-100 text-red-700 dark:bg-red-500/15 dark:text-red-300";
  return { label, value: formatScore(value), cls };
}

/** A config's badge: an initial chip plus its full label, shared between an
 * answer turn and its judge turn so the two visually agree. */
function ConfigChip({
  label,
  accent,
  bare = false,
}: {
  label: string;
  accent: ConfigAccent;
  bare?: boolean;
}) {
  return (
    <span
      className={`inline-flex min-w-0 items-center gap-1.5 font-mono text-[11px] font-semibold ${
        bare
          ? `${accent.text} dark:text-slate-300`
          : `rounded-md px-2 py-1 ring-1 ${accent.chip}`
      }`}
    >
      <span
        aria-hidden
        className="h-1.5 w-1.5 shrink-0 rounded-full"
        style={{ backgroundColor: accent.hex }}
      />
      <span className="truncate">{label}</span>
    </span>
  );
}

function ThinkingRow({ text, live }: { text: string; live: boolean }) {
  return (
    <div className="group flex animate-message-rise items-start gap-2.5 px-2 py-1.5">
      <span className="relative mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center text-accent">
        {live && (
          <span
            aria-hidden
            className="absolute h-4 w-4 rounded-full bg-accent/25 blur-md motion-reduce:hidden"
          />
        )}
        <Sparkles
          size={14}
          strokeWidth={1.8}
          className={`relative ${live ? "animate-pulse motion-reduce:animate-none" : "opacity-60"}`}
        />
      </span>
      <p
        className={`min-w-0 font-mono text-xs leading-relaxed transition-colors ${
          live
            ? "text-slate-600 dark:text-slate-300"
            : "text-slate-400 dark:text-slate-500"
        }`}
      >
        {text}
        {live && (
          <span
            aria-hidden
            className="ml-1 inline-block h-3 w-px translate-y-0.5 animate-pulse bg-accent motion-reduce:hidden"
          >
            &nbsp;
          </span>
        )}
      </p>
    </div>
  );
}

/** A question bubble, aligned with the run transcript. Used both for a
 * question still being drafted (exam generation) and for the final question
 * paired with its answer, so a draft and its later turn read as the same
 * message rather than two different visual languages. */
function QuestionBubble({
  idx,
  qtype,
  text,
  draft = false,
  animation,
  side = "right",
}: {
  idx: number;
  qtype: QType;
  text: string;
  draft?: boolean;
  animation?: string;
  side?: "left" | "right";
}) {
  const entranceAnimation =
    animation ??
    (side === "left"
      ? "origin-bottom-left animate-message-pop-left"
      : "origin-bottom-right animate-message-pop-right");

  return (
    <div
      className={`relative max-w-[86%] ${entranceAnimation} overflow-hidden rounded-xl ${side === "left" ? "rounded-bl-sm" : "rounded-br-sm"} border border-slate-200/70 bg-gradient-to-br from-white via-white to-slate-50/90 px-4 py-3 shadow-[0_8px_24px_-18px_rgba(15,23,42,0.55)] ring-1 ring-white/80 dark:border-slate-700/60 dark:from-slate-900 dark:via-slate-900 dark:to-slate-800/70 dark:ring-slate-700/40`}
    >
      <span
        aria-hidden
        className="pointer-events-none absolute inset-0 bg-gradient-to-r from-accent/5 via-transparent to-transparent dark:from-accent/10"
      />
      <span
        aria-hidden
        className="pointer-events-none absolute inset-x-4 top-0 h-px bg-gradient-to-r from-transparent via-white to-transparent dark:via-slate-600/60"
      />
      <div className="relative">
        <div className="mb-1.5 flex items-center gap-2">
          {draft && (
            <PencilLine size={11} className="shrink-0 text-slate-400" />
          )}
          <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-slate-400">
            Question {idx}
          </span>
          <span
            aria-hidden
            className={`h-1.5 w-1.5 rounded-full ${QTYPE_DOT[qtype]}`}
          />
          <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-slate-400">
            {qtype}
          </span>
        </div>
        <p className="text-[15px] font-semibold leading-relaxed text-slate-800 dark:text-slate-100">
          {text}
        </p>
      </div>
    </div>
  );
}

/** A drafted exam question — the same bubble a posed question uses, marked
 * with a pencil and a snappier entrance since drafts can burst in quickly. */
function DraftRow({
  idx,
  qtype,
  text,
}: {
  idx: number;
  qtype: QType;
  text: string;
}) {
  return (
    <div className="relative flex justify-start py-2">
      <QuestionBubble
        idx={idx}
        qtype={qtype}
        text={text}
        draft
        side="left"
        animation="origin-bottom-left animate-message-pop-left"
      />
    </div>
  );
}

function AnswerTurn({
  item,
  accent,
  isLatest,
}: {
  item: Extract<TranscriptItem, { kind: "answer" }>;
  accent: ConfigAccent;
  isLatest: boolean;
}) {
  return (
    <div className="relative space-y-4 py-4">
      {/* Question - posed like a prompt, aligned right. */}
      <div className="flex justify-end">
        <QuestionBubble
          idx={item.idx}
          qtype={item.qtype}
          text={item.question}
        />
      </div>

      {/* Answer — the configuration replying, aligned left. */}
      <div className="flex justify-start pb-1">
        <div className="relative max-w-[88%] origin-bottom-left animate-message-pop-left overflow-hidden rounded-xl rounded-bl-sm border border-slate-200/70 bg-gradient-to-br from-white via-white to-slate-50/90 px-4 py-3 shadow-[0_8px_24px_-18px_rgba(15,23,42,0.55)] ring-1 ring-white/80 [animation-delay:90ms] dark:border-slate-700/60 dark:from-slate-900 dark:via-slate-900 dark:to-slate-800/70 dark:ring-slate-700/40">
          <span
            aria-hidden
            className="pointer-events-none absolute inset-0 bg-gradient-to-r from-accent/5 via-transparent to-transparent dark:from-accent/10"
          />
          <span
            aria-hidden
            className="pointer-events-none absolute inset-x-4 top-0 h-px bg-gradient-to-r from-transparent via-white to-transparent dark:via-slate-600/60"
          />
          {isLatest && (
            <span
              aria-hidden
              className="pointer-events-none absolute inset-0 -translate-x-full animate-sheen bg-gradient-to-r from-transparent via-white/60 to-transparent motion-reduce:hidden dark:via-white/10"
            />
          )}
          <div className="relative">
            <div className="mb-3 flex items-center justify-between gap-3">
              <span className="font-mono text-[10px] font-medium uppercase tracking-[0.14em] text-slate-400">
                Model answer
              </span>
              <ConfigChip label={item.configLabel} accent={accent} bare />
            </div>
            {item.abstained ? (
              <p className="text-[15px] font-semibold leading-relaxed text-slate-500 dark:text-slate-400">
                <Typewriter text={item.text} /> · abstained
              </p>
            ) : (
              <Typewriter
                text={item.text}
                className="text-[15px] font-semibold leading-relaxed text-slate-800 dark:text-slate-100"
              />
            )}
            <div className="mt-3 flex items-center gap-2 font-mono text-[11px] text-slate-400">
              <Layers size={11} />
              {item.retrieved} chunk{item.retrieved === 1 ? "" : "s"}
              <Timer size={11} className="ml-2" />
              {formatLatency(item.latencyMs)}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function GradeTurn({
  item,
  accent,
  isLatest,
}: {
  item: Extract<TranscriptItem, { kind: "grade" }>;
  accent: ConfigAccent;
  isLatest: boolean;
}) {
  const pills = [
    scorePill("correct", item.correctness),
    scorePill("faithful", item.faithfulness),
    scorePill("retrieval", item.retrievalHit),
  ];
  const v = VERDICT_STYLE[verdictFor(item)];
  return (
    <div className="relative flex justify-start py-3.5">
      <div className="relative max-w-[88%] origin-bottom-left animate-message-pop-left overflow-hidden rounded-xl rounded-bl-sm border border-slate-200/70 bg-gradient-to-br from-white via-white to-slate-50/90 px-4 py-3 shadow-[0_8px_24px_-18px_rgba(15,23,42,0.55)] ring-1 ring-white/80 dark:border-slate-700/60 dark:from-slate-900 dark:via-slate-900 dark:to-slate-800/70 dark:ring-slate-700/40">
        <span
          aria-hidden
          className="pointer-events-none absolute inset-0 bg-gradient-to-r from-accent/5 via-transparent to-transparent dark:from-accent/10"
        />
        <span
          aria-hidden
          className="pointer-events-none absolute inset-x-4 top-0 h-px bg-gradient-to-r from-transparent via-white to-transparent dark:via-slate-600/60"
        />
        {isLatest && (
          <span
            aria-hidden
            className="pointer-events-none absolute inset-0 -translate-x-full animate-sheen bg-gradient-to-r from-transparent via-white/60 to-transparent motion-reduce:hidden dark:via-white/10"
          />
        )}
        <div className="relative">
          <div className="mb-4 flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
            <div className="flex min-w-0 items-center gap-1.5">
              <span className="relative flex h-9 w-8 shrink-0 items-center justify-center">
                {isLatest && (
                  <span
                    aria-hidden
                    className={`absolute h-8 w-8 rounded-full blur-md motion-reduce:hidden ${v.glow}`}
                  />
                )}
                <Scale
                  size={26}
                  strokeWidth={1.8}
                  className={`relative ${v.label}`}
                />
              </span>
              <span
                className={`font-mono text-xs font-bold uppercase tracking-[0.14em] ${v.label}`}
              >
                Judge verdict
              </span>
            </div>
            <div className="ml-auto flex shrink-0 items-center gap-2">
              <span className="inline-flex items-center rounded-md bg-slate-100 px-2 py-1 font-mono text-[10px] font-semibold text-slate-500 ring-1 ring-slate-200/70 dark:bg-slate-800 dark:text-slate-400 dark:ring-slate-700">
                Q{item.idx}
              </span>
              <ConfigChip label={item.configLabel} accent={accent} />
              <span
                className={`rounded-full px-2.5 py-1 font-mono text-[10px] font-semibold capitalize ${CONFIDENCE_STYLE[item.confidence]}`}
              >
                {item.confidence} confidence
              </span>
            </div>
          </div>

          <div className="mb-4">
            <Typewriter
              text={item.rationale}
              className="text-sm leading-relaxed text-slate-700 dark:text-slate-300"
            />
          </div>

          <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
            {pills.map((pill) => (
              <div
                key={pill.label}
                className={`flex items-center justify-between gap-2 rounded-lg px-3 py-2 ${pill.cls}`}
              >
                <span className="font-mono text-[9px] font-semibold uppercase tracking-[0.12em] opacity-70">
                  {pill.label}
                </span>
                <span className="font-mono text-xs font-bold tabular-nums">
                  {pill.value}
                </span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

/** The live transcript panel: a scrolling, chat-styled view of the whole run. */
export function LiveProcess({
  items,
  active,
}: {
  items: TranscriptItem[];
  active: boolean;
}) {
  const [autoScroll, setAutoScroll] = useState(true);
  // Scrolled directly (never scrollIntoView): that call can bubble to the
  // page's own scroll container and yank the whole viewport around. Setting
  // scrollTop/scrollTo on this element only ever moves this box.
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = scrollRef.current;
    if (!autoScroll || !el) return;
    el.scrollTo({
      top: el.scrollHeight,
      behavior: prefersReducedMotion() ? "auto" : "smooth",
    });
  }, [items, autoScroll]);

  // Assign each configuration a stable accent by first-seen order.
  const accentByConfig = useMemo(() => {
    const map = new Map<string, ConfigAccent>();
    for (const item of items) {
      if (
        (item.kind === "answer" || item.kind === "grade") &&
        !map.has(item.configLabel)
      ) {
        const index = map.size;
        map.set(item.configLabel, {
          ...configColor(index),
          chip: CONFIG_CHIPS[index % CONFIG_CHIPS.length],
        });
      }
    }
    return map;
  }, [items]);

  const defaultAccent = useMemo<ConfigAccent>(
    () => ({ ...configColor(0), chip: CONFIG_CHIPS[0] }),
    [],
  );

  const lastItem = items.length > 0 ? items[items.length - 1] : null;
  const lastThinkingId =
    active && lastItem?.kind === "thinking" ? lastItem.id : null;
  // Bounds the expensive decoration (blurred glow, sheen sweep) to the single
  // most-recently-arrived turn, so a burst of SSE events never animates more
  // than one glow/sheen at once.
  const latestTurnId = active ? (lastItem?.id ?? null) : null;

  return (
    <div className="card flex h-full min-h-0 flex-col overflow-hidden">
      <div className="flex shrink-0 items-center justify-between border-b border-slate-100 px-5 py-4 dark:border-slate-800">
        <div className="flex min-w-0 items-center gap-3">
          <span className="relative flex h-10 w-10 shrink-0 items-center justify-center text-accent">
            {active && (
              <span
                aria-hidden
                className="absolute h-2.5 w-2.5 animate-ping rounded-full bg-accent/50 motion-reduce:hidden"
              />
            )}
            <Activity size={28} strokeWidth={1.8} className="relative" />
          </span>
          <div className="min-w-0">
            <h2 className="font-display text-base font-semibold text-slate-800 dark:text-slate-100">
              Run evaluation
            </h2>
            <p className="mt-0.5 truncate font-mono text-[11px] text-slate-400">
              {active ? "Live transcript" : "Transcript complete"} -{" "}
              {items.length} events
            </p>
          </div>
        </div>
        <label className="flex items-center gap-1.5 text-xs text-slate-500 dark:text-slate-400">
          Auto-scroll
          <Switch
            checked={autoScroll}
            onChange={setAutoScroll}
            label="Toggle auto-scroll"
            size="sm"
          />
        </label>
      </div>

      <div
        ref={scrollRef}
        className="fancy-scrollbar min-h-0 flex-1 overflow-y-auto bg-gradient-to-b from-slate-50/70 to-white px-4 py-4 pr-3 dark:from-slate-950/30 dark:to-slate-900/20"
      >
        {items.length === 0 ? (
          <div className="flex h-full min-h-[200px] items-center justify-center">
            <p className="rounded-xl border border-dashed border-slate-200 bg-white/70 px-5 py-4 text-center font-mono text-sm text-slate-500 shadow-sm dark:border-slate-700 dark:bg-slate-900/50 dark:text-slate-400">
              Waiting for the run to begin…
            </p>
          </div>
        ) : (
          <div className="space-y-1 pb-2">
            {items.map((item) => {
              switch (item.kind) {
                case "thinking":
                  return (
                    <ThinkingRow
                      key={item.id}
                      text={item.text}
                      live={item.id === lastThinkingId}
                    />
                  );
                case "question":
                  return (
                    <DraftRow
                      key={item.id}
                      idx={item.idx}
                      qtype={item.qtype}
                      text={item.text}
                    />
                  );
                case "answer":
                  return (
                    <AnswerTurn
                      key={item.id}
                      item={item}
                      accent={
                        accentByConfig.get(item.configLabel) ?? defaultAccent
                      }
                      isLatest={item.id === latestTurnId}
                    />
                  );
                case "grade":
                  return (
                    <GradeTurn
                      key={item.id}
                      item={item}
                      accent={
                        accentByConfig.get(item.configLabel) ?? defaultAccent
                      }
                      isLatest={item.id === latestTurnId}
                    />
                  );
              }
            })}
          </div>
        )}
      </div>
    </div>
  );
}

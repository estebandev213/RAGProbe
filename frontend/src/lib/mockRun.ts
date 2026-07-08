import type { ConfigProgress } from "../components/ConfigProgress";
import type { LogEntry } from "../components/EventLog";
import type { TranscriptItem } from "../components/LiveProcess";
import type { RunStatus } from "../types";

/**
 * A fixed run id that renders the run-progress screen from static, local
 * data instead of talking to the backend — visit `/runs/test123` while
 * running `npm run dev` to iterate on the transcript/progress styling
 * without a Groq key, an upload, or a live run.
 */
export const MOCK_RUN_ID = "test123";

export const mockStatus: RunStatus = "judging";

// Seconds-since-start each phase began, matched to mockElapsedMs below so the
// phase timeline renders a realistic mix of completed/active/pending states.
export const mockPhaseEntry: Record<string, number> = {
  generating_exam: 0,
  indexing: 38,
  answering: 71,
  judging: 210,
};

export const mockElapsedMs = 255_000;

export const mockConfigs: ConfigProgress[] = [
  { label: "400/vector", done: 8, total: 12 },
  { label: "400/hybrid", done: 12, total: 12 },
  { label: "800/vector", done: 3, total: 12 },
  { label: "800/hybrid", done: 12, total: 12 },
];

export const mockLog: LogEntry[] = [
  { id: 1, time: "10:02:01", text: "Run created", kind: "info" },
  {
    id: 2,
    time: "10:02:01",
    text: "Demo mode: ON (limits enabled)",
    kind: "info",
  },
  { id: 3, time: "10:02:03", text: "Generating exam with LLM…", kind: "phase" },
  { id: 4, time: "10:02:41", text: "Indexing documents…", kind: "phase" },
  { id: 5, time: "10:03:14", text: "Starting answering phase", kind: "phase" },
  {
    id: 6,
    time: "10:03:30",
    text: "[400/hybrid] Answering question 8/12",
    kind: "progress",
  },
  { id: 7, time: "10:04:02", text: "[400/hybrid] Completed", kind: "success" },
  { id: 8, time: "10:04:05", text: "[800/hybrid] Completed", kind: "success" },
  { id: 9, time: "10:05:41", text: "Judging answers…", kind: "phase" },
];

export const mockTranscript: TranscriptItem[] = [
  {
    id: 1,
    kind: "thinking",
    text: "Reading document sections to draft factual questions…",
  },
  {
    id: 2,
    kind: "question",
    idx: 1,
    qtype: "factual",
    text: "What year was the company founded?",
  },
  {
    id: 3,
    kind: "question",
    idx: 2,
    qtype: "multihop",
    text: "How do the pricing tiers relate to the SLA guarantees described in section 4?",
  },
  {
    id: 4,
    kind: "question",
    idx: 3,
    qtype: "paraphrase",
    text: "What's the typical turnaround for getting help from support staff?",
  },
  {
    id: 5,
    kind: "question",
    idx: 4,
    qtype: "unanswerable",
    text: "Who is the current CEO's predecessor's predecessor?",
  },
  {
    id: 6,
    kind: "answer",
    configLabel: "800/hybrid",
    idx: 1,
    qtype: "factual",
    question: "What year was the company founded?",
    text: "The company was founded in 2014, according to the About section of the handbook.",
    retrieved: 5,
    latencyMs: 812,
    abstained: false,
  },
  {
    id: 7,
    kind: "grade",
    configLabel: "800/hybrid",
    idx: 1,
    qtype: "factual",
    correctness: 1,
    faithfulness: 1,
    retrievalHit: 1,
    confidence: "high",
    rationale:
      "The answer matches the gold answer exactly and is fully supported by the retrieved passage.",
  },
  { id: 14, kind: "thinking", text: "Answer captured. Proceeding with Q2…" },
  {
    id: 8,
    kind: "answer",
    configLabel: "400/vector",
    idx: 2,
    qtype: "multihop",
    question:
      "How do the pricing tiers relate to the SLA guarantees described in section 4?",
    text: "NOT_IN_DOCUMENTS",
    retrieved: 5,
    latencyMs: 431,
    abstained: true,
  },
  {
    id: 9,
    kind: "grade",
    configLabel: "400/vector",
    idx: 2,
    qtype: "multihop",
    correctness: 0,
    faithfulness: 0.5,
    retrievalHit: 0.5,
    confidence: "medium",
    rationale:
      "The model abstained, but the gold answer required combining the pricing table with the SLA clause — one of the two spans was retrieved, so this is a partial retrieval miss rather than a full failure.",
  },
  { id: 15, kind: "thinking", text: "Answer captured. Proceeding with Q4…" },
  {
    id: 10,
    kind: "answer",
    configLabel: "400/bm25",
    idx: 4,
    qtype: "unanswerable",
    question: "Who is the current CEO's predecessor's predecessor?",
    text: "The documents mention a founding CEO but do not name a predecessor's predecessor.",
    retrieved: 5,
    latencyMs: 690,
    abstained: false,
  },
  {
    id: 11,
    kind: "grade",
    configLabel: "400/bm25",
    idx: 4,
    qtype: "unanswerable",
    correctness: 0,
    faithfulness: 0,
    retrievalHit: null,
    confidence: "low",
    rationale:
      "The model hallucinated a partial answer instead of abstaining cleanly with NOT_IN_DOCUMENTS.",
  },
  { id: 16, kind: "thinking", text: "Answer captured. Proceeding with Q3…" },
  {
    id: 12,
    kind: "answer",
    configLabel: "800/vector",
    idx: 3,
    qtype: "paraphrase",
    question:
      "What's the typical turnaround for getting help from support staff?",
    text: "Support tickets are answered within one business day, per the support SLA.",
    retrieved: 5,
    latencyMs: 754,
    abstained: false,
  },
  {
    id: 13,
    kind: "grade",
    configLabel: "800/vector",
    idx: 3,
    qtype: "paraphrase",
    correctness: 1,
    faithfulness: 1,
    retrievalHit: 1,
    confidence: "high",
    rationale:
      "Correctly paraphrased the support response-time passage despite minimal shared vocabulary.",
  },
];

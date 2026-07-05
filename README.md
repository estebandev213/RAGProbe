# RAGProbe

![CI](https://github.com/estebandev213/ragprobe/actions/workflows/ci.yml/badge.svg)

**Find out if your RAG pipeline is actually good.**

RAGProbe automatically evaluates retrieval-augmented generation systems. Upload documents, define nothing — it generates a rigorous exam from your content, runs it against multiple competing configurations, grades every answer with an LLM judge, and delivers a report card telling you exactly which setup to use and where it still fails.

---

## The problem

Every team building RAG tunes chunk sizes and search strategies by intuition. They pick 512 tokens because a blog post said so, deploy hybrid search because it sounds sophisticated, and discover hallucinations when a user complains. Systematic evaluation is the unsexy, unsolved part of RAG engineering — RAGProbe automates it.

---

## How it works

**1. Upload documents.** PDF, Markdown, or plain text. Up to 5 files. Or use the built-in sample documents and run immediately.

**2. Auto-generated exam.** An agent reads your documents and writes the test itself — 20 questions spanning four types designed to expose different failure modes:

| Type         | %   | What it stresses                             |
| ------------ | --- | -------------------------------------------- |
| Factual      | 40% | Basic retrieval and grounding                |
| Multi-hop    | 25% | Combining information across sections        |
| Paraphrase   | 20% | Vocabulary mismatch between query and source |
| Unanswerable | 15% | Hallucination resistance                     |

For every answerable question, the generator provides exact supporting quotes; the backend locates and records their character offsets. These become the ground truth for retrieval scoring.

**3. Configuration matrix.** RAGProbe builds six competing pipelines from the same documents — two chunk sizes (400 / 800 tokens) × three retrieval strategies (vector / BM25 / hybrid RRF) — and runs every question through every pipeline.

**4. Three-axis grading.** Each answer is scored independently on:

- **Correctness** — LLM judge compares answer vs. gold answer (0 / 0.5 / 1)
- **Faithfulness** — LLM judge checks if every claim is supported by the retrieved context
- **Retrieval hit** — pure math, no LLM: did the right chunks get fetched?

**5. Report card.** A leaderboard of configurations, a breakdown chart showing where each one collapses by question type, and a failure explorer where you can drill into any wrong answer, read the judge's rationale, and override any grade. The leaderboard re-aggregates immediately.

---

## Methodology

### Retrieval scoring without LLM subjectivity

Retrieval hit is computed with span-overlap arithmetic: a gold span is _hit_ if any retrieved chunk covers ≥ 50% of its character range. This makes scores comparable across chunk sizes — a larger chunk that contains the same information doesn't score artificially higher just because it's wider. Multi-hop questions require _all_ gold spans to be hit for a full score, and partial credit (0.5) is given when some spans are recovered.

Multi-hop questions are validated at generation time: a candidate whose supporting quotes resolve to a single passage (fewer than two spans, or spans close enough that one chunk would cover both) is discarded and regenerated — "multi-hop" that a single retrieval can satisfy is a factual question in disguise.

Latency on the leaderboard measures only the successful LLM call itself — client-side rate limiting, queueing, and retry backoff are excluded, so the number reflects the provider and configuration, not the free-tier throttle.

### Composite score

```
composite = 0.5 × correctness + 0.3 × faithfulness + 0.2 × retrieval_hit
```

Correctness is weighted highest because a correct answer with imperfect grounding is still useful. Faithfulness matters more than retrieval because a retrieved-but-ignored chunk is worse than a missed chunk. Retrieval is the weakest signal on its own — it measures opportunity, not outcome.

### Judge accountability

Every grade stores the judge's rationale and confidence level (low / medium / high). Nothing is hidden. The failure explorer surfaces these fields on every row, and any grade can be overridden by a human with a single click — the system re-aggregates the leaderboard immediately. The correct answer to "why trust an LLM judge?" is not "the model is good." It is: make it visible, make it auditable, and let humans correct it.

### An independent judge

Set `GEMINI_API_KEY` and grading runs on **Gemini** — a different model _family_ from the Llama model that writes the answers. LLMs measurably favor their own outputs; cross-family judging removes that self-preference bias from the scores. The two providers run as separate clients with independent rate budgets, and each run records which models answered and judged it. Without a Gemini key, the tool still works — the answerer grades itself, and that limitation is stated rather than hidden.

### Unanswerable questions

15% of the exam consists of plausible questions whose answers are not in the documents. A pipeline that answers these with fabricated information scores 0 on correctness regardless of how fluent the response sounds. A pipeline that says _"the provided context does not contain this information"_ scores 1. This is the hallucination resistance test.

Abstention detection is strict: the refusal sentinel must constitute essentially the whole reply. An answer that abstains _and then answers anyway_ ("NOT_IN_DOCUMENTS. However, the answer is likely…") is graded as a real answer — hedged hallucinations don't get a free pass.

### Statistical honesty

Exam sizes are small by design (free-tier budgets), and per-question scores are coarse (0 / 0.5 / 1) — so small composite differences between configurations are noise, not verdicts. The recommendation states its sample size, and when the runner-up is within 0.05 composite it says so explicitly and calls the result a tie. Confidence intervals are on the roadmap; until then, the tool refuses to pretend more precision than it has.

---

## Limitations (read before trusting the numbers)

Honest limits of the current design — each is a roadmap item, not a surprise:

- **Without a Gemini key, the judge shares a model with the answerer.** Set `GEMINI_API_KEY` and this limitation disappears — grading moves to a different model family (see "An independent judge" above). In the zero-config fallback, the same LLM generates answers and grades them; the self-preference bias applies roughly uniformly across configurations, which protects the _ranking_ better than the absolute scores.
- **Single judge sample, self-reported confidence.** Each grade is one judge call at temperature 0; the low/medium/high confidence is the judge's own claim, not a calibrated quantity. Agreement sampling across multiple judge calls is planned.
- **Exam coverage is biased toward document heads.** Generation reads up to the first 12,000 characters of each document, so the tail of long documents goes untested.
- **Documents are trusted input.** Document text flows into generation and judge prompts without sanitization; a document crafted to manipulate the judge could skew its own grades. Fine for evaluating your own corpus; do not point it at adversarial content.
- **Every grade is auditable.** Rationale and confidence are stored on every grade, surfaced in the failure explorer, and human-overridable — the mitigations above are inspectable, not hidden.

---

## Architecture

```
┌─────────────────────── Browser (React SPA) ───────────────────────┐
│   Upload ──▶ Run progress (SSE) ──▶ Report card                   │
└───────────────────────────┬───────────────────────────────────────┘
                            │ REST + SSE
┌───────────────────────────▼───────────────────────────────────────┐
│                       FastAPI backend                             │
│                                                                   │
│  Ingestion        Indexing              Run Orchestrator           │
│  pdf / md / txt   chunker (offsets)     exam generator (Groq)     │
│  normalize        fastembed (local)     config matrix executor    │
│                   sqlite-vec            retrieve → answer (Groq)  │
│                   BM25 index            judge (Gemini) + span math│
│                                         SSE event bus             │
│                                                                   │
│  Storage: single SQLite file (tables + sqlite-vec virtual tables) │
└───────────────────────────────────────────────────────────────────┘
```

A single Docker container serves the built React app as static files from FastAPI — one process, one deploy, no separate frontend hosting.

---

## Stack

| Layer          | Choice                                                                     |
| -------------- | -------------------------------------------------------------------------- |
| Backend        | Python 3.12, FastAPI, uvicorn                                              |
| Validation     | pydantic v2, pydantic-settings                                             |
| Embeddings     | fastembed — `BAAI/bge-small-en-v1.5`, local ONNX, no API                   |
| Vector store   | sqlite-vec on SQLite                                                       |
| Keyword search | rank-bm25                                                                  |
| LLM (answers)  | Groq API — `llama-3.3-70b-versatile`                                       |
| LLM (judge)    | Gemini (`gemini-3.5-flash`) when configured; independent from the answerer |
| PDF parsing    | pypdf                                                                      |
| Tests          | pytest, pytest-asyncio, respx                                              |
| Frontend       | Vite, React 18, TypeScript (strict), Tailwind, recharts                    |
| Deploy         | Docker → Railway                                                           |

---

## Quickstart

### Prerequisites

- Python 3.12+
- Node 20+
- A [Groq API key](https://console.groq.com) (free tier)
- Optional, recommended: a [Gemini API key](https://aistudio.google.com) (free tier) — enables the independent judge

### Local

```bash
git clone https://github.com/estebandev213/ragprobe.git
cd ragprobe

# Backend
cp .env.example .env
# → open .env and paste your GROQ_API_KEY
cd backend
python -m venv .venv && source .venv/bin/activate
pip install -e ".[dev]"
uvicorn app.main:app --reload

# Frontend (separate terminal)
cd frontend
npm install
npm run dev
```

Open [localhost:5173](http://localhost:5173). Click "Use sample documents" — no file upload needed to try it.

### Development setup

After installing backend dependencies, activate the git hooks:

```bash
pre-commit install
```

Hooks run automatically on every `git commit`: ruff (lint + format), mypy (types), prettier (frontend), and a private-key detector. To run them manually against all files:

```bash
pre-commit run --all-files
```

### Docker

```bash
cp .env.example .env   # add your GROQ_API_KEY
docker build -t ragprobe .
docker run -p 8000:8000 --env-file .env -v ragprobe-data:/app/data ragprobe
```

Open [localhost:8000](http://localhost:8000). The volume keeps uploaded documents and runs across container restarts; omit `-v` for a throwaway instance.

### Deploy to Railway

1. Push the repo to GitHub.
2. New project in Railway → Deploy from GitHub repo.
3. Set environment variables: `GROQ_API_KEY`, `DEMO_MODE=true`.
4. Railway detects the Dockerfile automatically. Deploy.

---

## Demo mode

Toggle "Demo mode" on the upload screen (default: on). Demo mode runs a 5-question exam against 2 configurations — the two chunk sizes at the hybrid strategy (400/hybrid vs 800/hybrid) — isolating the chunk-size variable while staying inside Groq's free-tier token-per-minute limits. A demo run completes in a couple of minutes. Full mode runs the 20-question exam across all 6 configurations; expect several minutes depending on rate-limit headroom (the progress screen is designed for exactly this wait).

---

## Design decisions

**SQLite over Postgres.** At demo scale, a single SQLite file with sqlite-vec is simpler to operate (zero infra, single container, volume for persistence) and measurably fast enough. The migration path to pgvector is mechanical when scale demands it.

**Local embeddings.** `fastembed` with `BAAI/bge-small-en-v1.5` runs on CPU, costs nothing, adds no external API call to the critical path, and fits in a 512MB container. Embedding quality is sufficient for the retrieval task.

**Reciprocal Rank Fusion over learned fusion.** RRF requires no training data, no hyperparameter tuning, and is robust to score distribution differences between vector similarity and BM25. For a tool that evaluates RAG rather than serving production traffic, interpretability beats marginal accuracy gains from learned methods.

**Raw httpx over vendor SDKs.** Keeping the LLM client in-house means the rate limiter and retry logic are explicit, testable, and auditable — and the same client drives both providers (Groq for answers, Gemini for judging) with independent rate budgets. A vendor SDK would obscure backoff behavior that matters significantly on free-tier rate limits.

---

## Project structure

```
ragprobe/
├── backend/
│   ├── app/
│   │   ├── main.py          # app factory + SPA static serving
│   │   ├── config.py
│   │   ├── db.py
│   │   ├── models.py
│   │   ├── routes/          # documents, runs, reports
│   │   └── core/            # ingestion, chunking, indexing, retrieval,
│   │                        # llm_client, exam, runner, judge, scoring
│   └── tests/
├── frontend/
│   └── src/
│       ├── api/
│       ├── pages/           # Upload, RunProgress, Report
│       └── components/
├── .github/workflows/       # CI: ruff, mypy, pytest, tsc, build
├── Dockerfile               # multi-stage: node build → python runtime
├── render.yaml              # Render blueprint (fallback deploy)
└── .env.example
```

---

## Roadmap

Ordered by how directly each item addresses a limitation above:

- [x] Independent judge model (Gemini judges, Groq answers — set `GEMINI_API_KEY`)
- [ ] Judge agreement sampling — 2–3 calls per grade; agreement rate replaces self-reported confidence
- [ ] Bootstrap confidence intervals on the leaderboard
- [ ] Exportable test suites and regression runs (compare before/after a prompt change)
- [ ] Document-wide sampling for exam generation (beyond the head)
- [ ] Custom configuration builder (arbitrary chunk sizes and top-k)
- [ ] Reranking stage (cross-encoder between retrieval and generation)
- [ ] Postgres + pgvector migration for multi-user deployments

---

## License

MIT

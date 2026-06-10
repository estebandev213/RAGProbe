# RAGProbe

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

### Composite score

```
composite = 0.5 × correctness + 0.3 × faithfulness + 0.2 × retrieval_hit
```

Correctness is weighted highest because a correct answer with imperfect grounding is still useful. Faithfulness matters more than retrieval because a retrieved-but-ignored chunk is worse than a missed chunk. Retrieval is the weakest signal on its own — it measures opportunity, not outcome.

### Judge accountability

Every grade stores the judge's rationale and confidence level (low / medium / high). Nothing is hidden. The failure explorer surfaces these fields on every row, and any grade can be overridden by a human with a single click — the system re-aggregates the leaderboard immediately. The correct answer to "why trust an LLM judge?" is not "the model is good." It is: make it visible, make it auditable, and let humans correct it.

### Unanswerable questions

15% of the exam consists of plausible questions whose answers are not in the documents. A pipeline that answers these with fabricated information scores 0 on correctness regardless of how fluent the response sounds. A pipeline that says _"the provided context does not contain this information"_ scores 1. This is the hallucination resistance test.

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
│                   BM25 index            judge (Groq) + span math  │
│                                         SSE event bus             │
│                                                                   │
│  Storage: single SQLite file (tables + sqlite-vec virtual tables) │
└───────────────────────────────────────────────────────────────────┘
```

A single Docker container serves the built React app as static files from FastAPI — one process, one deploy, no separate frontend hosting.

---

## Stack

| Layer          | Choice                                                        |
| -------------- | ------------------------------------------------------------- |
| Backend        | Python 3.12, FastAPI, uvicorn                                 |
| Validation     | pydantic v2, pydantic-settings                                |
| Embeddings     | fastembed — `BAAI/bge-small-en-v1.5`, local ONNX, no API      |
| Vector store   | sqlite-vec on SQLite                                          |
| Keyword search | rank-bm25                                                     |
| LLM            | Groq API (`llama-3.3-70b-versatile` for generation + judging) |
| PDF parsing    | pypdf                                                         |
| Tests          | pytest, pytest-asyncio, respx                                 |
| Frontend       | Vite, React 18, TypeScript (strict), Tailwind, recharts       |
| Deploy         | Docker → Railway                                              |

---

## Quickstart

### Prerequisites

- Python 3.12+
- Node 20+
- A [Groq API key](https://console.groq.com) (free tier)

### Local

```bash
git clone https://github.com/your-username/ragprobe.git
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
docker run -p 8000:8000 --env-file .env ragprobe
```

Open [localhost:8000](http://localhost:8000).

### Deploy to Railway

1. Push the repo to GitHub.
2. New project in Railway → Deploy from GitHub repo.
3. Set environment variables: `GROQ_API_KEY`, `DEMO_MODE=true`.
4. Railway detects the Dockerfile automatically. Deploy.

---

## Demo mode

Toggle "Demo mode" on the upload screen (default: on). Demo mode runs 4 configurations and 12 questions instead of 6 × 20. This keeps the run under Groq's free-tier rate limits and completes in 2–3 minutes. Full mode runs all 6 configs and 20 questions; expect 5–8 minutes depending on your rate limit headroom.

---

## Design decisions

**SQLite over Postgres.** At demo scale, a single SQLite file with sqlite-vec is simpler to operate (zero infra, single container, volume for persistence) and measurably fast enough. The migration path to pgvector is mechanical when scale demands it.

**Local embeddings.** `fastembed` with `BAAI/bge-small-en-v1.5` runs on CPU, costs nothing, adds no external API call to the critical path, and fits in a 512MB container. Embedding quality is sufficient for the retrieval task.

**Reciprocal Rank Fusion over learned fusion.** RRF requires no training data, no hyperparameter tuning, and is robust to score distribution differences between vector similarity and BM25. For a tool that evaluates RAG rather than serving production traffic, interpretability beats marginal accuracy gains from learned methods.

**Raw httpx over the OpenAI SDK.** Keeping the Groq client in-house means the rate limiter and retry logic are explicit, testable, and auditable. The OpenAI SDK would obscure backoff behavior that matters significantly on free-tier rate limits.

---

## Project structure

```
ragprobe/
├── backend/
│   ├── app/
│   │   ├── main.py
│   │   ├── config.py
│   │   ├── db.py
│   │   ├── models.py
│   │   ├── routes/          # documents, runs, reports
│   │   └── core/            # ingestion, chunking, indexing, retrieval,
│   │                        # groq_client, exam, runner, judge, scoring
│   └── tests/
├── frontend/
│   └── src/
│       ├── api/
│       ├── pages/           # Upload, RunProgress, Report
│       └── components/
├── Dockerfile
└── .env.example
```

---

## Roadmap

- [ ] Custom configuration builder (arbitrary chunk sizes and top-k)
- [ ] Reranking stage (cross-encoder between retrieval and generation)
- [ ] Exportable test suites and regression runs (compare before/after a prompt change)
- [ ] Multi-document corpus support
- [ ] Judge calibration via agreement rate between multiple judge calls
- [ ] Postgres + pgvector migration for multi-user deployments
- [ ] CI pipeline with automated eval regression

---

## License

MIT

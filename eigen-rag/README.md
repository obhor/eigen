# eigen-rag

A fully independent RAG (Retrieval-Augmented Generation) pipeline.
Built and tested standalone — integration with eigen PDF viewer comes later.

---

## Stack

| Layer | Tech |
|---|---|
| API | FastAPI |
| PDF parsing | PyMuPDF (`fitz`) |
| Chunking | custom sliding-window (500 chars, 100 overlap) |
| Embeddings | `sentence-transformers` — `all-MiniLM-L6-v2` |
| Vector search | `hnswlib` (in-memory, cosine similarity) |
| LLM | OpenAI-compatible — defaults to **local ollama** |

---

## Project structure

```
eigen-rag/
├── server/
│   ├── main.py                  ← FastAPI app entry point
│   ├── requirements.txt
│   ├── .env.example             ← copy to .env and configure
│   ├── api/
│   │   ├── routes/
│   │   │   ├── pdf.py           ← POST /ingest
│   │   │   └── chat.py          ← POST /query
│   │   └── middleware/
│   │       └── logging.py
│   ├── models/
│   │   └── schemas.py           ← Pydantic request/response models
│   ├── pdf/
│   │   ├── parser.py            ← PDF → pages (PyMuPDF)
│   │   └── indexer.py           ← pages → overlapping chunks
│   └── rag/
│       ├── embeddings.py        ← text → float32 vectors
│       ├── retriever.py         ← hnswlib vector store
│       └── generator.py        ← LLM answer generation
└── client/
    └── test_client.js           ← standalone Node.js CLI to test the server
```

---

## Quickstart

### 1. Set up the server

```bash
cd server

# Create and activate a virtual environment
python -m venv .venv
source .venv/bin/activate

# Install dependencies
pip install -r requirements.txt

# Configure environment
cp .env.example .env
# Edit .env — set LLM_BASE_URL / LLM_MODEL / OPENAI_API_KEY

# Start the server (binds 127.0.0.1 from .env — LAN-wide 0.0.0.0 is opt-in)
python main.py

# or, with reload:
uvicorn main:app --reload --host 127.0.0.1 --port 8000
```

The API is unauthenticated by default and trusts the localhost bind. Set
`RAG_TOKEN` in `.env` before exposing it anywhere else, and give the client the
same value via `VITE_RAG_TOKEN` (or `RAG_TOKEN` for the CLI). Uploads are capped
by `RAG_MAX_UPLOAD_MB` (50) and `RAG_MAX_PAGES` (500); scanned pages are OCR'd
within `RAG_OCR_MAX_PAGES` (50, 0 disables) and `RAG_OCR_TIMEOUT_S` (30).

Indexes live in memory only: the server keeps the most recent `RAG_MAX_STORES`
(8) documents and evicts the oldest, and a restart empties them. An unknown or
evicted `doc_id` answers 404, which the client shows as "press Send to
re-index". Password-protected PDFs are rejected with 422.

### 2. (Optional) Start ollama locally

```bash
ollama serve
ollama pull llama3.2
```

### 3. Test the pipeline with the CLI client

```bash
# Health check
node --experimental-vm-modules client/test_client.js status

# Ingest a PDF
node client/test_client.js ingest /path/to/your/document.pdf
# → prints doc_id

# Ask a question
node client/test_client.js query <doc_id> "What is this document about?"
```

---

## API contract

```
GET  /status                                       → { ready, version }
POST /ingest   multipart/form-data  file=<PDF>     → { doc_id, chunk_count, message }
POST /query    application/json                    → { answer, sources[] }
               { doc_id, q, k=5, history? }
POST /query/stream  application/json  { doc_id, q, k=5, history? }
               → text/event-stream:
                 event: sources  data: { sources[], mock }
                 event: delta    data: { text }            (many)
                 event: done     data: { warnings[] }
                 event: error    data: { message }
```

The chat UI uses `/query/stream` (the plain `/query` stays for scripts). Retrieval
runs *before* the stream starts, so a bad token or unknown `doc_id` is an ordinary
JSON error; only a provider failure mid-answer arrives as an `error` event.

`history` is `[{ role: "user"|"assistant", content }]` — the chat sends the tab's
last 3 exchanges so follow-ups ("and on page 5?") resolve. The server keeps only
the last 6 turns, 1500 chars each, and rejects `role: "system"` (rules stay in the
server's own system turn — a client cannot rewrite them).

Response shape for `/query`:
```json
{
  "answer": "The document discusses...",
  "sources": [
    { "id": "uuid", "text": "...", "page": 3, "score": 0.91 }
  ],
  "warnings": ["A sentence citing [Source 2] has no wording in common with that source."],
  "mock": false
}
```

Cancel in the chat UI aborts the HTTP request only — the server finishes any
work already in flight (an interrupted ingest still completes), and answers
that arrive after a cancel are discarded client-side.

---

## Swapping the LLM

The generator uses any OpenAI-compatible endpoint. To switch:

| Backend | `.env` settings |
|---|---|
| Local ollama | `LLM_BASE_URL=http://localhost:11434/v1` `LLM_MODEL=llama3.2` |
| OpenAI | `LLM_BASE_URL=https://api.openai.com/v1` `LLM_MODEL=gpt-4o` `OPENAI_API_KEY=sk-...` |
| LM Studio | `LLM_BASE_URL=http://localhost:1234/v1` `LLM_MODEL=<model-name>` |

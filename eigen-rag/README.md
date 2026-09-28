# eigen-rag

The AI Q&A stack for the eigen PDF viewer.

**The app path runs entirely in the browser.** The PDF is parsed, chunked,
embedded and searched on the visitor's device — nothing is uploaded, there is no
index to host, and no index expires. The only server-side piece is
`api/chat.js` (a Vercel function), which holds the Gemini API key and streams
the answer back; the PDF never reaches it, only the question and the handful of
retrieved excerpts.

`server/` is the original Python implementation. It still works and its checks
still pass, but it is now a reference/self-host option rather than the app's
path — useful if you want the LLM to run locally (ollama) or want server-side
OCR.

---

## Browser pipeline

```
eigen-rag/client/
├── RagManager.js        ← the seam: ingest() + queryStream() → { event, data } frames
└── rag/
    ├── pipeline.js      ← pure ESM port of the Python pipeline (Node-importable)
    ├── embedder.js      ← embed(texts) → Float32Array[]; worker, main-thread fallback
    └── embed.worker.js  ← MiniLM (all-MiniLM-L6-v2, q8) off the UI thread
```

| Stage | Browser | Python reference |
|---|---|---|
| Text extraction | pdf.js `getTextContent()` | PyMuPDF |
| Chunking | 600-char target, 3-sentence overlap | same |
| Embeddings | Transformers.js, `Xenova/all-MiniLM-L6-v2` q8 (384-dim) | sentence-transformers |
| Retrieval | BM25 (rank_bm25 port) + brute-force cosine → RRF (k=60) → MMR (λ=0.7) | same + hnswlib |
| Prompt + citations | `buildMessages`, `verifyCitations` | same |
| Answer | Gemini via `api/chat.js` | any OpenAI-compatible endpoint |

`pipeline.js` is a direct port, not an approximation: constants, formulas and
tie-breaks match `server/pdf/indexer.py` and `server/rag/*.py`.
`check-rag-pipeline.mjs` pins the port to the Python fixtures — change one side
and that check tells you the other drifted.

**Model files** live in `public/models/Xenova/all-MiniLM-L6-v2/` (~23 MB) and are
committed, so the app fetches them from its own origin (browser-cached after the
first ask). The ONNX runtime's wasm is emitted into the build by Vite — no CDN
at runtime.

**Known ceilings (v1):** no OCR (a scanned PDF gets an honest "no selectable
text" message), no heading detection, `MAX_PAGES=300`, `MAX_CHUNKS=1200`
(longer documents are truncated with a note), and no ANN — cosine is
brute-force, which is fine at this scale.

---

## The key-holder: `api/chat.js`

A stateless Vercel function at the repo root. It pins `generationConfig`
(temperature 0.2, `maxOutputTokens` from `LLM_MAX_TOKENS`, default 512), checks
the `Origin` against an allowlist, and passes Gemini's SSE straight through.

```bash
vercel env add GEMINI_API_KEY production    # the value is never printed
```

Optional env: `GEMINI_MODEL` (default `gemini-2.5-flash`), `LLM_MAX_TOKENS`.
Keep the key on a free-tier project with no billing attached, so abuse burns
quota rather than money. There is no rate limiting beyond the origin check —
add it if that becomes a problem.

**Self-hosting the client?** Point the build at your own key-holder with
`VITE_LLM_PROXY_URL` (defaults to `https://eigenpdf.com/api/chat`).

---

## Checks

```bash
npm run check        # from the repo root: annotations, export, pipeline, client
```

- `check-rag-pipeline.mjs` — the ported pipeline against the Python fixtures
  (cleanText, chunking, RRF/MMR scores, prompt string, citation checks).
- `check-rag-client.mjs` — `RagManager` with a fake embedder (ingest shape,
  per-tab indexes, proxy request shape, SSE parsing, error taxonomy) and the
  chat panel state machine with a fake manager.

Neither needs a network, a model, or a browser.

---

## server/ — reference implementation

| Layer | Tech |
|---|---|
| API | FastAPI |
| PDF parsing | PyMuPDF (`fitz`), OCR via Tesseract |
| Embeddings | `sentence-transformers` — `all-MiniLM-L6-v2` |
| Vector search | `hnswlib` (in-memory, cosine) |
| LLM | OpenAI-compatible — defaults to local ollama |

```
eigen-rag/server/
├── main.py                      ← FastAPI app entry point
├── requirements.txt
├── .env.example                 ← copy to .env and configure
├── api/routes/{pdf,chat}.py     ← POST /ingest, /query, /query/stream
├── api/middleware/logging.py
├── models/schemas.py
├── pdf/{parser,indexer}.py      ← PDF → pages → overlapping chunks
└── rag/{embeddings,retriever,generator}.py
```

### Quickstart

```bash
cd server
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env      # set LLM_BASE_URL / LLM_MODEL / OPENAI_API_KEY
python main.py            # binds 127.0.0.1 from .env; 0.0.0.0 is opt-in
```

The API is unauthenticated by default and trusts the localhost bind. Set
`RAG_TOKEN` in `.env` before exposing it anywhere else, and give the client the
same value (`RAG_TOKEN` for the CLI). Uploads are capped by `RAG_MAX_UPLOAD_MB`
(50) and `RAG_MAX_PAGES` (500); scanned pages are OCR'd within
`RAG_OCR_MAX_PAGES` (50, 0 disables) and `RAG_OCR_TIMEOUT_S` (30).

Indexes live in memory only: the server keeps the most recent `RAG_MAX_STORES`
(8) documents and evicts the oldest, and a restart empties them. An unknown or
evicted `doc_id` answers 404. Password-protected PDFs are rejected with 422.

### CLI client

```bash
node client/test_client.js status
node client/test_client.js ingest /path/to/your/document.pdf   # → doc_id
node client/test_client.js query <doc_id> "What is this about?"
node client/test_client.js query <doc_id> "..." --stream
```

### API contract

```
GET  /status                                       → { ready, version }
POST /ingest   multipart/form-data  file=<PDF>     → { doc_id, chunk_count, message }
POST /query    application/json                    → { answer, sources[], warnings[] }
               { doc_id, q, k=5, history? }
POST /query/stream  application/json  { doc_id, q, k=5, history? }
               → text/event-stream:
                 event: sources  data: { sources[] }
                 event: delta    data: { text }            (many)
                 event: done     data: { warnings[] }
                 event: error    data: { message }
```

Retrieval runs *before* the stream starts, so a bad token or unknown `doc_id` is
an ordinary JSON error; only a provider failure mid-answer arrives as an `error`
event. `history` is `[{ role: "user"|"assistant", content }]` — the chat sends
the tab's last 3 exchanges so follow-ups ("and on page 5?") resolve. The server
keeps only the last 6 turns, 1500 chars each, and rejects `role: "system"` —
rules stay in the server's own system turn, so a client cannot rewrite them.

Cancel aborts the HTTP request only: the server finishes work already in flight,
and answers that arrive after a cancel are discarded client-side.

| Backend | `.env` settings |
|---|---|
| Local ollama | `LLM_BASE_URL=http://localhost:11434/v1` `LLM_MODEL=llama3.2` |
| OpenAI | `LLM_BASE_URL=https://api.openai.com/v1` `LLM_MODEL=gpt-4o` `OPENAI_API_KEY=sk-...` |
| LM Studio | `LLM_BASE_URL=http://localhost:1234/v1` `LLM_MODEL=<model-name>` |

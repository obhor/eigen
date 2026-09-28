/**
 * RagManager.js — the browser-side RAG engine. Extraction, chunking, embedding
 * and retrieval all run on the visitor's device; the only thing that leaves it
 * is the question plus the retrieved excerpts, POSTed to the key-holder proxy
 * (api/chat.js) which forwards to Gemini.
 *
 * API contract (unchanged from the server-backed version):
 *   ingest(pdfDoc, tabId, signal, onProgress)
 *        → { doc_id, chunk_count, page_count, ocr_pages, message }
 *   queryStream(question, k, tabId, signal, history) → frames in arrival order:
 *        sources → delta* → (done | error)
 *   clearTab(tabId), getDocIdForTab(tabId)
 *
 * Errors carry a user-facing string in `.message` and the raw body in
 * `.detail` (console only — never rendered). Aborts pass through as-is so the
 * caller can tell "user cancelled" from "failed".
 */
import {
  chunkPages, buildStore, queryIndex, buildMessages, toGeminiRequest,
  verifyCitations, extractPageTexts, MAX_PAGES, MAX_CHUNKS,
} from './rag/pipeline.js';
import { embed as defaultEmbed } from './rag/embedder.js';

const PROXY_URL = import.meta.env?.VITE_LLM_PROXY_URL || 'https://eigenpdf.com/api/chat';
const QUERY_TIMEOUT_MS = 90_000;
const EMBED_BATCH = 16;

const FRIENDLY = {
  403: 'The AI service rejected the request.',
  429: 'The AI service is busy or out of quota — try again later.',
};

function _timeoutSignal(signal, ms) {
  const timeout = AbortSignal.timeout(ms);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

async function _proxyError(res) {
  const raw = await res.text().catch(() => '');
  let detail = raw;
  try {
    const parsed = JSON.parse(raw);
    // our own { error: "..." } or Gemini's { error: { message } }
    if (typeof parsed?.error === 'string') detail = parsed.error;
    else if (typeof parsed?.error?.message === 'string') detail = parsed.error.message;
  } catch { /* not JSON — keep the raw text */ }

  console.warn('[rag] proxy answered %d: %s', res.status, detail);
  const err = new Error(FRIENDLY[res.status] || `The AI service returned an error (${res.status}).`);
  err.detail = detail;
  err.status = res.status;
  return err;
}

// Gemini SSE: `data: {json}` records separated by blank lines. Frames arrive
// split anywhere, so buffer until the separator.
async function* _sseData(body) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let sep;
      while ((sep = buf.indexOf('\n\n')) !== -1) {
        const frame = buf.slice(0, sep);
        buf = buf.slice(sep + 2);
        const data = frame.split('\n')
          .filter((l) => l.startsWith('data:'))
          .map((l) => l.slice(5).trim())
          .join('');
        if (!data) continue;
        try {
          yield JSON.parse(data);
        } catch { /* garbled record — skip it rather than kill the stream */ }
      }
    }
  } finally {
    reader.cancel().catch(() => {});   // release the body when the caller stops early
  }
}

export class RagManager {
  constructor(app, { embedder = null } = {}) {
    this.app = app;
    this.embedder = embedder || defaultEmbed;   // injectable for checks
    // Per-tab indexes — the only source of truth (a question must never be
    // answered from another tab's document)
    this.docs = new Map();   // tabId → { doc_id, chunks, vectors, bm25 }
  }

  clearTab(tabId) {
    if (tabId) this.docs.delete(tabId);
  }

  getDocIdForTab(tabId) {
    return tabId ? (this.docs.get(tabId)?.doc_id ?? null) : null;
  }

  // ─── Ingest ───────────────────────────────────────────────────────────────

  /**
   * @param {object} pdfDoc - an open pdf.js document
   * @param {string|null} tabId - caches the resulting index for this tab
   * @param {AbortSignal|null} signal - caller's cancel signal
   * @param {Function|null} onProgress - { phase: 'extract'|'embed'|'model', ... }
   */
  async ingest(pdfDoc, tabId = null, signal = null, onProgress = null) {
    if (!pdfDoc) throw new Error('This tab has no PDF loaded.');
    if (pdfDoc.numPages > MAX_PAGES) {
      throw new Error(`This PDF has ${pdfDoc.numPages} pages; the limit is ${MAX_PAGES}.`);
    }

    const pages = await extractPageTexts(pdfDoc, { signal, onProgress });
    const all = chunkPages(pages);
    if (!all.length) throw new Error('This PDF has no selectable text — it looks like a scan.');
    const chunks = all.slice(0, MAX_CHUNKS);

    const vectors = [];
    for (let i = 0; i < chunks.length; i += EMBED_BATCH) {
      signal?.throwIfAborted();
      const batch = chunks.slice(i, i + EMBED_BATCH).map((c) => c.text);
      vectors.push(...await this.embedder(batch, { onProgress, signal }));
      onProgress?.({ phase: 'embed', done: Math.min(i + EMBED_BATCH, chunks.length), total: chunks.length });
    }
    signal?.throwIfAborted();

    const doc_id = globalThis.crypto.randomUUID();
    if (tabId) this.docs.set(tabId, { doc_id, ...buildStore(chunks, vectors) });

    const pageCount = pages.length;
    return {
      doc_id,
      chunk_count: chunks.length,
      page_count: pageCount,
      ocr_pages: 0,   // no OCR — a scanned PDF fails above instead of guessing
      message: all.length > chunks.length
        ? `Indexed the first ${chunks.length} of ${all.length} chunks — the rest of this document is not searchable.`
        : `Indexed ${chunks.length} chunks from ${pageCount} page${pageCount === 1 ? '' : 's'}.`,
    };
  }

  // ─── Query ────────────────────────────────────────────────────────────────

  /**
   * The question, answered from this tab's index and streamed as
   * { event, data } frames in arrival order: sources → delta* → (done | error).
   * @param {Array<{role: 'user'|'assistant', content: string}>} history - prior turns
   * @returns {AsyncGenerator<{ event: string, data: any }>}
   */
  async *queryStream(question, k = 5, tabId = null, signal = null, history = []) {
    const doc = this.docs.get(tabId);
    if (!doc) throw new Error('This tab has no indexed document yet.');

    const [queryVec] = await this.embedder([question], { signal });
    signal?.throwIfAborted();
    const chunks = queryIndex(doc, queryVec, question, k);
    yield { event: 'sources', data: { sources: chunks } };

    let res;
    try {
      res = await fetch(PROXY_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(toGeminiRequest(buildMessages(question, chunks, history))),
        signal: _timeoutSignal(signal, QUERY_TIMEOUT_MS),
      });
    } catch (err) {
      if (err?.name === 'AbortError') throw err;   // caller cancelled — pass through
      if (err?.name === 'TimeoutError') throw new Error('The AI service did not answer in time. Try again.');
      throw new Error("Can't reach the AI service. Check your connection.");
    }
    if (!res.ok) throw await _proxyError(res);

    let answer = '';
    for await (const record of _sseData(res.body)) {
      if (record?.error) throw new Error(String(record.error.message || 'The AI service failed.'));
      if (record?.promptFeedback?.blockReason) {
        throw new Error('The AI service refused to answer this question.');
      }
      const text = (record?.candidates?.[0]?.content?.parts || [])
        .map((p) => p.text || '').join('');
      if (!text) continue;
      answer += text;
      yield { event: 'delta', data: { text } };
    }

    yield { event: 'done', data: { warnings: verifyCitations(answer, chunks) } };
  }
}

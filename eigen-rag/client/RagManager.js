/**
 * RagManager.js — handles all communication with the eigen-rag server.
 *
 * API contract:
 *   POST /ingest        multipart/form-data  { file: Blob }   → { doc_id, chunk_count, message }
 *   POST /query         application/json     { doc_id, q, k } → { answer, sources, warnings, mock }
 *   POST /query/stream  application/json     { doc_id, q, k } → SSE frames:
 *        event: sources → { sources, mock }    event: delta → { text } (many)
 *        event: done    → { warnings }         event: error → { message }
 *   GET  /status                                              → { ready, version }
 *
 * Errors carry a user-facing string in `.message` and the raw server body in
 * `.detail` (console only — never rendered). Aborts pass through as-is so the
 * caller can tell "user cancelled" from "failed".
 */

const RAG_BASE = import.meta.env?.VITE_RAG_BASE || 'http://localhost:8000';
// Only needed when the server sets RAG_TOKEN (.env)
const RAG_TOKEN = import.meta.env?.VITE_RAG_TOKEN || globalThis.localStorage?.getItem('rag_token') || '';
const AUTH_HEADERS = RAG_TOKEN ? { Authorization: `Bearer ${RAG_TOKEN}` } : {};

const INGEST_TIMEOUT_MS = 600_000;  // indexing a big scan takes minutes
const QUERY_TIMEOUT_MS = 90_000;    // above the server's 60s LLM timeout, so its error wins

const AUTH_MESSAGE = 'The AI server rejected the request — check the RAG token.';
const FRIENDLY = {
  400: 'The AI server rejected the request.',
  401: AUTH_MESSAGE,
  403: AUTH_MESSAGE,
  404: 'Document index expired — press Send to re-index.',
  413: 'The document is too large for the AI server.',
  422: 'The AI server could not process this document.',
  429: 'The AI server is busy — try again in a moment.',
};

function _timeoutSignal(signal, ms) {
  const timeout = AbortSignal.timeout(ms);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

async function _httpError(res) {
  const raw = await res.text().catch(() => '');
  let detail = raw;
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed?.detail === 'string') detail = parsed.detail;
  } catch { /* not JSON — keep the raw text */ }

  let message = FRIENDLY[res.status] || `The AI server returned an error (${res.status}).`;
  // 413/422 carry a specific, human-readable reason from the server
  // ("PDF is password-protected", "PDF has 600 pages; the limit is 500")
  if ((res.status === 413 || res.status === 422) && detail.length <= 200) message = detail;

  console.warn('[rag] server answered %d: %s', res.status, detail);
  const err = new Error(message);
  err.detail = detail;
  err.status = res.status;
  return err;
}

function _networkError(err) {
  if (err?.name === 'AbortError') return err;   // caller cancelled — pass through
  if (err?.name === 'TimeoutError') return new Error('The AI server did not answer in time. Try again.');
  return new Error("Can't reach the local AI server. Is it running?");
}

// One SSE frame → { event, data }; null for frames without usable data
function _parseFrame(frame) {
  let event = 'message';
  const data = [];
  for (const line of frame.split('\n')) {
    if (line.startsWith('event: ')) event = line.slice(7).trim();
    else if (line.startsWith('data: ')) data.push(line.slice(6));
  }
  if (!data.length) return null;
  try {
    return { event, data: JSON.parse(data.join('\n')) };
  } catch {
    return null;   // garbled frame — skip it rather than kill the stream
  }
}

export class RagManager {
  constructor(app) {
    this.app = app;
    this.ready = false;
    // Per-tab doc ids — the only source of truth (a question must never be
    // answered from another tab's document)
    this.docIdsByTabId = new Map();
  }

  // ─── Server health ────────────────────────────────────────────────────────

  async checkStatus() {
    try {
      const res = await fetch(`${RAG_BASE}/status`, { signal: AbortSignal.timeout(5_000) });
      const data = await res.json();
      this.ready = data.ready === true;
    } catch {
      this.ready = false;
    }
    return this.ready;
  }

  /**
   * Clear any cached doc id for a tab (call when a tab closes).
   * @param {string} tabId
   */
  clearTab(tabId) {
    if (!tabId) return;
    this.docIdsByTabId.delete(tabId);
  }

  /**
   * Get the cached doc id for a tab.
   * @param {string} tabId
   */
  getDocIdForTab(tabId) {
    return tabId ? (this.docIdsByTabId.get(tabId) || null) : null;
  }

  // ─── Ingest ───────────────────────────────────────────────────────────────

  /**
   * @param {Uint8Array|ArrayBuffer} pdfBytes - raw PDF data
   * @param {string} filename
   * @param {string|null} tabId - caches the returned doc_id for this tab
   * @param {AbortSignal|null} signal - caller's cancel signal
   * @returns {Promise<{ doc_id: string, chunk_count: number, message: string }>}
   */
  async ingest(pdfBytes, filename = 'document.pdf', tabId = null, signal = null) {
    const form = new FormData();
    form.append('file', new Blob([pdfBytes], { type: 'application/pdf' }), filename);

    let res;
    try {
      res = await fetch(`${RAG_BASE}/ingest`, {
        method: 'POST',
        headers: AUTH_HEADERS,
        body: form,
        signal: _timeoutSignal(signal, INGEST_TIMEOUT_MS),
      });
    } catch (err) {
      throw _networkError(err);
    }
    if (!res.ok) throw await _httpError(res);

    const data = await res.json();
    if (tabId) this.docIdsByTabId.set(tabId, data.doc_id);
    return data;
  }

  // ─── Query ────────────────────────────────────────────────────────────────

  /**
   * @param {string} question
   * @param {number} k  - number of chunks to retrieve
   * @param {string} tabId - the tab whose document this question is about
   * @param {AbortSignal|null} signal - caller's cancel signal
   * @returns {Promise<{ answer: string, sources: Array, warnings: string[], mock: boolean }>}
   */
  async query(question, k = 5, tabId = null, signal = null) {
    const docId = this.getDocIdForTab(tabId);
    if (!docId) throw new Error('This tab has no indexed document yet.');

    let res;
    try {
      res = await fetch(`${RAG_BASE}/query`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...AUTH_HEADERS },
        body: JSON.stringify({ doc_id: docId, q: question, k }),
        signal: _timeoutSignal(signal, QUERY_TIMEOUT_MS),
      });
    } catch (err) {
      throw _networkError(err);
    }
    if (!res.ok) throw await _httpError(res);
    return res.json();
  }

  /**
   * The same question, streamed. Yields { event, data } frames in arrival
   * order: sources → delta* → (done | error).
   * @param {Array<{role: 'user'|'assistant', content: string}>} history - prior turns
   * @returns {AsyncGenerator<{ event: string, data: any }>}
   */
  async *queryStream(question, k = 5, tabId = null, signal = null, history = []) {
    const docId = this.getDocIdForTab(tabId);
    if (!docId) throw new Error('This tab has no indexed document yet.');

    let res;
    try {
      res = await fetch(`${RAG_BASE}/query/stream`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...AUTH_HEADERS },
        body: JSON.stringify({ doc_id: docId, q: question, k, history }),
        signal: _timeoutSignal(signal, QUERY_TIMEOUT_MS),
      });
    } catch (err) {
      throw _networkError(err);
    }
    if (!res.ok) throw await _httpError(res);   // 401/404/422 are ordinary JSON

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let sep;
        while ((sep = buf.indexOf('\n\n')) !== -1) {
          const frame = _parseFrame(buf.slice(0, sep));
          buf = buf.slice(sep + 2);
          if (frame) yield frame;
        }
      }
    } catch (err) {
      throw _networkError(err);            // abort / timeout mid-answer
    } finally {
      reader.cancel().catch(() => {});     // release the body when the caller stops early
    }
  }
}

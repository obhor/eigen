/**
 * check-rag-client.mjs — the chat client's error/timeout/abort contract (audit H9).
 * Stubs global fetch; no server needed.
 * Run: node check-rag-client.mjs   (also part of `npm run check`)
 */
import assert from 'node:assert/strict';
import { RagManager } from './eigen-rag/client/RagManager.js';

const seen = [];
const collect = (err) => { seen.push(err.message); return err; };

const rag = new RagManager({});
rag.docIdsByTabId.set('tab-1', 'doc-1');   // pretend tab-1 was ingested

function stubFetch(handler) { globalThis.fetch = handler; }
function jsonResponse(status, body, ok = status < 400) {
  return { ok, status, text: async () => JSON.stringify(body), json: async () => body };
}

// SSE response stub; hands the body over in 7-byte reads so frames are
// deliberately split mid-frame like a real network stream
function sseBody(bytes, chunkSize = 7) {
  return {
    getReader() {
      let i = 0;
      return {
        read: async () => {
          if (i >= bytes.length) return { value: undefined, done: true };
          const value = bytes.slice(i, i + chunkSize);
          i += chunkSize;
          return { value, done: false };
        },
        cancel: async () => {},
      };
    },
  };
}
function sseResponse({ sources = [], mock = false, deltas = [], warnings = [], error = null }) {
  let body = `event: sources\ndata: ${JSON.stringify({ sources, mock })}\n\n`;
  for (const text of deltas) body += `event: delta\ndata: ${JSON.stringify({ text })}\n\n`;
  body += error
    ? `event: error\ndata: ${JSON.stringify({ message: error })}\n\n`
    : `event: done\ndata: ${JSON.stringify({ warnings })}\n\n`;
  return { ok: true, status: 200, body: sseBody(new TextEncoder().encode(body)) };
}

// ── 1. HTTP status → friendly message; raw body only in .detail ─────────────
const messages = {};
for (const [status, detail] of [
  [401, 'Missing or invalid RAG token'],
  [403, 'Forbidden'],
  [404, 'No index for doc_id: 8f3c-...'],
  [429, 'Too many requests'],
  [500, 'Traceback: internal server error'],
]) {
  stubFetch(async () => jsonResponse(status, { detail }));
  const err = await rag.query('q', 5, 'tab-1').catch(collect);
  assert.ok(err instanceof Error, `status ${status} must reject`);
  assert.equal(err.status, status);
  assert.equal(err.detail, detail, 'raw server body must be kept for the console');
  messages[status] = err.message;
}
assert.equal(messages[404], 'Document index expired — press Send to re-index.');
assert.equal(messages[401], messages[403]);
assert.notEqual(messages[500], messages[429]);

// ── 2. transport failures: offline vs timeout vs abort ──────────────────────
stubFetch(async () => { throw new TypeError('Failed to fetch'); });
let err = await rag.query('q', 5, 'tab-1').catch(collect);
assert.equal(err.message, "Can't reach the local AI server. Is it running?");

stubFetch(async () => { throw new DOMException('The operation was aborted due to timeout', 'TimeoutError'); });
err = await rag.query('q', 5, 'tab-1').catch(collect);
assert.equal(err.message, 'The AI server did not answer in time. Try again.');

let capturedSignal = null;
stubFetch((url, opts) => {
  capturedSignal = opts.signal;
  return new Promise((_, reject) => {
    opts.signal.addEventListener('abort', () =>
      reject(new DOMException('The operation was aborted.', 'AbortError')));
  });
});
const ctrl = new AbortController();
const pending = rag.query('q', 5, 'tab-1', ctrl.signal).catch(collect);
await Promise.resolve();
assert.ok(capturedSignal instanceof AbortSignal, 'fetch must receive an abort signal');
ctrl.abort();
err = await pending;
assert.equal(err.name, 'AbortError', 'cancel must reach the caller as AbortError');

// ── 3. per-tab doc ids only — no cross-tab fallback ─────────────────────────
const bodies = [];
stubFetch(async (url, opts) => {
  if (url.endsWith('/ingest')) return jsonResponse(200, { doc_id: 'doc-9', message: 'Indexed 3 pages' });
  bodies.push(JSON.parse(opts.body));
  return jsonResponse(200, { answer: 'ok', sources: [] });
});

const data = await rag.ingest(new Uint8Array([1, 2, 3]), 'x.pdf', 'tab-9');
assert.equal(data.doc_id, 'doc-9');
assert.equal(rag.getDocIdForTab('tab-9'), 'doc-9');
assert.ok(!('docId' in rag), 'the legacy single-doc field must be gone');

await rag.query('q', 5, 'tab-9');
assert.equal(bodies.at(-1).doc_id, 'doc-9');

err = await rag.query('q', 5, 'tab-2').catch(collect);
assert.equal(err.message, 'This tab has no indexed document yet.');
assert.equal(bodies.length, 1, 'an unindexed tab must not be answered from another tab');

// ── 4. 413/422 surface the server's own human-readable reason ───────────────
stubFetch(async () => jsonResponse(422, { detail: 'PDF is password-protected' }));
err = await rag.ingest(new Uint8Array([1]), 'x.pdf', 'tab-9').catch(collect);
assert.equal(err.message, 'PDF is password-protected');

// ── 4b. queryStream: SSE frames survive being split mid-frame ───────────────
stubFetch(async () => sseResponse({
  sources: [{ id: 'c1', page: 2, text: 'zebra' }],
  deltas: ['Zebra ', 'spotted ', '[Source 1].'],
  warnings: ['note'],
}));
const frames = [];
for await (const f of rag.queryStream('q', 5, 'tab-1')) frames.push(f);
assert.deepEqual(frames.map((f) => f.event), ['sources', 'delta', 'delta', 'delta', 'done']);
assert.equal(frames[0].data.sources[0].page, 2);
assert.equal(frames.filter((f) => f.event === 'delta').map((f) => f.data.text).join(''),
  'Zebra spotted [Source 1].');
assert.deepEqual(frames.at(-1).data.warnings, ['note']);

// a provider failure mid-answer arrives as an error frame, not a rejection
stubFetch(async () => sseResponse({ deltas: ['half an answer '], error: 'AI provider timed out' }));
const events2 = [];
for await (const f of rag.queryStream('q', 5, 'tab-1')) events2.push(f);
assert.deepEqual(events2.map((f) => f.event), ['sources', 'delta', 'error']);
assert.equal(events2.at(-1).data.message, 'AI provider timed out');

// retrieval failures (401/404/422) reject as ordinary JSON before any frame
stubFetch(async () => jsonResponse(404, { detail: 'No index for doc_id: 8f3c-...' }));
err = await rag.queryStream('q', 5, 'tab-1').next().catch(collect);
assert.equal(err.message, 'Document index expired — press Send to re-index.');

// an abort mid-stream reaches the caller as AbortError
stubFetch(async (url, opts) => ({
  ok: true,
  status: 200,
  body: {
    getReader: () => ({
      read: () => new Promise((_, reject) => opts.signal.addEventListener('abort',
        () => reject(new DOMException('The operation was aborted.', 'AbortError')))),
      cancel: async () => {},
    }),
  },
}));
const streamCtrl = new AbortController();
const pendingFrame = rag.queryStream('q', 5, 'tab-1', streamCtrl.signal).next();
await Promise.resolve();
streamCtrl.abort();
err = await pendingFrame.catch(collect);
assert.equal(err.name, 'AbortError', 'mid-stream cancel must pass through');

// ── 5. no user-facing string names a URL ────────────────────────────────────
for (const m of seen) assert.ok(!m.toLowerCase().includes('http'), `leaks a URL: ${m}`);

console.log('ok: rag client — status→message mapping, detail kept raw, offline/timeout/abort '
  + 'taxonomy, per-tab doc ids (no cross-tab fallback), server reasons surfaced, no URLs shown, '
  + 'SSE frames survive mid-frame splits, error frames + mid-stream abort pass through');

// ═════════════════════════════════════════════════════════════════════════════
// AIChatPanel state machine — minimal DOM stub, no browser needed (audit H9/H10)
// ═════════════════════════════════════════════════════════════════════════════
class El {
  constructor(tag = 'div') {
    this.tag = tag;
    this.children = [];
    this.className = '';
    this._text = '';
    this._listeners = {};
    this.classList = {
      _s: new Set(),
      add: (c) => this.classList._s.add(c),
      remove: (c) => this.classList._s.delete(c),
      contains: (c) => this.classList._s.has(c),
    };
    this.style = {};
  }
  set textContent(v) { this._text = v; this.children = []; }  // mirrors the DOM's clear-on-set
  get textContent() { return this._text; }
  get scrollHeight() { return 0; }
  appendChild(child) { this.children.push(child); return child; }
  setAttribute() {}
  addEventListener(type, fn) { this._listeners[type] = fn; }
  click() { this._listeners.click?.(); }
}

const nodes = {};
for (const id of ['ai-chat-panel', 'ai-chat-overlay', 'btn-ai-chat-close',
                  'ai-chat-form', 'ai-chat-text', 'ai-chat-send', 'ai-chat-messages']) {
  nodes[id] = new El();
}
globalThis.document = {
  getElementById: (id) => nodes[id] || null,
  createElement: (tag) => new El(tag),
  addEventListener: () => {},
};

function walk(el, fn) {
  fn(el);
  for (const c of el.children) walk(c, fn);
}
const texts = (el) => { const out = []; walk(el, (n) => { if (n._text) out.push(n._text); }); return out; };
const byClass = (el, cls) => {
  const out = [];
  walk(el, (n) => { if (String(n.className).split(' ').includes(cls)) out.push(n); });
  return out;
};
const waitFor = async (pred, what) => {
  for (let i = 0; i < 200; i++) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`timed out waiting for ${what}`);
};

const chat = () => nodes['ai-chat-messages'];
const chatText = () => texts(chat()).join(' | ');

const handlers = {};
let activeTab = { id: 't1', name: 'a.pdf' };
const goToCalls = [];
const doc = { numPages: 3, getData: async () => new Uint8Array([1, 2, 3]) };
const panelApp = {
  tabManager: {
    on: (ev, fn) => { handlers[ev] = fn; },
    getActiveTab: () => activeTab,
  },
  pdfRenderer: {
    getDocument: (id) => (id === 't1' ? doc : null),
    goToPage: (...args) => goToCalls.push(args),
  },
};
const panelRag = new RagManager(panelApp);
panelApp.ragManager = panelRag;

let release = null;
let gates = 0;   // one per query fetch — the test drives when each answer lands
let queryPayload = {
  answer: 'Zebra spotted [Source 1].',
  sources: [{ id: 'c1', page: 2, text: 'zebra' }, { id: 'c2', page: 2, text: 'zebra again' }, { id: 'c3', page: 5, text: 'zebra' }],
  warnings: ['A sentence citing [Source 1] has no wording in common with that source.'],
  mock: false,
};
const asSse = (p) => sseResponse({
  sources: p.sources, mock: p.mock, warnings: p.warnings, error: p.error,
  deltas: String(p.answer || '').match(/\S+\s*/g) || [],
});
const panelBodies = [];
stubFetch(async (url, opts) => {
  if (url.endsWith('/ingest')) {
    return jsonResponse(200, { doc_id: 'doc-t1', message: 'Indexed 3 pages (1 via OCR), 5 chunks' });
  }
  panelBodies.push(JSON.parse(opts.body));
  gates += 1;
  await new Promise((r) => { release = r; });          // query hangs until the test releases it
  return asSse(queryPayload);
});
const nextQuery = async () => {
  const seen = gates;
  await waitFor(() => gates > seen, 'the query request');
};

const { AIChatPanel } = await import('./src/js/AIChatPanel.js');
const panel = new AIChatPanel(panelApp);

// 6a. happy path: status bubbles → system line → answer with chips and warnings
nodes['ai-chat-text'].value = 'where is the zebra?';
panel._submit();
// the Indexing bubble is pushed synchronously, before the first await
assert.ok(chatText().includes('Indexing 3 pages… (first ask only)'), chatText());
await waitFor(() => chatText().includes('Searching…'), 'the Searching… bubble');
assert.ok(chatText().includes('Indexed 3 pages (1 via OCR), 5 chunks'), chatText());
assert.ok(nodes['ai-chat-text'].disabled, 'input must be disabled while busy');

// 6b. a second submit while busy is ignored outright (H9 race)
nodes['ai-chat-text'].value = 'second question';
panel._submit();
assert.equal(nodes['ai-chat-text'].value, 'second question', 'input must not be cleared');
assert.equal(byClass(chat(), 'ai-chat-bubble').filter((b) => b.className.includes('user')).length, 1);

release();
await waitFor(() => chatText().includes('Zebra spotted'), 'the answer');
assert.ok(chatText().includes('has no wording in common'), 'citation warning must render');
assert.deepEqual(byClass(chat(), 'ai-chat-source-chip').map((c) => c._text), ['p.2', 'p.5']);
assert.equal(byClass(chat(), 'ai-chat-badge').length, 0, 'grounded answer needs no badge');
assert.ok(!nodes['ai-chat-text'].disabled, 'input must re-enable when idle');

byClass(chat(), 'ai-chat-source-chip')[0].click();
assert.deepEqual(goToCalls, [['t1', 2]], 'chip must jump to its page');
assert.deepEqual(panelBodies.at(-1).history, [], 'the first question carries no history');

// 6c. mock + ungrounded answers get badged
queryPayload = { answer: 'Not found in document. Pluto is a planet.', sources: [], warnings: [], mock: true };
nodes['ai-chat-text'].value = 'and pluto?';
panel._submit();
await nextQuery();
release();
await waitFor(() => chatText().includes('Pluto is a planet'), 'the second answer');
assert.deepEqual(byClass(chat(), 'ai-chat-badge').map((b) => b._text), ['not in document', 'mock']);

// 6d. cancel: bubble says so, and the late server answer is dropped (seq guard)
queryPayload = { answer: 'CANCELLED-ANSWER', sources: [], warnings: [], mock: false };
nodes['ai-chat-text'].value = 'third question';
panel._submit();
await nextQuery();
// follow-ups carry this tab's own last exchanges, not the tail of a render
assert.deepEqual(panelBodies.at(-1).history, [
  { role: 'user', content: 'where is the zebra?' },
  { role: 'assistant', content: 'Zebra spotted [Source 1].' },
  { role: 'user', content: 'and pluto?' },
  { role: 'assistant', content: 'Not found in document. Pluto is a planet.' },
]);
assert.ok(chatText().includes('Searching…'), chatText());
byClass(chat(), 'ai-chat-cancel')[0].click();
assert.ok(chatText().includes('(cancelled)'), chatText());
release();
await new Promise((r) => setTimeout(r, 30));
assert.ok(!chatText().includes('CANCELLED-ANSWER'), 'a cancelled answer must never land');
assert.equal(texts(chat()).filter((t) => t.includes('third question')).length, 1);
assert.equal(byClass(chat(), 'ai-chat-cancel').length, 0, 'no cancel button once idle');

// 6e. per-tab transcripts: switching shows that tab's own session (H10)
const tab1 = { id: 't1', name: 'a.pdf' };
activeTab = { id: 't2', name: 'b.pdf' };
handlers.tabChanged('t2');
assert.ok(!chatText().includes('where is the zebra?'), 'tab 2 must not show tab 1 history');
assert.equal(byClass(chat(), 'ai-chat-bubble').length, 0, 'tab 2 starts with an empty transcript');
assert.ok(chatText().includes('first ask indexes it'), chatText());

activeTab = tab1;
handlers.tabChanged('t1');
assert.ok(chatText().includes('where is the zebra?'), 'tab 1 transcript must come back');

handlers.tabClosed('t1');
assert.ok(!chatText().includes('where is the zebra?'), 'closing a tab drops its session');

// 6f. deltas paint into the bubble while the stream is still open
let feed = null;
stubFetch(async () => ({
  ok: true,
  status: 200,
  body: { getReader: () => ({ read: () => new Promise((r) => { feed = r; }), cancel: async () => {} }) },
}));
const pushFrame = async (text, done = false) => {
  await waitFor(() => !!feed, 'the next stream read');
  const resolve = feed;
  feed = null;
  resolve(done ? { value: undefined, done: true } : { value: new TextEncoder().encode(text), done: false });
};

nodes['ai-chat-text'].value = 'stream it';
panel._submit();
await waitFor(() => !!feed, 'the stream reader');
await pushFrame('event: sources\ndata: {"sources":[{"page":4,"text":"z"}],"mock":false}\n\n'
  + 'event: delta\ndata: {"text":"Half "}\n\n');
await waitFor(() => chatText().includes('Half'), 'the first delta');
assert.ok(!chatText().includes('Searching'), 'the status text is replaced by the answer');
await pushFrame('event: delta\ndata: {"text":"an answer"}\n\n'
  + 'event: done\ndata: {"warnings":[]}\n\n');
await pushFrame('', true);
await waitFor(() => chatText().includes('Half an answer'), 'the finished answer');
assert.ok(byClass(chat(), 'ai-chat-bubble').at(-1).className.includes('assistant'),
  'the streamed bubble finalizes as an assistant message');
assert.deepEqual(byClass(chat(), 'ai-chat-source-chip').map((c) => c._text), ['p.4']);

console.log('ok: chat panel — busy submit ignored, status→system→answer flow, sources chips jump, '
  + 'mock/ungrounded badges, cancel + seq guard, per-tab transcripts, close drops session, '
  + 'deltas paint live mid-stream');

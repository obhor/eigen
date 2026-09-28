/**
 * check-rag-client.mjs — the browser RAG engine (audit H9) and the chat panel
 * state machine (audit H9/H10). Everything runs locally with a fake embedder
 * and a stubbed fetch; no model, no proxy, no browser.
 * Run: node check-rag-client.mjs   (also part of `npm run check`)
 */
import assert from 'node:assert/strict';
import { RagManager } from './eigen-rag/client/RagManager.js';

const seen = [];
const collect = (err) => { seen.push(err.message); return err; };

// drains a generator that is expected to fail — the first frame is already
// yielded before the proxy call, so a single .next() would not see the error
async function failure(gen) {
  let caught = null;
  try {
    for await (const _ of gen) { /* keep pulling until it breaks */ }
  } catch (err) {
    caught = err;
  }
  assert.ok(caught, 'expected the stream to fail');
  return collect(caught);
}

// ── stubs ───────────────────────────────────────────────────────────────────
function stubFetch(handler) { globalThis.fetch = handler; }
const jsonResponse = (status, body) => ({
  ok: status < 400, status, text: async () => JSON.stringify(body),
});

// hands the body over in small reads so records split mid-frame like a real stream
function streamBody(bytes, chunkSize = 7) {
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
const geminiSse = (records, chunkSize = 7) => ({
  ok: true,
  status: 200,
  text: async () => '',
  body: streamBody(
    new TextEncoder().encode(records.map((r) => `data: ${JSON.stringify(r)}\n\n`).join('')),
    chunkSize,
  ),
});
const rec = (text) => ({ candidates: [{ content: { parts: [{ text }] } }] });

// Deterministic stand-in for MiniLM: one-hot on the keyword the text mentions,
// so retrieval order is pinned by construction.
const KEYS = ['zebra', 'penguin', 'mask'];
const vecFor = (text) => {
  const t = String(text).toLowerCase();
  const v = new Float32Array(KEYS.length);
  KEYS.forEach((k, i) => { if (t.includes(k)) v[i] = 1; });
  return v;
};
function fakeEmbedder(progress = []) {
  let first = true;
  return async (texts, { onProgress } = {}) => {
    if (first) {
      first = false;
      onProgress?.({ phase: 'model', loaded: 1, total: 2 });   // only the worker reports this
    }
    return texts.map(vecFor);
  };
}

const stubDoc = (texts) => ({
  numPages: texts.length,
  getPage: async (i) => ({ getTextContent: async () => ({ items: [{ str: texts[i - 1], hasEOL: false }] }) }),
});

// ── 1. ingest: local extraction → chunking → embedding ──────────────────────
const phases = [];
const rag = new RagManager({}, { embedder: fakeEmbedder() });
const docA = stubDoc(['The zebra lives in Africa.', 'Penguins live in the south.']);

const info = await rag.ingest(docA, 'tab-1', null, (p) => phases.push(p));
assert.equal(info.page_count, 2);
assert.equal(info.chunk_count, 2);
assert.equal(info.ocr_pages, 0);
assert.match(info.message, /Indexed 2 chunks from 2 pages/);
assert.ok(info.doc_id, 'ingest must return a doc id');
assert.equal(rag.getDocIdForTab('tab-1'), info.doc_id);
assert.ok(!('docId' in rag), 'the legacy single-doc field must be gone');
assert.deepEqual(phases.map((p) => p.phase), ['extract', 'extract', 'model', 'embed']);
assert.deepEqual(phases.filter((p) => p.phase === 'extract').map((p) => p.done), [1, 2]);

// ── 2. per-tab indexes only — no cross-tab fallback ─────────────────────────
const unindexed = await rag.queryStream('q', 5, 'tab-2').next().catch(collect);
assert.equal(unindexed.message, 'This tab has no indexed document yet.');

rag.clearTab('tab-1');
assert.equal(rag.getDocIdForTab('tab-1'), null, 'clearTab must free the index');
const cleared = await rag.queryStream('q', 5, 'tab-1').next().catch(collect);
assert.equal(cleared.message, 'This tab has no indexed document yet.');

// ── 3. query: proxy request shape, streamed frames, citation checks ─────────
await rag.ingest(docA, 'tab-1', null, null);

let proxyBody = null;
let proxyUrl = null;
stubFetch(async (url, opts) => {
  proxyUrl = url;
  proxyBody = JSON.parse(opts.body);
  return geminiSse([rec('Zebra '), rec('spotted '), rec('[Source 1].')]);
});

const frames = [];
for await (const f of rag.queryStream('where is the zebra?', 5, 'tab-1')) frames.push(f);
assert.deepEqual(frames.map((f) => f.event), ['sources', 'delta', 'delta', 'delta', 'done']);
assert.equal(frames[0].data.sources[0].text, 'The zebra lives in Africa.', 'dense ranks the match first');
assert.equal(frames.filter((f) => f.event === 'delta').map((f) => f.data.text).join(''), 'Zebra spotted [Source 1].');
assert.equal(frames.filter((f) => f.event === 'delta').length, 3, 'the stream was split mid-record by the stub');
assert.deepEqual(frames.at(-1).data.warnings, [], 'a grounded, well-cited answer warns about nothing');

assert.ok(proxyUrl, 'the answer must go through the key-holder proxy');
assert.deepEqual(proxyBody.contents.map((c) => c.role), ['user'], 'system goes in systemInstruction');
assert.match(proxyBody.systemInstruction.parts[0].text, /SOURCE excerpts/);
assert.match(proxyBody.contents.at(-1).parts[0].text, /<document>/);
assert.match(proxyBody.contents.at(-1).parts[0].text, /Question: where is the zebra\?/);

// citations the sources cannot back up are reported, not silently accepted
stubFetch(async () => geminiSse([rec('Completely different wording here [Source 1].')]));
const warned = [];
for await (const f of rag.queryStream('where is the zebra?', 5, 'tab-1')) warned.push(f);
assert.match(warned.at(-1).data.warnings.join(' '), /no wording in common/);

stubFetch(async () => geminiSse([rec('Zebra [Source 9].')]));
const outOfRange = [];
for await (const f of rag.queryStream('where is the zebra?', 5, 'tab-1')) outOfRange.push(f);
assert.match(outOfRange.at(-1).data.warnings.join(' '), /unknown source number/);

// ── 4. the proxy's failure modes stay friendly, detail stays console-only ───
stubFetch(async () => jsonResponse(429, { error: 'quota exceeded' }));
let err = await failure(rag.queryStream('q', 5, 'tab-1'));
assert.equal(err.message, 'The AI service is busy or out of quota — try again later.');
assert.equal(err.detail, 'quota exceeded', 'raw proxy body must be kept for the console');
assert.equal(err.status, 429);

stubFetch(async () => jsonResponse(403, { error: 'Forbidden' }));
err = await failure(rag.queryStream('q', 5, 'tab-1'));
assert.equal(err.message, 'The AI service rejected the request.');

stubFetch(async () => { throw new TypeError('Failed to fetch'); });
err = await failure(rag.queryStream('q', 5, 'tab-1'));
assert.equal(err.message, "Can't reach the AI service. Check your connection.");

stubFetch(async () => { throw new DOMException('The operation was aborted due to timeout', 'TimeoutError'); });
err = await failure(rag.queryStream('q', 5, 'tab-1'));
assert.equal(err.message, 'The AI service did not answer in time. Try again.');

// an error record mid-stream is an Error, not a silent half-answer
stubFetch(async () => geminiSse([rec('half an answer '), { error: { message: 'upstream boom' } }]));
err = await failure(rag.queryStream('q', 5, 'tab-1'));
assert.equal(err.message, 'upstream boom');

stubFetch(async () => geminiSse([{ promptFeedback: { blockReason: 'SAFETY' } }]));
err = await failure(rag.queryStream('q', 5, 'tab-1'));
assert.equal(err.message, 'The AI service refused to answer this question.');

// ── 5. cancel: abort before and during the stream reaches the caller ────────
let fetchSignal = null;
stubFetch((url, opts) => {
  fetchSignal = opts.signal;
  return new Promise((_, reject) => {
    opts.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
  });
});
const ctrl = new AbortController();
const pending = failure(rag.queryStream('q', 5, 'tab-1', ctrl.signal));
await new Promise((r) => setTimeout(r, 5));
assert.ok(fetchSignal instanceof AbortSignal, 'the proxy call must carry an abort signal');
ctrl.abort();
err = await pending;
assert.equal(err.name, 'AbortError', 'cancel must reach the caller as AbortError');

stubFetch(async (url, opts) => ({
  ok: true,
  status: 200,
  text: async () => '',
  body: {
    getReader: () => ({
      // mirrors a real fetch: aborting the signal kills the body stream too
      read: () => new Promise((_, reject) => opts.signal.addEventListener('abort',
        () => reject(new DOMException('aborted', 'AbortError')))),
      cancel: async () => {},
    }),
  },
}));
const midCtrl = new AbortController();
const midFrame = failure(rag.queryStream('q', 5, 'tab-1', midCtrl.signal));
await new Promise((r) => setTimeout(r, 5));
midCtrl.abort();
err = await midFrame;
assert.equal(err.name, 'AbortError', 'mid-stream cancel must pass through');

// ── 6. the caps: scanned PDFs, oversize documents, truncation ───────────────
err = await rag.ingest(stubDoc(['   ']), 'tab-3').catch(collect);
assert.match(err.message, /no selectable text/);

err = await rag.ingest({ numPages: 301, getPage: async () => ({}) }, 'tab-3').catch(collect);
assert.equal(err.message, 'This PDF has 301 pages; the limit is 300.');

const manyPages = Array.from({ length: 300 }, (_, p) =>
  Array.from({ length: 60 }, (_, i) => `Sentence ${i} on page ${p} about zebras in the wild.`).join(' '));
const big = await rag.ingest(stubDoc(manyPages), 'tab-4');
assert.equal(big.chunk_count, 1200, 'the index is capped');
assert.match(big.message, /Indexed the first 1200 of \d+ chunks/);

// ── 7. no user-facing string names a URL ────────────────────────────────────
for (const m of seen) assert.ok(!m.toLowerCase().includes('http'), `leaks a URL: ${m}`);

console.log('ok: rag engine — local ingest/chunk/embed with progress, per-tab indexes (no cross-tab '
  + 'fallback), clearTab frees, Gemini-shaped proxy body, mid-frame-split SSE → sources→delta*→done, '
  + 'citation warnings, friendly errors with raw detail, offline/timeout/abort taxonomy, '
  + 'scanned + oversize + truncation caps, no URLs shown');

// ═════════════════════════════════════════════════════════════════════════════
// AIChatPanel state machine — minimal DOM stub, fake ragManager (audit H9/H10)
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

// A push-driven stand-in for RagManager: the test decides when each frame lands.
function makeFakeRag() {
  const state = { indexed: new Set(), ingestCalls: [], queries: [], queue: [], done: false, wake: null, onProgressStep: null };
  const wake = () => { const w = state.wake; state.wake = null; w?.(); };
  const push = (frame) => { state.queue.push(frame); wake(); };
  const end = () => { state.done = true; wake(); };
  const ragManager = {
    getDocIdForTab: (tabId) => (state.indexed.has(tabId) ? `doc-${tabId}` : null),
    clearTab: (tabId) => state.indexed.delete(tabId),
    ingest: async (pdfDoc, tabId, signal, onProgress) => {
      state.ingestCalls.push({ pdfDoc, tabId, signal });
      for (const p of [
        { phase: 'model', loaded: 5, total: 10 },
        { phase: 'extract', done: 2, total: 3 },
        { phase: 'embed', done: 5, total: 5 },
      ]) {
        await Promise.resolve();   // progress arrives over time, not all at once
        onProgress?.(p);
        state.onProgressStep?.();
      }
      state.indexed.add(tabId);
      return { doc_id: `doc-${tabId}`, chunk_count: 5, page_count: 3, ocr_pages: 0, message: 'Indexed 5 chunks from 3 pages.' };
    },
    async *queryStream(question, k, tabId, signal, history) {
      state.queue = [];
      state.done = false;
      state.queries.push({ question, k, tabId, signal, history });
      for (;;) {
        while (!state.queue.length && !state.done) {
          await new Promise((r) => { state.wake = r; });
        }
        if (!state.queue.length && state.done) return;
        yield state.queue.shift();
      }
    },
  };
  return { state, push, end, ragManager };
}

const handlers = {};
let activeTab = { id: 't1', name: 'a.pdf' };
const goToCalls = [];
// getData throws: the panel must hand the open document over, never the bytes
const doc = { numPages: 3, getData: () => { throw new Error('the panel must not read the PDF bytes'); } };
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
const fake = makeFakeRag();
panelApp.ragManager = fake.ragManager;

const { AIChatPanel } = await import('./src/js/AIChatPanel.js');
const panel = new AIChatPanel(panelApp);

// 8a. happy path: progress → system line → answer with chips and warnings
const progressTexts = [];
fake.state.onProgressStep = () => progressTexts.push(chatText());
nodes['ai-chat-text'].value = 'where is the zebra?';
panel._submit();
// the status bubble is pushed synchronously, before the first await
assert.ok(chatText().includes('Reading the document…'), chatText());
await waitFor(() => chatText().includes('Searching…'), 'the Searching… bubble');
assert.ok(chatText().includes('Indexed 5 chunks from 3 pages.'), chatText());
assert.ok(progressTexts[0].includes('Loading the search model 50%… (first time only)'), progressTexts[0]);
assert.ok(progressTexts[1].includes('Reading page 2/3…'), progressTexts[1]);
assert.ok(progressTexts[2].includes('Indexing 5/5 chunks…'), progressTexts[2]);
assert.equal(fake.state.ingestCalls[0].pdfDoc, doc, 'the panel must hand over the open document');
assert.ok(nodes['ai-chat-text'].disabled, 'input must be disabled while busy');

// 8b. a second submit while busy is ignored outright (H9 race)
nodes['ai-chat-text'].value = 'second question';
panel._submit();
assert.equal(nodes['ai-chat-text'].value, 'second question', 'input must not be cleared');
assert.equal(byClass(chat(), 'ai-chat-bubble').filter((b) => b.className.includes('user')).length, 1);

fake.push({ event: 'sources', data: { sources: [
  { id: 'c1', page: 2, text: 'zebra' }, { id: 'c2', page: 2, text: 'zebra again' }, { id: 'c3', page: 5, text: 'zebra' },
] } });
fake.push({ event: 'delta', data: { text: 'Zebra spotted ' } });
fake.push({ event: 'delta', data: { text: '[Source 1].' } });
fake.push({ event: 'done', data: { warnings: ['A sentence citing [Source 1] has no wording in common with that source.'] } });
fake.end();

await waitFor(() => chatText().includes('Zebra spotted'), 'the answer');
assert.ok(chatText().includes('has no wording in common'), 'citation warning must render');
assert.deepEqual(byClass(chat(), 'ai-chat-source-chip').map((c) => c._text), ['p.2', 'p.5']);
assert.equal(byClass(chat(), 'ai-chat-badge').length, 0, 'grounded answer needs no badge');
assert.ok(!nodes['ai-chat-text'].disabled, 'input must re-enable when idle');

byClass(chat(), 'ai-chat-source-chip')[0].click();
assert.deepEqual(goToCalls, [['t1', 2]], 'chip must jump to its page');
assert.deepEqual(fake.state.queries.at(-1).history, [], 'the first question carries no history');
assert.equal(fake.state.queries.length, 1, 'an indexed tab is not re-ingested');

// 8c. an ungrounded answer is badged
nodes['ai-chat-text'].value = 'and pluto?';
panel._submit();
await waitFor(() => fake.state.queries.length === 2, 'the second query');
fake.push({ event: 'sources', data: { sources: [] } });
fake.push({ event: 'delta', data: { text: 'Not found in document. Pluto is a planet.' } });
fake.push({ event: 'done', data: { warnings: [] } });
fake.end();
await waitFor(() => chatText().includes('Pluto is a planet'), 'the second answer');
assert.deepEqual(byClass(chat(), 'ai-chat-badge').map((b) => b._text), ['not in document']);

// 8d. cancel: bubble says so, and the late answer is dropped (seq guard)
nodes['ai-chat-text'].value = 'third question';
panel._submit();
await waitFor(() => fake.state.queries.length === 3, 'the third query');
// follow-ups carry this tab's own last exchanges, not the tail of a render
assert.deepEqual(fake.state.queries.at(-1).history, [
  { role: 'user', content: 'where is the zebra?' },
  { role: 'assistant', content: 'Zebra spotted [Source 1].' },
  { role: 'user', content: 'and pluto?' },
  { role: 'assistant', content: 'Not found in document. Pluto is a planet.' },
]);
assert.ok(chatText().includes('Searching…'), chatText());
byClass(chat(), 'ai-chat-cancel')[0].click();
assert.ok(chatText().includes('(cancelled)'), chatText());
fake.push({ event: 'delta', data: { text: 'CANCELLED-ANSWER' } });
fake.push({ event: 'done', data: { warnings: [] } });
fake.end();
await new Promise((r) => setTimeout(r, 30));
assert.ok(!chatText().includes('CANCELLED-ANSWER'), 'a cancelled answer must never land');
assert.equal(texts(chat()).filter((t) => t.includes('third question')).length, 1);
assert.equal(byClass(chat(), 'ai-chat-cancel').length, 0, 'no cancel button once idle');

// 8e. per-tab transcripts: switching shows that tab's own session (H10)
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

// 8f. deltas paint into the bubble while the stream is still open
nodes['ai-chat-text'].value = 'stream it';
panel._submit();
await waitFor(() => fake.state.queries.length === 4, 'the fourth query');
fake.push({ event: 'sources', data: { sources: [{ id: 'c1', page: 4, text: 'zebra' }] } });
fake.push({ event: 'delta', data: { text: 'Half ' } });
await waitFor(() => chatText().includes('Half'), 'the first delta');
assert.ok(!chatText().includes('Searching'), 'the status text is replaced by the answer');
fake.push({ event: 'delta', data: { text: 'an answer' } });
fake.push({ event: 'done', data: { warnings: [] } });
fake.end();
await waitFor(() => chatText().includes('Half an answer'), 'the finished answer');
assert.ok(byClass(chat(), 'ai-chat-bubble').at(-1).className.includes('assistant'),
  'the streamed bubble finalizes as an assistant message');
assert.deepEqual(byClass(chat(), 'ai-chat-source-chip').map((c) => c._text), ['p.4']);

console.log('ok: chat panel — progress wording per phase, busy submit ignored, status→system→answer flow, '
  + 'source chips jump, ungrounded badge, cancel + seq guard, per-tab transcripts, close drops session, '
  + 'deltas paint live mid-stream');

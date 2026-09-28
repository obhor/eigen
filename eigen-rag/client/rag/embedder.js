/**
 * embedder.js — the embedding seam. One interface:
 *   embed(texts, { onProgress, signal }) → Promise<Float32Array[]>   (384-dim)
 *
 * Default path is the worker (rag/embed.worker.js). It falls back to running
 * the same model on the main thread when module workers are unavailable —
 * Chromium blocks them on Electron's file:// origin — or when the worker dies.
 * The fallback may stutter the UI; everything else behaves the same.
 */
const MODEL_ID = 'Xenova/all-MiniLM-L6-v2';

function configure(env) {
  env.allowLocalModels = true;
  // Electron loads dist/index.html over file://, where an absolute /models/
  // does not resolve — the model ships next to the page there.
  env.localModelPath = location.protocol === 'file:'
    ? new URL('./models/', document.baseURI).href
    : '/models/';
  env.allowRemoteModels = true;
  env.backends.onnx.wasm.numThreads = 1;
}

function splitTensor(out) {
  const [n, dim] = out.dims;
  const data = out.data;
  const vectors = [];
  for (let i = 0; i < n; i++) vectors.push(data.slice(i * dim, (i + 1) * dim));
  return vectors;
}

// ── main-thread fallback ────────────────────────────────────────────────────
let _extractorPromise = null;
let _mainProgress = null;

async function mainThreadEmbed(texts, onProgress) {
  if (!_extractorPromise) {
    _extractorPromise = import('@huggingface/transformers').then(({ env, pipeline }) => {
      configure(env);
      return pipeline('feature-extraction', MODEL_ID, {
        dtype: 'q8',
        progress_callback: (p) => {
          if (p?.status === 'progress' && String(p.file || '').endsWith('.onnx')) {
            _mainProgress?.({ phase: 'model', loaded: p.loaded, total: p.total });
          }
        },
      });
    });
  }
  const extractor = await _extractorPromise;
  _mainProgress = onProgress;
  return splitTensor(await extractor(texts, { pooling: 'mean', normalize: true }));
}

// ── worker ──────────────────────────────────────────────────────────────────
let _worker = null;
let _workerBroken = false;
let _nextId = 1;
let _progress = null;
const _pending = new Map();   // id → { resolve, reject }

function workerUsable() {
  if (_workerBroken || typeof Worker === 'undefined') return false;
  return !(typeof location !== 'undefined' && location.protocol === 'file:');
}

function getWorker() {
  if (_worker) return _worker;
  const w = new Worker(new URL('./embed.worker.js', import.meta.url), { type: 'module' });
  w.onmessage = (e) => {
    const msg = e.data || {};
    if (msg.type === 'progress') {
      _progress?.({ phase: 'model', loaded: msg.loaded, total: msg.total });
      return;
    }
    const entry = _pending.get(msg.id);
    if (!entry) return;
    _pending.delete(msg.id);
    if (msg.error) entry.reject(new Error(msg.error));
    else entry.resolve(msg.vectors);
  };
  w.onerror = () => {
    _workerBroken = true;
    _worker = null;
    for (const entry of _pending.values()) entry.reject(new Error('The embedding worker failed.'));
    _pending.clear();
  };
  return (_worker = w);
}

export async function embed(texts, { onProgress = null, signal = null } = {}) {
  signal?.throwIfAborted();
  if (!workerUsable()) return mainThreadEmbed(texts, onProgress);

  _progress = onProgress;
  const id = _nextId++;
  const worker = getWorker();
  try {
    return await new Promise((resolve, reject) => {
      _pending.set(id, { resolve, reject });
      worker.postMessage({ id, type: 'embed', texts });
    });
  } catch (err) {
    if (!_workerBroken) throw err;   // a real embed failure (bad model, OOM)
    return mainThreadEmbed(texts, onProgress);
  } finally {
    _pending.delete(id);
    _progress = null;
  }
}

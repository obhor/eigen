/**
 * embed.worker.js — MiniLM (all-MiniLM-L6-v2, q8) in a dedicated worker, so the
 * ~23 MB model download and inference stay off the UI thread.
 *
 * In:  { id, type: 'embed', texts: string[] }
 * Out: { id, vectors: Float32Array[] } | { id, error } | { type: 'progress', loaded, total }
 */
import { env, pipeline } from '@huggingface/transformers';

const MODEL_ID = 'Xenova/all-MiniLM-L6-v2';

env.allowLocalModels = true;           // /models/ ships with the app
env.localModelPath = '/models/';
env.allowRemoteModels = true;          // fallback for origins that can't fetch local files
env.backends.onnx.wasm.numThreads = 1; // single-threaded: no COOP/COEP headers needed

let extractorPromise = null;

function getExtractor() {
  if (!extractorPromise) {
    extractorPromise = pipeline('feature-extraction', MODEL_ID, {
      dtype: 'q8',
      progress_callback: (p) => {
        // only the .onnx file is slow; config/tokenizer are ~1 MB
        if (p?.status === 'progress' && String(p.file || '').endsWith('.onnx')) {
          self.postMessage({ type: 'progress', loaded: p.loaded, total: p.total });
        }
      },
    });
  }
  return extractorPromise;
}

function splitTensor(out) {
  const [n, dim] = out.dims;
  const data = out.data;
  const vectors = [];
  for (let i = 0; i < n; i++) vectors.push(data.slice(i * dim, (i + 1) * dim));
  return vectors;
}

self.onmessage = async (e) => {
  const { id, type, texts } = e.data || {};
  if (type !== 'embed') return;
  try {
    const extractor = await getExtractor();
    const out = await extractor(texts, { pooling: 'mean', normalize: true });
    const vectors = splitTensor(out);
    self.postMessage({ id, vectors }, vectors.map((v) => v.buffer));
  } catch (err) {
    self.postMessage({ id, error: String(err?.message || err) });
  }
};

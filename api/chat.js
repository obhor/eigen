/**
 * api/chat.js — the only server-side piece of the browser RAG: holds the
 * Gemini key and streams the answer straight back. Stateless; the PDF never
 * reaches this endpoint, only the question plus the retrieved excerpts.
 */
const ALLOWED_ORIGINS = new Set([
  'https://eigenpdf.com',
  'https://www.eigenpdf.com',
  'https://editor.eigenpdf.com',
  'http://localhost:5173',
  'http://127.0.0.1:5173',
  'null',                       // Electron fetches from file:// send this
]);

const MAX_BODY_BYTES = 100_000;
const MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
const MAX_TOKENS = Number(process.env.LLM_MAX_TOKENS) || 512;

// ponytail: origin check only — add rate limiting if abused.
const cors = (origin) => ({
  'access-control-allow-origin': origin,
  'access-control-allow-methods': 'POST, OPTIONS',
  'access-control-allow-headers': 'content-type',
  'vary': 'origin',
});

function fail(res, status, origin, message) {
  for (const [k, v] of Object.entries(cors(origin))) res.setHeader(k, v);
  res.setHeader('content-type', 'application/json');
  res.statusCode = status;
  res.end(JSON.stringify({ error: message }));
}

export default async function handler(req, res) {
  const origin = req.headers.origin || '';
  if (!ALLOWED_ORIGINS.has(origin)) return fail(res, 403, origin, 'Forbidden');

  const headers = cors(origin);
  if (req.method === 'OPTIONS') {
    for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
    res.statusCode = 204;
    return res.end();
  }
  if (req.method !== 'POST') return fail(res, 405, origin, 'Method not allowed');

  const key = process.env.GEMINI_API_KEY;
  if (!key) return fail(res, 500, origin, 'Server is missing its API key.');

  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > MAX_BODY_BYTES) return fail(res, 413, origin, 'Request too large.');
  }

  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    return fail(res, 400, origin, 'Body must be JSON.');
  }
  if (!Array.isArray(body?.contents) || body.contents.length === 0) {
    return fail(res, 400, origin, 'Body needs a non-empty contents array.');
  }

  // Cancel the upstream generation when the browser cancels the answer.
  // (req's own 'close' fires when the request body ends, not on disconnect.)
  const abort = new AbortController();
  res.on('close', () => { if (!res.writableEnded) abort.abort(); });

  const upstream = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:streamGenerateContent?alt=sse`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify({
        systemInstruction: body.systemInstruction,
        contents: body.contents,
        generationConfig: { temperature: 0.2, maxOutputTokens: MAX_TOKENS },
      }),
      signal: abort.signal,
    },
  );

  if (!upstream.ok) {
    const text = await upstream.text().catch(() => '');
    for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
    res.setHeader('content-type', 'application/json');
    res.statusCode = upstream.status;
    return res.end(text || JSON.stringify({ error: 'Upstream error.' }));
  }

  for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
  res.setHeader('content-type', 'text/event-stream');
  res.setHeader('cache-control', 'no-cache, no-transform');
  res.statusCode = 200;
  res.flushHeaders();

  try {
    for await (const chunk of upstream.body) res.write(chunk);
  } catch {
    // client went away mid-stream; nothing left to do
  }
  res.end();
}

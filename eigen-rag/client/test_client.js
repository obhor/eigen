/**
 * test_client.js — standalone CLI test client for the eigen-rag server.
 * Run independently with Node.js to verify the RAG pipeline works
 * before connecting it to any frontend.
 *
 * Usage:
 *   node test_client.js status
 *   node test_client.js ingest path/to/file.pdf
 *   node test_client.js query <doc_id> "your question here"
 */

import fs from 'fs';
import path from 'path';

const BASE = process.env.RAG_BASE ?? 'http://localhost:8000';
const AUTH_HEADERS = process.env.RAG_TOKEN ? { Authorization: `Bearer ${process.env.RAG_TOKEN}` } : {};

async function status() {
  const res = await fetch(`${BASE}/status`);
  const data = await res.json();
  console.log('Server status:', data);
}

async function ingest(filePath) {
  const abs = path.resolve(filePath);
  const bytes = fs.readFileSync(abs);
  const filename = path.basename(abs);

  const form = new FormData();
  form.append('file', new Blob([bytes], { type: 'application/pdf' }), filename);

  console.log(`Ingesting: ${filename} (${bytes.length} bytes)...`);
  const res = await fetch(`${BASE}/ingest`, { method: 'POST', headers: AUTH_HEADERS, body: form });
  const data = await res.json();

  if (!res.ok) {
    console.error('Ingest failed:', data);
    process.exit(1);
  }

  console.log(`✓ Ingested — doc_id: ${data.doc_id}  chunks: ${data.chunk_count}`);
  console.log(`  → Run a query with:`);
  console.log(`    node test_client.js query ${data.doc_id} "your question"`);
}

async function query(docId, question, k = 5) {
  console.log(`Querying doc ${docId}: "${question}"`);
  const res = await fetch(`${BASE}/query`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...AUTH_HEADERS },
    body: JSON.stringify({ doc_id: docId, q: question, k }),
  });
  const data = await res.json();

  if (!res.ok) {
    console.error('Query failed:', data);
    process.exit(1);
  }

  console.log('\n─── Answer ──────────────────────────────────');
  console.log(data.answer);
  console.log('\n─── Sources ─────────────────────────────────');
  data.sources.forEach((s, i) => {
    console.log(`[${i + 1}] Page ${s.page}  score=${s.score?.toFixed(3)}`);
    console.log(`    ${s.text.slice(0, 120).replace(/\n/g, ' ')}…`);
  });
}

// ─── CLI dispatch ─────────────────────────────────────────────────────────────
const [,, cmd, ...args] = process.argv;

switch (cmd) {
  case 'status':
    await status();
    break;
  case 'ingest':
    if (!args[0]) { console.error('Usage: node test_client.js ingest <file.pdf>'); process.exit(1); }
    await ingest(args[0]);
    break;
  case 'query':
    if (!args[0] || !args[1]) { console.error('Usage: node test_client.js query <doc_id> "question"'); process.exit(1); }
    await query(args[0], args[1], Number(args[2] ?? 5));
    break;
  default:
    console.log('Commands: status | ingest <file.pdf> | query <doc_id> "question"');
}

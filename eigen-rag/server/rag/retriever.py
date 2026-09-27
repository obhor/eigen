"""
Hybrid retriever — fuses two signals per query:
  1. Dense vector search  (hnswlib cosine similarity)
  2. Sparse BM25 keyword search (rank-bm25)

Fusion: Reciprocal Rank Fusion (RRF)
  score(chunk) = 1/(k + rank_vector) + 1/(k + rank_bm25)

One store per doc_id, kept in memory — least-recently-used beyond
RAG_MAX_STORES documents (evicted doc_ids 404, the client re-indexes).
"""
import logging
import os
import threading
from collections import OrderedDict
from typing import List, Dict, Optional

import hnswlib
import numpy as np

log = logging.getLogger("eigen-rag")

try:
    from rank_bm25 import BM25Okapi
    _BM25_AVAILABLE = True
except ImportError:
    BM25Okapi = None
    _BM25_AVAILABLE = False
    log.warning("rank-bm25 not installed — retrieval is dense-only (no sparse signal)")

# { doc_id: { "index", "chunks", "bm25", "corpus", "embeddings" } }, in LRU order
_stores: "OrderedDict[str, Dict]" = OrderedDict()
_stores_lock = threading.Lock()
MAX_STORES = max(1, int(os.getenv("RAG_MAX_STORES", "8")))

DIM              = 384     # all-MiniLM-L6-v2
EF_CONSTRUCTION  = 200
M                = 16
RRF_K            = 60      # RRF constant — higher = smoother rank fusion
MMR_LAMBDA       = 0.7     # Relevance / diversity tradeoff for MMR (0..1)
# MIN_RRF_SCORE was deleted here (audit H19). The old 0.02 sat between
# 1/RRF_K = 0.0167 (a chunk only one retriever ranked) and 2/RRF_K = 0.0333
# (a chunk both ranked), so it silently dropped every single-signal hit and
# leaned on a fallback to avoid returning nothing. Measured by
# check_retrieval_quality.py (12-page fixture, 25 chunks): recall@5 1.000 at
# both 0.02 and 0.0, MRR 0.903 vs 0.903 — a pure no-op that could only lose
# results. MMR_LAMBDA was swept too: λ=1.0 also gave recall@5 1.000 but
# MRR 0.917 vs 0.903 (diversity costs a rank on near-duplicate facts), so 0.7
# stays until a harder set justifies the change.


def _tokenize(text: str) -> List[str]:
    """Simple lowercase whitespace tokenizer for BM25."""
    return text.lower().split()


def _cosine_similarity_matrix(a: np.ndarray, b: np.ndarray) -> np.ndarray:
    """Compute cosine similarity between rows of a and rows of b.
    Both a and b are 2D arrays. Returns matrix shape (a_rows, b_rows).
    """
    a_norm = a / (np.linalg.norm(a, axis=1, keepdims=True) + 1e-12)
    b_norm = b / (np.linalg.norm(b, axis=1, keepdims=True) + 1e-12)
    return np.dot(a_norm, b_norm.T)


def build_index(doc_id: str, chunks: List[Dict], embeddings: np.ndarray) -> None:
    # ── Dense index ──────────────────────────────────────────────────────────
    index = hnswlib.Index(space="cosine", dim=DIM)
    index.init_index(max_elements=len(chunks), ef_construction=EF_CONSTRUCTION, M=M)
    index.add_items(embeddings, list(range(len(chunks))))
    index.set_ef(50)

    # ── Sparse BM25 index ────────────────────────────────────────────────────
    corpus = [_tokenize(c["text"]) for c in chunks]
    bm25   = BM25Okapi(corpus) if _BM25_AVAILABLE and BM25Okapi is not None else None

    store = {
        "index":     index,
        "chunks":    chunks,
        "bm25":      bm25,
        "corpus":    corpus,
        # Keep raw embeddings so we can compute MMR/diversity when reranking
        "embeddings": np.asarray(embeddings, dtype=np.float32),
    }

    with _stores_lock:
        _stores[doc_id] = store
        _stores.move_to_end(doc_id)
        while len(_stores) > MAX_STORES:
            evicted, _ = _stores.popitem(last=False)
            log.warning("store evicted (RAG_MAX_STORES=%d): doc_id=%s", MAX_STORES, evicted)


def _mmr_rerank(query_vec: np.ndarray, candidate_idxs: List[int], store: Dict, k: int,
                lambda_param: Optional[float] = None) -> List[int]:
    """Apply Maximum Marginal Relevance (MMR) to select k items from candidates.
    Returns the candidate indices in selected order.
    """
    if lambda_param is None:
        lambda_param = MMR_LAMBDA   # read at call time — check_retrieval_quality sweeps it
    if store.get("embeddings") is None or len(candidate_idxs) == 0:
        return candidate_idxs[:k]

    cand_embs = store["embeddings"][candidate_idxs]
    qvec = query_vec.reshape(1, -1)
    sims_q = _cosine_similarity_matrix(cand_embs, qvec).flatten()  # (n_cands,)
    sims_cc = _cosine_similarity_matrix(cand_embs, cand_embs)

    selected: List[int] = []
    remaining = list(range(len(candidate_idxs)))

    # Pre-select the highest relevance item
    first = int(np.argmax(sims_q))
    selected.append(remaining.pop(first))

    while len(selected) < min(k, len(candidate_idxs)) and remaining:
        scores = []
        for r in remaining:
            rel = sims_q[r]
            max_sim_to_selected = max(sims_cc[r, s] for s in selected) if selected else 0.0
            mmr_score = lambda_param * rel - (1 - lambda_param) * max_sim_to_selected
            scores.append(mmr_score)
        pick_idx = int(np.argmax(scores))
        selected.append(remaining.pop(pick_idx))

    # Map back to original candidate_idxs
    return [candidate_idxs[i] for i in selected]


def query_index(doc_id: str, query_vec: np.ndarray,
                query_text: str, k: int) -> List[Dict]:
    # Lock is held for the dict ops only — the hnsw/BM25 work below runs on the
    # local `store` reference, so an eviction mid-query cannot pull it away.
    with _stores_lock:
        store = _stores.get(doc_id)
        if store is None:
            raise KeyError(f"No index for doc_id: {doc_id}")
        _stores.move_to_end(doc_id)

    chunks = store["chunks"]
    n      = len(chunks)
    top_k  = min(k * 3, n)    # fetch more, re-rank, return top-k

    # ── 1. Dense retrieval ────────────────────────────────────────────────────
    labels, distances = store["index"].knn_query(query_vec, k=top_k)
    dense_ranks: Dict[int, int] = {
        int(label): rank for rank, label in enumerate(labels[0])
    }

    # ── 2. BM25 sparse retrieval ──────────────────────────────────────────────
    sparse_ranks: Dict[int, int] = {}
    bm25_scores: Optional[np.ndarray] = None
    if store["bm25"] is not None:
        tokens  = _tokenize(query_text)
        scores  = store["bm25"].get_scores(tokens)
        bm25_scores = np.array(scores)
        # Rank by descending score, take top_k
        ordered = sorted(range(n), key=lambda i: scores[i], reverse=True)[:top_k]
        sparse_ranks = {idx: rank for rank, idx in enumerate(ordered)}

    # ── 3. Reciprocal Rank Fusion ─────────────────────────────────────────────
    all_ids = set(dense_ranks) | set(sparse_ranks)
    rrf_scores: Dict[int, float] = {}
    for idx in all_ids:
        s = 0.0
        if idx in dense_ranks:
            s += 1.0 / (RRF_K + dense_ranks[idx])
        if idx in sparse_ranks:
            s += 1.0 / (RRF_K + sparse_ranks[idx])
        rrf_scores[idx] = s

    # Fused score, best first — no threshold (see MIN_RRF_SCORE's note above)
    candidates = sorted(rrf_scores, key=lambda i: rrf_scores[i], reverse=True)[:top_k]

    # Apply MMR reranking to select final k ids (diverse + relevant)
    final_ids = _mmr_rerank(query_vec.reshape(-1), candidates, store, k)

    results = []
    for idx in final_ids:
        chunk = chunks[idx].copy()
        chunk["score"] = round(rrf_scores.get(idx, 0.0), 4)
        # attach bm25 raw score if available
        if bm25_scores is not None:
            chunk["bm25_score"] = float(bm25_scores[idx])
        results.append(chunk)

    return results

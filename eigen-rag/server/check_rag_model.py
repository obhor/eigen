"""
Manual check for the RAG model pieces (audit item 9): the chunker
(clean_text + chunk_pages) and RRF fusion (build_index + query_index).
Run from eigen-rag/server:  python check_rag_model.py
"""
import numpy as np

from pdf.indexer import TARGET_CHARS, OVERLAP_SENTS, chunk_pages, clean_text
import rag.retriever as retriever
from rag.retriever import DIM, RRF_K, _stores, build_index, query_index

# ── 1. clean_text: OCR heuristics + normalization ───────────────────────────
assert clean_text("") == ""
assert clean_text("a1b co0peration te5t") == "alb cooperation test"
assert clean_text("1-krod") == "l-krod"
assert clean_text("l|ike") == "llike"
assert clean_text("a’b “c” d–e f—g") == "a'b \"c\" d-e f - g"
assert clean_text("café") == "caf"
assert clean_text("• one\n two   three") == "one two three"

# ── 2. chunk_pages: metadata, size flush, overlap, page isolation ───────────
assert chunk_pages([{"page": 1, "text": "", "source_type": "digital"}]) == []

sents = [f"S{i:02d} " + "x" * 90 + "." for i in range(20)]
chunks = chunk_pages([{"page": 1, "text": " ".join(sents), "source_type": "digital"}])
assert len(chunks) > 2, f"expected several chunks, got {len(chunks)}"
assert len({c["id"] for c in chunks}) == len(chunks), "chunk ids must be unique"
for c in chunks[:-1]:
    assert len(c["text"]) >= TARGET_CHARS, f"non-final chunk below target: {len(c['text'])}"
assert len(chunks[-1]["text"]) < TARGET_CHARS
assert all(c["page"] == 1 and c["source_type"] == "digital" for c in chunks)

# overlap: each chunk re-opens with the previous chunk's last OVERLAP_SENTS sentences
for prev, nxt in zip(chunks, chunks[1:]):
    carried = " ".join(prev["text"].split(" ")[-2 * OVERLAP_SENTS:])  # 2 tokens per fixture sentence
    assert nxt["text"].startswith(carried), f"overlap missing: {nxt['text'][:40]}"
assert chunks[0]["text"].startswith("S00") and chunks[1]["text"].startswith("S04")

# pages never share an overlap buffer
multi = chunk_pages([
    {"page": 1, "text": " ".join(f"P1S{i} " + "y" * 200 + "." for i in range(4)), "source_type": "digital"},
    {"page": 2, "text": "P2 first. P2 second.", "source_type": "ocr"},
])
page2 = [c for c in multi if c["page"] == 2]
assert len(page2) == 1 and page2[0]["text"].startswith("P2 first.")
assert page2[0]["source_type"] == "ocr"
assert all(c["page"] == 1 for c in multi[:-1])

# heading metadata: page_data heading passes through untouched
h = chunk_pages([{"page": 1, "text": "Intro text. More text here.", "heading": "Intro", "source_type": "digital"}])
assert len(h) == 1 and h[0]["heading"] == "Intro"

# parser-style "H2: " block: only breaks a chunk when the heading ends a
# sentence (parser.py joins blocks with "\n", but clean_text flattens newlines
# before _split_sentences sees them — so "H2: Title\nBody." merges into one
# sentence and the heading absorbs the body text. Pinned here as-is; the
# one-line fix is to split before cleaning, but that changes retrieval and the
# audit defers it to the Block 4 golden set.)
h2 = chunk_pages([{"page": 1, "text": "H2: Beta.\nBody sentence one. Body sentence two.", "source_type": "digital"}])
assert h2[0]["heading"] == "Beta." and h2[0]["text"].startswith("Beta. Body sentence one.")

# ── 3. RRF fusion through the real indexes ──────────────────────────────────
def unit(*components):
    v = np.zeros(DIM, dtype=np.float32)
    v[:len(components)] = components
    return v / np.linalg.norm(v)

EMB = np.stack([
    unit(1, 0),      # 0 closest to the query embedding
    unit(0.9, 0.4359),
    unit(0.5, 0.866),
    unit(-1, 0),
    unit(0, 1),
    unit(0, 1),      # 5 outside the dense top-3
    unit(-1, 0),     # 6 outside the dense top-3
    unit(0, -1),     # 7 outside the dense top-3
])
QUERY = EMB[0].copy()


def mkchunks(texts):
    return [{"id": f"c{i}", "page": 1, "text": t, "heading": None, "source_type": "digital"}
            for i, t in enumerate(texts)]


# 3a. an item ranked by both signals fuses to the max score and wins
both = mkchunks([
    "alpha alpha alpha", "alpha alpha", "alpha",
    "zebra zebra zebra zebra", "moose moose moose moose",
    "zebra moose moose moose", "moose zebra moose moose", "moose moose zebra moose",
])
build_index("check-both", both, EMB)
res = query_index("check-both", QUERY, "alpha", 3)
assert [r["id"] for r in res][0] == "c0", [r["id"] for r in res]
assert {r["id"] for r in res} == {"c0", "c1", "c2"}
assert res[0]["score"] == round(2 / RRF_K, 4) == 0.0333, res[0]["score"]
assert res[0]["score"] > res[-1]["score"] > 0, [r["score"] for r in res]
assert res[0]["bm25_score"] > res[1]["bm25_score"] > res[2]["bm25_score"]
assert res[0]["text"] == both[0]["text"] and res[0]["page"] == 1

# 3b. dense and sparse top-3 disjoint → every candidate is single-signal and
# scores 1/(RRF_K+rank). Block 4 (H19) deleted the old MIN_RRF_SCORE=0.02
# filter, which dropped exactly these (0.0167 < 0.02) and leaned on a fallback
# to avoid returning nothing; check_retrieval_quality.py measured recall@5
# 1.000 with and without it, so it could only ever lose results. Pinned gone.
assert 1 / RRF_K < 0.02 < 2 / RRF_K      # the arithmetic that made 0.02 a trap
assert not hasattr(retriever, "MIN_RRF_SCORE")
disjoint = mkchunks([
    "moose zebra moose zebra", "moose zebra zebra moose", "zebra moose moose zebra",
    "zebra moose zebra moose", "moose moose zebra zebra",
    "alpha alpha alpha zebra", "alpha alpha zebra zebra", "alpha zebra zebra zebra",
])
build_index("check-disjoint", disjoint, EMB)
res2 = query_index("check-disjoint", QUERY, "alpha", 1)
assert len(res2) == 1
assert res2[0]["score"] == round(1 / RRF_K, 4) == 0.0167, res2[0]["score"]
assert res2[0]["id"] == "c0", res2[0]["id"]  # best single-signal hit, returned directly

try:
    query_index("check-missing", QUERY, "alpha", 1)
    raise AssertionError("query_index must raise for an unknown doc_id")
except KeyError:
    pass

_stores.pop("check-both", None)
_stores.pop("check-disjoint", None)

print("ok: clean_text heuristics, chunker size/metadata/overlap/pages, RRF fusion "
      "(single-signal hits kept — the H19 threshold is gone for good)")

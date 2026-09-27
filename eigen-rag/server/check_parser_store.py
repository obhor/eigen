"""
Manual check for the parser + store hardening (audit H20, C4/RAG-01):
password-protected PDFs raise EncryptedPdfError (422 at the route, never the
413 the ValueError branch gives), a page that fails to extract is skipped
without sinking the document, OCR is budgeted/timeboxed/disable-able, and
_stores is an LRU capped by RAG_MAX_STORES.
Run from eigen-rag/server:  python check_parser_store.py
"""
import io
import os
import sys
import types

os.environ["RAG_MAX_STORES"] = "2"

import fitz
import numpy as np
from fastapi import HTTPException

import api.routes.pdf as pdf_route
import pdf.parser as parser_mod
from pdf.parser import EncryptedPdfError, extract_pages
from rag.retriever import DIM, _stores, build_index, query_index


def _pdf_with_text(text="top secret"):
    doc = fitz.open()
    doc.new_page().insert_text((72, 72), text)
    return doc


# ── 1. encryption: needs_pass → EncryptedPdfError, owner-only opens ──────────
enc = _pdf_with_text().tobytes(
    encryption=fitz.PDF_ENCRYPT_AES_256, owner_pw="owner-pw", user_pw="user-pw")
try:
    extract_pages(enc)
    raise AssertionError("password-protected PDF must raise EncryptedPdfError")
except EncryptedPdfError as e:
    assert "password" in str(e), e

owner_only = _pdf_with_text().tobytes(
    encryption=fitz.PDF_ENCRYPT_AES_256, owner_pw="owner-pw", user_pw="")
pages = extract_pages(owner_only)
assert pages and "top secret" in pages[0]["text"], pages  # "" opened it


class _Upload:  # the three attributes the route touches
    content_type = "application/pdf"

    def __init__(self, data):
        self.file = io.BytesIO(data)
        self.size = len(data)


try:
    pdf_route.ingest(_Upload(enc))
    raise AssertionError("encrypted upload must be rejected")
except HTTPException as e:
    assert e.status_code == 422, e.status_code   # not 413
    assert "password" in e.detail, e.detail

# ── 2. one bad page is skipped, the rest survives ────────────────────────────
doc = fitz.open()
doc.new_page().insert_text((72, 72), "alpha page one")
doc.new_page().insert_text((72, 72), "beta page two")
two_pages = doc.tobytes()

real_blocks = parser_mod._extract_page_blocks


def flaky(page):
    if page.number == 0:
        raise RuntimeError("boom")
    return real_blocks(page)


parser_mod._extract_page_blocks = flaky
try:
    pages = extract_pages(two_pages)
finally:
    parser_mod._extract_page_blocks = real_blocks
assert [p["page"] for p in pages] == [2], pages
assert "beta page two" in pages[0]["text"], pages

# ── 3. OCR: per-ingest budget, timeout kwarg, 0 = opt-out ────────────────────
doc = fitz.open()
for _ in range(4):
    doc.new_page(width=200, height=200)   # blank pages → "no text layer"
blank = doc.tobytes()

calls = []
fake_pytesseract = types.ModuleType("pytesseract")


def _image_to_string(img, lang=None, timeout=None):
    calls.append(timeout)
    return "OCR-TEXT"


fake_pytesseract.image_to_string = _image_to_string
sys.modules["pytesseract"] = fake_pytesseract

parser_mod.OCR_MAX_PAGES = 2
pages = extract_pages(blank)
assert [p["page"] for p in pages] == [1, 2], pages
assert calls == [parser_mod.OCR_TIMEOUT_S, parser_mod.OCR_TIMEOUT_S], calls
assert all(p["source_type"] == "ocr" for p in pages)

calls.clear()
parser_mod.OCR_MAX_PAGES = 0
assert extract_pages(blank) == []
assert calls == [], "RAG_OCR_MAX_PAGES=0 must not call Tesseract"
del sys.modules["pytesseract"]

# ── 4. _stores: LRU cap + touch on query ─────────────────────────────────────
emb = np.zeros((2, DIM), dtype=np.float32)
emb[0, 0] = 1.0
emb[1, 1] = 1.0
chunks = [
    {"id": "a", "page": 1, "text": "alpha alpha", "heading": None, "source_type": "digital"},
    {"id": "b", "page": 2, "text": "beta beta", "heading": None, "source_type": "digital"},
]

for name in ("s1", "s2", "s3"):
    build_index(name, chunks, emb)
assert list(_stores) == ["s2", "s3"], list(_stores)   # cap 2 evicted the first

try:
    query_index("s1", emb[0], "alpha", 1)
    raise AssertionError("an evicted doc_id must raise KeyError (→ 404)")
except KeyError:
    pass

assert query_index("s2", emb[0], "alpha", 1)[0]["id"] == "a"
build_index("s4", chunks, emb)                        # touch made s3 the oldest
assert list(_stores) == ["s2", "s4"], list(_stores)

print("ok: encrypted PDF -> EncryptedPdfError/422 (owner-only opens with ''), "
      "per-page failure skipped, OCR budget + timeout kwarg + opt-out, "
      "_stores LRU cap + touch-on-query")

"""
PDF parser — 2-tier extraction strategy:
  Tier 1: PyMuPDF blocks  — layout-aware, heading detection, reading order
  Tier 2: Tesseract OCR   — fallback only when a page has zero text (scanned)

Speed: uses get_text("blocks") — 30x faster than get_text("dict"),
still provides bounding boxes for reading order + heading heuristics.
Two-pass on single doc handle — no re-opening per page.
"""
import fitz
import io
import logging
import os
from typing import List, Dict

log = logging.getLogger("eigen-rag")

# OCR is a last resort: cap how many pages per ingest may hit Tesseract and
# kill any single page that runs long. RAG_OCR_MAX_PAGES=0 disables OCR.
OCR_MAX_PAGES = int(os.getenv("RAG_OCR_MAX_PAGES", "50"))
OCR_TIMEOUT_S = float(os.getenv("RAG_OCR_TIMEOUT_S", "30"))


class EncryptedPdfError(Exception):
    """PDF needs a password the server cannot supply."""


# ── Tesseract fallback ────────────────────────────────────────────────────────
def _ocr_page(page: fitz.Page) -> str:
    try:
        import pytesseract
        from PIL import Image
        mat = fitz.Matrix(250 / 72, 250 / 72)
        pix = page.get_pixmap(matrix=mat, colorspace=fitz.csRGB)
        img = Image.open(io.BytesIO(pix.tobytes("png")))
        # timeout kills the tesseract subprocess if the page is pathological
        return pytesseract.image_to_string(img, lang="eng", timeout=OCR_TIMEOUT_S).strip()
    except ImportError:
        log.warning("pytesseract not installed — scanned page will be skipped")
        return ""
    except Exception as e:
        log.warning("OCR failed: %s: %s", type(e).__name__, e)
        return ""


# ── PyMuPDF blocks extraction (fast path) ────────────────────────────────────
def _extract_page_blocks(page: fitz.Page) -> Dict:
    """
    Uses get_text("blocks") — 30x faster than get_text("dict").
    Returns (x0, y0, x1, y1, text, block_no, block_type) tuples.
    block_type: 0 = text, 1 = image

    Heading heuristic (no font size available in blocks mode):
      - Short block (< 80 chars) near the top third of the page → H1
      - Short block in upper half → H2
    """
    page_height = page.rect.height
    blocks      = page.get_text("blocks")   # list of tuples
    heading     = None
    lines_out   = []

    # Sort by vertical then horizontal position
    text_blocks = [b for b in blocks if b[6] == 0 and b[4].strip()]
    text_blocks.sort(key=lambda b: (round(b[1] / 10), b[0]))

    for b in text_blocks:
        x0, y0, x1, y1, text, block_no, block_type = b
        text = text.strip()
        if not text:
            continue

        rel_y    = y0 / page_height          # 0.0 = top, 1.0 = bottom
        is_short = len(text) < 80
        is_single_line = text.count("\n") == 0

        if is_short and is_single_line and rel_y < 0.30:
            prefix = "H1: "
            if heading is None:
                heading = text
        elif is_short and is_single_line and rel_y < 0.55:
            prefix = "H2: "
        else:
            prefix = ""

        # Normalise internal newlines to spaces (blocks join lines)
        clean = text.replace("\n", " ").strip()
        lines_out.append(f"{prefix}{clean}")

    return {
        "text":        "\n".join(lines_out),
        "heading":     heading,
        "source_type": "digital",
    }


# ── Public API ────────────────────────────────────────────────────────────────
def extract_pages(pdf_bytes: bytes, max_pages: int | None = None) -> List[Dict]:
    """
    Returns list of:
      { page: int, text: str, heading: str|None, source_type: 'digital'|'ocr' }

    Two-pass on single doc handle:
      Pass 1 — cheap get_text("text") to detect empty/scanned pages
      Pass 2 — get_text("blocks") only on pages that have text

    Raises ValueError when the document exceeds max_pages, so OCR/embedding
    work is never started on oversized input; EncryptedPdfError when the PDF
    needs a password the server does not have. A page that fails to extract
    is logged and skipped rather than sinking the whole document.
    """
    doc = fitz.open(stream=pdf_bytes, filetype="pdf")
    try:
        # Owner-password-only PDFs (the common "restricted" case) open with ""
        if doc.needs_pass and not doc.authenticate(""):
            raise EncryptedPdfError("PDF is password-protected")

        if max_pages is not None and doc.page_count > max_pages:
            raise ValueError(f"PDF has {doc.page_count} pages; the limit is {max_pages}")

        pages_out = []
        ocr_left = OCR_MAX_PAGES  # per-ingest Tesseract budget; 0 = disabled

        for i, page in enumerate(doc):
            page_num = i + 1
            try:
                # Pass 1: cheap empty-page detection
                raw = page.get_text("text").strip()

                if raw:
                    # Pass 2: fast structured extraction
                    result = _extract_page_blocks(page)
                elif OCR_MAX_PAGES == 0:
                    log.info("Page %d: no text layer — OCR disabled (RAG_OCR_MAX_PAGES=0)", page_num)
                    result = {"text": "", "heading": None, "source_type": "ocr"}
                elif ocr_left <= 0:
                    log.warning("Page %d: no text layer — OCR budget (%d pages) used up",
                                page_num, OCR_MAX_PAGES)
                    result = {"text": "", "heading": None, "source_type": "ocr"}
                else:
                    log.info("Page %d: no text layer — falling back to Tesseract OCR", page_num)
                    ocr_left -= 1
                    result = {"text": _ocr_page(page), "heading": None, "source_type": "ocr"}
            except Exception as e:
                log.warning("Page %d: extraction failed: %s: %s", page_num, type(e).__name__, e)
                continue

            if result["text"].strip():
                pages_out.append({"page": page_num, **result})
            else:
                log.warning("Page %d: no text extracted (skipped)", page_num)

        return pages_out
    finally:
        doc.close()

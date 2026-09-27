"""
POST /ingest  — receives PDF, extracts, chunks, embeds, stores index.
"""
import logging
import os
import uuid
from fastapi import APIRouter, Depends, UploadFile, File, HTTPException
from api.middleware.auth import require_token
from models.schemas import IngestResponse
from pdf.parser import EncryptedPdfError, extract_pages
from pdf.indexer import chunk_pages
from rag.embeddings import embed
from rag import retriever

log = logging.getLogger("eigen-rag")

MAX_UPLOAD_BYTES = int(os.getenv("RAG_MAX_UPLOAD_MB", "50")) * 1024 * 1024
MAX_PAGES = int(os.getenv("RAG_MAX_PAGES", "500"))

router = APIRouter(dependencies=[Depends(require_token)])


@router.post("/ingest", response_model=IngestResponse)
def ingest(file: UploadFile = File(...)):  # sync: Starlette runs it in a threadpool
    if file.content_type not in ("application/pdf", "application/octet-stream"):
        raise HTTPException(status_code=400, detail="Only PDF files are accepted")

    limit_mb = MAX_UPLOAD_BYTES // (1024 * 1024)
    if file.size is not None and file.size > MAX_UPLOAD_BYTES:
        raise HTTPException(status_code=413, detail=f"PDF exceeds the {limit_mb} MB upload limit")

    # Bounded read — never buffer past the cap even if size was unknown
    pdf_bytes = file.file.read(MAX_UPLOAD_BYTES + 1)
    if len(pdf_bytes) > MAX_UPLOAD_BYTES:
        raise HTTPException(status_code=413, detail=f"PDF exceeds the {limit_mb} MB upload limit")

    try:
        pages = extract_pages(pdf_bytes, max_pages=MAX_PAGES)
    except EncryptedPdfError as e:
        # 422, not the 413 the ValueError branch would give it
        raise HTTPException(status_code=422, detail=str(e))
    except ValueError as e:
        raise HTTPException(status_code=413, detail=str(e))
    except Exception as e:
        log.warning("PDF parse failed: %s", e)
        raise HTTPException(status_code=422, detail="Could not parse PDF")

    if not pages:
        raise HTTPException(status_code=422, detail="No extractable text found in PDF")

    ocr_pages = sum(1 for p in pages if p.get("source_type") == "ocr")

    chunks = chunk_pages(pages)
    texts  = [c["text"] for c in chunks]
    embeddings = embed(texts)

    doc_id = str(uuid.uuid4())
    retriever.build_index(doc_id, chunks, embeddings)

    return IngestResponse(
        doc_id=doc_id,
        chunk_count=len(chunks),
        page_count=len(pages),
        ocr_pages=ocr_pages,
        message=f"Ingested {len(pages)} pages ({ocr_pages} via OCR), {len(chunks)} chunks",
    )

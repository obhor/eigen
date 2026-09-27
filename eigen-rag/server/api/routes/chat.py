"""
POST /query         — hybrid retrieval (BM25 + vector) → generator → response.
POST /query/stream  — the same answer as Server-Sent Events:

    event: sources   data: {"sources": [...], "mock": false}
    event: delta     data: {"text": "..."}          (many)
    event: done      data: {"warnings": [...]}
    event: error     data: {"message": "..."}

Retrieval runs before the generator, so 401/404/422 are ordinary JSON errors;
only provider failures mid-answer arrive as an `error` event.
"""
import json

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import StreamingResponse
from api.middleware.auth import require_token
from models.schemas import QueryRequest, QueryResponse
from rag.embeddings import embed
from rag import retriever
from rag.generator import (
    LLMProviderError, LLMTimeoutError, ai_enabled, generate_answer, stream_answer,
    verify_citations,
)

router = APIRouter(dependencies=[Depends(require_token)])


def _retrieve(req: QueryRequest):
    try:
        query_vec = embed([req.q])
        return retriever.query_index(
            doc_id=req.doc_id,
            query_vec=query_vec,
            query_text=req.q,       # passed to BM25
            k=req.k,
        )
    except KeyError as e:
        raise HTTPException(status_code=404, detail=str(e))


@router.post("/query", response_model=QueryResponse)
def query(req: QueryRequest):  # sync: embedding + generation block, run in threadpool
    chunks = _retrieve(req)

    try:
        answer = generate_answer(req.q, chunks, [t.model_dump() for t in req.history])
    except LLMTimeoutError:
        raise HTTPException(status_code=504, detail="AI provider timed out")
    except LLMProviderError:
        raise HTTPException(status_code=502, detail="AI provider unavailable")

    mock = not ai_enabled()
    return QueryResponse(
        answer=answer,
        sources=chunks,
        mock=mock,
        warnings=[] if mock else verify_citations(answer, chunks),
    )


def _sse(event: str, data: dict) -> str:
    return f"event: {event}\ndata: {json.dumps(data)}\n\n"


@router.post("/query/stream")
def query_stream(req: QueryRequest):  # sync generator: Starlette iterates it in the threadpool
    chunks = _retrieve(req)
    mock = not ai_enabled()

    def events():
        yield _sse("sources", {"sources": chunks, "mock": mock})
        parts = []
        try:
            for delta in stream_answer(req.q, chunks, [t.model_dump() for t in req.history]):
                parts.append(delta)
                yield _sse("delta", {"text": delta})
        except LLMTimeoutError:
            yield _sse("error", {"message": "AI provider timed out"})
            return
        except LLMProviderError:
            yield _sse("error", {"message": "AI provider unavailable"})
            return
        yield _sse("done", {"warnings": [] if mock else verify_citations("".join(parts), chunks)})

    return StreamingResponse(events(), media_type="text/event-stream")

from pydantic import BaseModel, Field
from typing import List, Literal, Optional


class IngestRequest(BaseModel):
    filename: str


class Chunk(BaseModel):
    id:          str
    text:        str
    page:        int
    score:       Optional[float] = None
    heading:     Optional[str]   = None
    source_type: Optional[str]   = "digital"   # "digital" | "ocr"


class IngestResponse(BaseModel):
    doc_id:      str
    chunk_count: int
    page_count:  int
    ocr_pages:   int
    message:     str


class Turn(BaseModel):
    role:    Literal["user", "assistant"]   # never "system" — rules stay server-side
    content: str


class QueryRequest(BaseModel):
    doc_id: str
    q:      str
    k:      int = Field(default=5, ge=1, le=20)
    history: List[Turn] = Field(default_factory=list)  # capped in generator._messages


class QueryResponse(BaseModel):
    answer:   str
    sources:  List[Chunk]
    mock:     bool = False   # True when AI_ENABLED=false
    warnings: List[str] = Field(default_factory=list)  # citation-check notes

"""
Bearer-token gate for the RAG API.

Disabled when RAG_TOKEN is unset, in which case the service trusts its bind
address (see `python main.py`, which binds 127.0.0.1). Set RAG_TOKEN in .env
whenever the server is reachable by anything other than this machine.
"""
import os
import secrets
from fastapi import Header, HTTPException

RAG_TOKEN = os.getenv("RAG_TOKEN", "").strip()


def require_token(authorization: str | None = Header(default=None)) -> None:
    if not RAG_TOKEN:
        return
    if not authorization or not secrets.compare_digest(authorization, f"Bearer {RAG_TOKEN}"):
        raise HTTPException(status_code=401, detail="Missing or invalid RAG token")

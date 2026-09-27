import os
from dotenv import load_dotenv
load_dotenv()  # reads .env before anything else imports os.getenv()

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from api.routes import pdf, chat
from api.middleware.logging import LoggingMiddleware

HOST = os.getenv("HOST", "127.0.0.1").strip()
PORT = int(os.getenv("PORT", "8000"))

# Vite dev server + Electron renderer (file:// sends Origin: null)
ALLOWED_ORIGINS = [
    o.strip()
    for o in os.getenv(
        "RAG_ALLOWED_ORIGINS",
        "http://localhost:5173,http://127.0.0.1:5173,null",
    ).split(",")
    if o.strip()
]

app = FastAPI(title="eigen-rag", version="0.1.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_methods=["*"],
    allow_headers=["*"],
)
app.add_middleware(LoggingMiddleware)

app.include_router(pdf.router)
app.include_router(chat.router)


@app.get("/status")
def status():
    return {"ready": True, "version": "0.1.0"}


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host=HOST, port=PORT)

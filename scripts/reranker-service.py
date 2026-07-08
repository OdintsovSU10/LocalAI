import os
from typing import Any

import uvicorn
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel

try:
    from FlagEmbedding import FlagReranker
except ImportError as exc:
    raise RuntimeError(
        "FlagEmbedding is not installed. Run: pip install -r scripts/requirements-reranker.txt"
    ) from exc


DEFAULT_MODEL = os.getenv("RAG_RERANKER_MODEL", "BAAI/bge-reranker-v2-m3")
DEFAULT_MAX_CHARS = int(os.getenv("RAG_RERANKER_MAX_CHARS", "4000"))
DEFAULT_MAX_LENGTH = int(os.getenv("RAG_RERANKER_MAX_LENGTH", "1024"))
USE_FP16 = os.getenv("RAG_RERANKER_USE_FP16", "false").lower() in {"1", "true", "yes", "on"}

app = FastAPI(title="Local RAG Reranker", version="0.1.0")
models: dict[str, FlagReranker] = {}


class RerankRequest(BaseModel):
    model: str | None = None
    query: str
    documents: list[Any]
    top_n: int | None = None
    return_documents: bool = False


def get_model(model_name: str) -> FlagReranker:
    if model_name not in models:
        models[model_name] = FlagReranker(model_name, use_fp16=USE_FP16)
    return models[model_name]


def document_text(document: Any) -> str:
    if isinstance(document, str):
        return document
    if isinstance(document, dict):
        for key in ("text", "content", "document"):
            value = document.get(key)
            if value:
                return str(value)
    return str(document or "")


@app.get("/health")
def health() -> dict[str, Any]:
    return {
        "ok": True,
        "model": DEFAULT_MODEL,
        "loaded": list(models.keys()),
        "useFp16": USE_FP16,
    }


@app.post("/rerank")
def rerank(request: RerankRequest) -> dict[str, Any]:
    query = request.query.strip()
    if not query:
        raise HTTPException(status_code=400, detail="query is required")
    if not request.documents:
        return {"model": request.model or DEFAULT_MODEL, "results": []}

    model_name = (request.model or DEFAULT_MODEL).strip() or DEFAULT_MODEL
    texts = [document_text(document)[:DEFAULT_MAX_CHARS] for document in request.documents]
    pairs = [[query, text] for text in texts]

    reranker = get_model(model_name)
    scores = reranker.compute_score(pairs, normalize=True, max_length=DEFAULT_MAX_LENGTH)
    if not isinstance(scores, list):
        scores = [scores]

    rows = sorted(
        (
            {
                "index": index,
                "relevance_score": float(score),
                **({"document": {"text": texts[index]}} if request.return_documents else {}),
            }
            for index, score in enumerate(scores)
        ),
        key=lambda row: row["relevance_score"],
        reverse=True,
    )

    top_n = request.top_n if request.top_n and request.top_n > 0 else len(rows)
    return {
        "model": model_name,
        "results": rows[:top_n],
    }


if __name__ == "__main__":
    host = os.getenv("RAG_RERANKER_HOST", "127.0.0.1")
    port = int(os.getenv("RAG_RERANKER_PORT", "8080"))
    uvicorn.run(app, host=host, port=port)

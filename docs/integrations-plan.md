# LocalAI RAG integrations plan

## Implemented

1. Move runtime credentials to environment overrides.
   - `.env` can override local LM Studio, remote LM Studio, embeddings, Qdrant, reranker, OCR and PDF converter settings.
   - Public settings responses now mask API keys and expose only `hasApiKey`.

2. Add Qdrant as an optional vector store.
   - `RAG_VECTOR_STORE_PROVIDER=auto` uses Qdrant when available and falls back to `vectors.json`.
   - Reindexing a source refreshes Qdrant points by `sourceId`.
   - `GET /api/vector-store/status` reports collection availability and errors.

3. Add optional external PDF conversion.
   - Built-in mode remains `pdf-parse` plus Tesseract.js fallback.
   - `RAG_PDF_CONVERTER=docling` enables Docling PDF-to-Markdown.
   - `RAG_PDF_CONVERTER=ocrmypdf` enables OCRmyPDF preprocessing before parsing.

4. Add optional reranking.
   - `RAG_RERANKER_ENABLED=true` enables a Jina/Cohere-compatible `POST /rerank` endpoint.
   - If reranking fails, search returns the normal hybrid results.

5. Add UI diagnostics.
   - The settings page has an `Индексы` tab for Qdrant settings and integration status.
   - `GET /api/integrations/status` reports Qdrant, reranker and PDF converter state.

6. Add secret migration helper.
   - `npm run secrets:migrate:dry-run` shows which secret variables would move.
   - `npm run secrets:migrate` appends secrets to `.env`, clears them from `config/settings.json`, and creates a backup.
   - Secret values are never printed to the console.

7. Add a Dify retrieval adapter and prompt pack.
   - `POST /api/dify/retrieval` exposes bounded LOCAL_RAG retrieval for Dify External Knowledge / HTTP tool workflows.
   - Requests require the dedicated env token `LOCALAI_DIFY_ADAPTER_TOKEN`; the normal `RAG_AUTH_TOKEN` is not accepted as the Dify adapter token.
   - Responses include excerpts, citation labels, safe display metadata, LOCAL_RAG privacy metadata and warnings, but not full files, secrets or absolute local paths.
   - The reusable prompt pack is available in `docs/dify-localai-prompt-pack/` and `docs/dify-localai-prompt-pack.zip`.
   - The POC checklist is documented in `docs/dify-localai-poc.md`; Dify remains an optional workflow/UI/orchestration layer, not a second RAG core.

## Enable Qdrant

```powershell
docker compose up -d qdrant
```

Then reindex a source. The status endpoint should show `qdrantAvailable: true`.

```powershell
Invoke-RestMethod http://127.0.0.1:8787/api/vector-store/status
```

### Windows without Docker

If Docker Desktop/WSL is blocked by machine policy, download the Windows Qdrant binary to `C:\qdrant\qdrant.exe`, then run:

```powershell
npm run qdrant:start
```

This starts Qdrant with:

```powershell
$env:QDRANT__STORAGE__STORAGE_PATH="D:\LOCAL_RAG\data\qdrant"
C:\qdrant\qdrant.exe
```

Stop it with:

```powershell
npm run qdrant:stop
```

## Rebuild Qdrant vectors

Main portal path:

1. Open the app at `http://127.0.0.1:8787`.
2. Go to `Настройки` -> `Источники`.
3. Select a project and click `Индексировать` or `Переиндексировать`.
4. The same job scans files, creates chunks, embeds chunks and syncs them to Qdrant when Qdrant is available.

CLI fallback:

```powershell
npm run vectors:list
npm run vectors:backfill -- --smallest --enable-embeddings
npm run vectors:backfill -- --source-id source-xxxxxxxxxx
npm run vectors:backfill -- --all
```

Use `--dry-run` to preview the selected sources. The script resumes through `vectors.json`: sources with matching cached vectors are skipped or reused.

## Enable Docling

Install Docling separately, then set:

```dotenv
RAG_PDF_CONVERTER=docling
RAG_DOCLING_COMMAND=docling
```

Use `RAG_PDF_CONVERTER=auto` only when Docling is installed and you want fallback behavior.

## Enable OCRmyPDF

Install OCRmyPDF plus Tesseract language data, then set:

```dotenv
RAG_PDF_CONVERTER=ocrmypdf
RAG_OCRMYPDF_COMMAND=ocrmypdf
RAG_OCR_LANGS=rus+eng
```

## Enable reranker

Run any compatible Jina/Cohere-style `POST /rerank` service.

Local Windows service:

```powershell
npm run reranker:install
npm run reranker:start
```

The first command creates `.venv-reranker` and installs `FlagEmbedding`, `FastAPI` and `uvicorn`.
The first start downloads the default model `BAAI/bge-reranker-v2-m3`.

Portal path:

1. Open `Настройки` -> `Индексы`.
2. In `Reranker`, enable `Пересортировка найденных фрагментов перед ответом`.
3. Set `URL` to `http://127.0.0.1:8080`, model to `BAAI/bge-reranker-v2-m3`, candidate count and optional API key.
4. Click `Сохранить reranker`.

`.env` fallback:

```dotenv
RAG_RERANKER_ENABLED=true
RAG_RERANKER_BASE_URL=http://127.0.0.1:8080
RAG_RERANKER_MODEL=jina-reranker-v2-base-multilingual
RAG_RERANKER_CANDIDATES=30
```

## Enable Dify adapter

Run Dify self-hosted outside `LOCAL_RAG`.

External Knowledge API endpoint to register in Dify:

```text
http://127.0.0.1:8787/api/dify
```

Dify calls `/retrieval` under that endpoint. HTTP tool workflows can call:

```text
POST http://127.0.0.1:8787/api/dify/retrieval
Authorization: Bearer <LOCALAI_DIFY_ADAPTER_TOKEN>
```

Set `LOCALAI_DIFY_ADAPTER_TOKEN` only through backend env and a Dify secret variable. Do not put the real token into Dify prompt text, `config/settings.json`, screenshots, logs or git.

Use the prompt pack files from:

```text
docs/dify-localai-prompt-pack/
docs/dify-localai-prompt-pack.zip
```

The endpoint contract is in:

```text
docs/dify-localai-prompt-pack/contracts/localai-dify-retrieval-contract.md
```

The adapter searches the existing LOCAL_RAG index and preserves the same local-first privacy decision used by `/api/chat`, `/api/chat/stream`, `eval:llm` and project summary. Dify should not read `data/`, `.env`, live config or user documents directly.

POC acceptance checklist:

```text
docs/dify-localai-poc.md
```

## Move stored secrets to `.env`

```powershell
npm run secrets:migrate:dry-run
npm run secrets:migrate
```

Restart the API after the real migration so `dotenv` reloads the new variables.

## Next useful steps

1. Add a local reranker service recipe for BGE reranker or another cross-encoder.
2. Add fixture-based tests for PDF conversion fallback ordering.
3. Add an index-maintenance action to rebuild or clear one Qdrant collection from UI.
4. Add a small Docker profile for reranker and OCR helpers.

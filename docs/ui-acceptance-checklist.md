# UI Acceptance Checklist

Date: 2026-06-30

Use this checklist for manual browser acceptance. It complements
`npm run check:ui`, which is static and does not open a browser.
Run `npm run smoke:api` before this checklist to verify the real local API
without browser automation.

Record executed results in `docs/ui-acceptance-results.md`. If a scenario was
not actually run in a browser, keep it marked `NOT RUN`.

## Preparation

- Do not use live `.env`, `config/settings.json`, `config/sources.yaml`, or `data/`.
- Use a temporary runtime directory such as `.tmp/ui-smoke-data`.
- Use `fixtures/demo-project` as the source folder.
- Keep remote context disabled by default.
- Keep LM Studio, Qdrant, and OCR optional; the baseline UI smoke should not require them.
- Do not enter real tokens, private remote URLs, or private source paths.
- Run `npm run smoke:api` first; this covers real HTTP endpoints, auth, chat
  fallback, SSE fallback, preview, and source summary through a temp server.
- After `smoke:api`, this manual checklist is still needed for visual layout,
  click flow, and browser-specific behavior.

## Start Server

From the repository root, use the package script:

```powershell
$env:RAG_DATA_DIR = ".tmp/ui-smoke-data"
$env:RAG_REQUIRE_AUTH = "false"
$env:RAG_AUTH_TOKEN = ""
$env:RAG_ALLOW_REMOTE_CONTEXT = "false"
$env:RAG_REMOTE_LLM_ENABLED = "false"
$env:RAG_LLM_FALLBACK_TO_LOCAL_ON_REMOTE_ERROR = "false"
$env:RAG_VECTOR_STORE_ENABLED = "false"
$env:RAG_RERANKER_ENABLED = "false"
$env:RAG_OCR_ENABLED = "false"
npm run dev
```

Open:

```text
http://127.0.0.1:8787
```

## First Load

| Check | Result | Browser | Notes |
| --- | --- | --- | --- |
| UI opens without a blank screen |  |  |  |
| Browser console has no red errors |  |  |  |
| CSS is loaded |  |  |  |
| Chat, sources, and settings sections are visible |  |  |  |
| No visible mojibake in newly touched UI areas |  |  |  |

## Source Indexing

| Check | Result | Browser | Notes |
| --- | --- | --- | --- |
| Add source using `fixtures/demo-project` |  |  |  |
| Include/exclude controls display or apply correctly |  |  |  |
| Start indexing |  |  |  |
| Progress/status is visible |  |  |  |
| After indexing, 5 demo files and chunks or equivalent stats are visible |  |  |  |
| Source summary/project card is visible |  |  |  |

## Chat Without LLM

Ask:

```text
Какая сумма договора?
```

| Check | Result | Browser | Notes |
| --- | --- | --- | --- |
| App does not crash when LM Studio is unavailable |  |  |  |
| Fallback shows found sources/chunks |  |  |  |
| Citations are displayed |  |  |  |
| RAG debug panel is available for the answer |  |  |  |

## Chat Streaming

| Check | Result | Browser | Notes |
| --- | --- | --- | --- |
| UI calls or behaves consistently with `/api/chat/stream` |  |  |  |
| If LLM is available, answer appears progressively |  |  |  |
| If LLM is unavailable, fallback is understandable |  |  |  |
| Old `/api/chat` endpoint still works through API/manual request |  |  |  |

## Stop / Abort

| Check | Result | Browser | Notes |
| --- | --- | --- | --- |
| Start a long request |  |  |  |
| Click stop |  |  |  |
| Request is interrupted |  |  |  |
| UI returns to a normal idle state |  |  |  |
| Next question can be sent |  |  |  |
| Browser console has no uncaught errors |  |  |  |

## Citations And Source Preview

| Check | Result | Browser | Notes |
| --- | --- | --- | --- |
| Clicking a citation opens the exact evidence/chunk preview, not just the file |  |  |  |
| Preview label matches the cited file |  |  |  |
| Preview excerpt contains the evidence used in the answer |  |  |  |
| Preview does not show random unrelated text |  |  |  |
| Citation label is human-readable |  |  |  |
| Markdown `sectionTitle` appears in labels or preview context |  |  |  |
| Broken or unknown citation does not read arbitrary files |  |  |  |
| Broken preview shows a clear error/fallback |  |  |  |

## RAG Debug Panel

| Check | Result | Browser | Notes |
| --- | --- | --- | --- |
| Debug panel expands |  |  |  |
| Provider/model or fallback status is visible |  |  |  |
| Retrieval mode, candidate counts, and timings are visible |  |  |  |
| Top sources are visible |  |  |  |
| Secrets, private base URLs, and tokens are not displayed |  |  |  |

## Auth UI Smoke

Run separately with a dummy token only:

```powershell
$env:RAG_DATA_DIR = ".tmp/ui-smoke-data"
$env:RAG_REQUIRE_AUTH = "true"
$env:RAG_AUTH_TOKEN = "local-ui-smoke-token"
$env:RAG_ALLOW_REMOTE_CONTEXT = "false"
$env:RAG_REMOTE_LLM_ENABLED = "false"
npm run dev
```

| Check | Result | Browser | Notes |
| --- | --- | --- | --- |
| Requests without token receive 401 |  |  |  |
| UI shows a clear state for auth failure |  |  |  |
| If UI supports token entry, requests work after token entry |  |  |  |
| If UI does not support token entry, limitation is documented, not silent |  |  |  |
| Token is not logged or displayed after entry |  |  |  |

## Remote Context Warning

| Check | Result | Browser | Notes |
| --- | --- | --- | --- |
| Remote is disabled by default |  |  |  |
| Enabling remote context shows a warning |  |  |  |
| Without `allowRemoteContext`, remote is not used |  |  |  |
| No real secret is displayed in settings, debug, logs, or source preview |  |  |  |

## SQLite Mode Optional

Run as a separate manual check only when needed:

| Check | Result | Browser | Notes |
| --- | --- | --- | --- |
| `storage.metadataProvider=sqlite` is active in temp runtime |  |  |  |
| Source indexing works |  |  |  |
| Source summary card works |  |  |  |
| Chat/retrieval fallback works |  |  |  |

## Result Template

| Scenario | PASS/WARN/FAIL | Browser | Notes | Screenshot/log reference |
| --- | --- | --- | --- | --- |
| First load |  |  |  |  |
| Source indexing |  |  |  |  |
| Chat without LLM |  |  |  |  |
| Chat streaming |  |  |  |  |
| Stop/Abort |  |  |  |  |
| Citations/source preview |  |  |  |  |
| RAG debug panel |  |  |  |  |
| Auth UI smoke |  |  |  |  |
| Remote context warning |  |  |  |  |
| SQLite optional |  |  |  |  |

## Known Manual WARN

Without browser automation, these remain manual until a human runs the checklist:

- Visual layout and responsive behavior.
- Real token-by-token streaming in a browser.
- Stop button behavior against an in-flight request.
- Citation click and source preview flow.
- Auth UI flow.

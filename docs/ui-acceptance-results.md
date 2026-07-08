# UI Acceptance Results

Date: 2026-06-30

Status: WARN after Stage 29B manual re-test. Human-executed browser results from
Stage 28B found one P1 in citation/source preview targeting. Stage 29 added an
automated exact-evidence API smoke gate, and Stage 29B manual demo citation
re-test passed. Remaining warnings are optional/manual gaps, not P0/P1.

## Environment

| Field | Value |
| --- | --- |
| Check date | 2026-06-30 |
| Tester results | Provided in Stage 28B and Stage 29B |
| OS | Not provided by tester |
| Browser/version | Not provided by tester |
| Server command | `npm run dev` |
| Main UI URL | `http://127.0.0.1:8787` |
| Auth UI URL | `http://127.0.0.1:8788` for the auth scenario |
| Runtime data dir | `.tmp/ui-smoke-data`; auth scenario also used `.tmp/ui-smoke-auth-runtime`, `.tmp/ui-smoke-auth-data`, `.tmp/ui-smoke-auth-dev.*` |
| Remote context | Disabled in reported runs; warning scenario was not run |
| Live config/data | Codex did not read live `.env`, `config/settings.json`, `config/sources.yaml`, or `data/` |
| Manual source | Tester used a private source path/title; path/title and private filenames are redacted from this release doc |
| Fixture source | `fixtures/demo-project` was used in the auth backend check |
| LM Studio | Optional scenario was run after waiting for enable/startup |

## Pre-Flight Commands

Run these before manual browser acceptance:

```powershell
npm run check
npm test
npm run check:ui
npm run eval:retrieval
npm run smoke:local
npm run smoke:api
npm run eval:demo
```

The latest automated command results are tracked in `docs/regression-matrix.md`
and in the stage final report.

## Safe Manual Server Start

The project server command comes from `package.json`:

```json
"dev": "node apps/rag-api/src/server.js"
```

Use a temporary runtime and local-first privacy settings in Windows PowerShell:

```powershell
$env:RAG_DATA_DIR = ".tmp/ui-smoke-data"
$env:RAG_REQUIRE_AUTH = "false"
$env:RAG_AUTH_TOKEN = ""
$env:RAG_ALLOW_REMOTE_CONTEXT = "false"
$env:RAG_REMOTE_LLM_ENABLED = "false"
$env:RAG_LLM_PROVIDER = "local"
$env:RAG_LLM_FALLBACK_TO_LOCAL_ON_REMOTE_ERROR = "false"
$env:RAG_VECTOR_STORE_ENABLED = "false"
$env:RAG_RERANKER_ENABLED = "false"
$env:RAG_OCR_ENABLED = "false"
npm run dev
```

Then open:

```text
http://127.0.0.1:8787
```

## Manual Acceptance Table

| Scenario | Steps | Expected result | Actual result | Status | Notes |
| --- | --- | --- | --- | --- | --- |
| A. First load | Open UI; verify CSS; inspect browser console; verify chat/sources/settings are visible; check for mojibake. | UI loads, CSS is applied, no red console errors, no visible mojibake in checked areas. | Tester reported all checks passed and listed green preflight commands. Final automated gates are tracked in `docs/regression-matrix.md` and `docs/final-verification.md`. | PASS | Browser OS/version and console details were not separately provided for this scenario. |
| B. Source indexing | Add a source; start index; watch progress; inspect indexed files/stats and source summary card. | Progress is visible; files/chunks or equivalent stats are shown; source summary/project card appears. | Private tester source indexed and displayed a project summary: 37 files, 653 chunks, updated 30.06 11:11; extensions `.pdf` 21, `.docx` 10, `.xlsx` 6; quality warnings reported 20 PDFs without extractable text, 20 files without text fragments, and 20 files with too few recognized words. | PASS | Private source path/title and filenames are redacted. Quality warnings are source-data quality, not a UI regression by themselves. |
| C. Chat without LLM | Keep LM Studio unavailable/disabled; ask a project question; inspect answer, citations, provider metadata. | UI does not crash; fallback shows sources/citations; provider is not remote. | LLM was disabled in settings; UI showed the most relevant fragments. | PASS | Matches local fallback behavior. |
| D. Citations/source preview click flow | Click a citation; inspect preview file/chunk, label, section title, and broken citation behavior. | Correct preview opens at the evidence chunk; label is readable; traversal/unknown citation does not read arbitrary files. | Stage 29B re-test passed: demo contract amount citation opens the exact evidence excerpt, not a random file area; demo payment schedule citation opens relevant payment evidence. | PASS | Stage 28B P1 is resolved for demo browser re-test and covered by `smoke:api` exact-evidence checks. Private source re-test was not provided with a concrete status. |
| E. RAG debug panel | Expand debug panel after an answer; inspect retrieval mode, timings, candidates/scores, and secrecy. | Debug details are visible; no secrets/tokens are displayed. | Diagnostics displayed project metadata, provider `local`, retrieval `lexical`, candidates `vector 0`, `lexical 200`, `merged 60`, 12 sources, prompt chars 0, answer chars 60, timings `retrieval 46 ms`, `rerank 0 ms`, `llm 0 ms`, `total 51 ms`, and top scored results. | PASS | Private project/file names from tester output are redacted; no secret/token value was reported. |
| F. Streaming without LLM | Submit a chat request with LLM disabled; observe `/api/chat/stream` fallback UI completion. | Streaming fallback does not break UI and answer completes correctly. | With LLM disabled, UI showed fallback text and listed found sources below. | PASS | Matches expected streaming fallback behavior. |
| G. Streaming with LM Studio optional | If LM Studio is available, submit a request and observe gradual token display. | Token-by-token behavior is visible. If LM Studio is unavailable, mark WARN/PARTIAL/NOT RUN. | Tester reported issues with enabling LLM: it requires waiting before it works. After waiting, a project-summary-and-risks request produced a substantive answer. | WARN | P2/optional: LM Studio readiness/startup timing is rough, but the request eventually completed. |
| H. Stop/Abort | Start a long request; click stop; verify interrupted request, normal idle state, next question works, no uncaught console errors. | Request stops; UI recovers; next request can be sent. | Tester reported pass. | PASS | No extra notes provided. |
| I. Auth UI flow | Restart with `RAG_REQUIRE_AUTH=true` and dummy `RAG_AUTH_TOKEN`; verify 401 without token and UI behavior. | UI shows clear auth state; token support or limitation is explicit; no token is displayed/logged. | WARN: UI has no API auth token field; the remote LLM token field is not suitable for `Authorization: Bearer`. Server without token returns 401 on `/api/settings` with `API auth token is required`. UI shows that message clearly, has no infinite spinner, page does not crash, browser console error was empty. With dummy Bearer, backend works for `/api/settings`, `/api/sources`, indexing demo source, and `/api/chat`; demo source indexed 5 files; remote context stayed off; dummy token did not appear in UI or server logs. | WARN | P2 documented limitation. Tester left the auth server running on `http://127.0.0.1:8788` because `8787` was occupied. |
| J. Remote context warning | Verify remote disabled by default; enable remote context in UI; inspect warning and secret masking. | Warning is visible; remote is not used without explicit allow; secrets are not displayed. | No concrete result supplied; placeholder was provided. | NOT RUN | Keep `NOT RUN` until a real browser result is provided. |
| K. Optional SQLite UI smoke | If convenient, enable SQLite metadata provider in temp runtime; index source; inspect summary card and chat fallback. | SQLite UI flow works in temp runtime. | No result supplied. | NOT RUN | Optional scenario. |

## Results Summary

| Metric | Count |
| --- | ---: |
| Total PASS | 7 |
| Total WARN | 2 |
| Total FAIL | 0 |
| Total NOT RUN | 2 |

## Stage 29 Fix Status

| Item | Status | Notes |
| --- | --- | --- |
| Citation target metadata | PASS | `/api/chat` and `/api/chat/stream` sources now include stable `chunkId`, `fileId`, `chunkIndex`, label, section/page/sheet metadata, snippet, and `citationTarget`. |
| Preview exact evidence API | PASS | `npm run smoke:api` verifies exact preview evidence for contract amount and payment schedule against `fixtures/demo-project`. |
| Preview traversal guard | PASS | `npm run smoke:api` keeps the traversal probe; resolver tests cover unknown/wrong chunk targets and unsafe paths. |
| Browser citation click flow | PASS | Stage 29B demo contract amount and payment schedule citation clicks opened exact/relevant evidence. |
| Source preview visual exact excerpt | PASS | Stage 29B confirmed exact evidence excerpt for the demo contract amount citation. |
| Private source re-test | NOT RUN | No concrete PASS/WARN/NOT RUN value was supplied; private paths/titles/filenames/excerpts are not recorded. |
| Browser console | NOT RUN | Placeholder was supplied instead of a concrete PASS/WARN/FAIL value. |

## Stage 29B Re-Test Summary

| Check | Status | Notes |
| --- | --- | --- |
| Demo contract amount citation | PASS | Preview opens exact evidence excerpt, not a random file area. |
| Demo payment schedule citation | PASS | Preview opens relevant payment evidence. |
| Chat without LLM sanity | PASS | Re-tested by human. |
| RAG debug panel sanity | PASS | Re-tested by human. |
| Streaming fallback sanity | PASS | Re-tested by human. |
| Private source re-test | NOT RUN | No concrete status was supplied; no private paths/source titles/filenames/excerpts are recorded. |
| Browser console | NOT RUN | No concrete status was supplied. |
| P0 | PASS | No P0 issues reported. |
| P1 | PASS | Citation/source preview P1 resolved by Stage 29 fix and Stage 29B demo re-test. |
| P2 | PASS | No new P2 from citation re-test; existing optional/manual P2 items remain below. |

## Findings

| Priority | Finding |
| --- | --- |
| P0 | None. |
| P1 | Resolved: Stage 28B citation/source preview bug is fixed in automated API coverage and Stage 29B demo browser re-test. |
| P2 | Optional LM Studio streaming has rough enable/startup timing and may require waiting before it works. |
| P2 | Auth UI has no field for the API auth Bearer token. Backend auth works with a dummy token and the UI fails clearly without crashing, but browser-side authenticated usage is a documented limitation. |
| P2 | Remote context warning scenario, optional SQLite UI smoke, private source citation re-test, and browser console check remain not run or not concretely reported. |

## Evidence

| Evidence Type | Notes |
| --- | --- |
| Screenshots | Not provided. |
| Browser console | Auth scenario from Stage 28B reported an empty browser console error state; Stage 29B supplied no concrete browser-console status. |
| Server logs | Tester reported the dummy token did not appear in UI or server logs; logs were not attached. |
| Browser/version | Not provided. |
| Tester notes | Recorded in the manual acceptance table above. Private source path/title and filenames are intentionally redacted. |

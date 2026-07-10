# Regression Matrix

Date: 2026-06-30

Scope: release-candidate regression pass after feature-freeze, stage 22 privacy cleanup, stage 24 local smoke/demo eval gate, stage 25 source-summary storage round-trip coverage, stage 26 frontend static smoke, and stage 27 runtime API smoke.
Live ignored files were not inspected for secret values: `.env`, `config/settings.json`, `config/sources.yaml`, `data/`, `node_modules/`, `.git/`.

## Matrix

| Area | Scenario | Command / Check | Expected result | Actual result | Status | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| Baseline | Syntax check | `npm run check` | All checked JS files parse | Passed | PASS | Covers UI app/modules, API modules, scripts. |
| Baseline | Unit/regression tests | `npm test` | Test suite passes | Passed: 86/86 | PASS | Includes routing, auth, search, SQLite, preview resolver, citation target builder, SSE helpers, demo eval gate tests, and source-summary storage round-trip tests. |
| Baseline | Frontend static smoke | `npm run check:ui` | UI entrypoint, local asset refs, module imports, node syntax, inline handlers, key markers, and private-default scan pass without browser dependencies | Passed | PASS | PASS 28, WARN 0, FAIL 0. Does not read live config/data or open a browser. |
| Eval | Retrieval eval | `npm run eval:retrieval` | Runs strict demo retrieval without LLM or external services | Passed | PASS | Loaded 6 cases, evaluated 6, Recall@3/5/10=1.000, MRR=1.000. |
| Eval | Retrieval assertion depth | `npm run eval:retrieval` output | Recall evaluated when cases include `expectedFileHint`; fail if evaluated=0 | 6 retrieval cases evaluated | PASS | Strict mode fails on zero evaluated cases or top-5 expected file misses. |
| Eval | Demo alias | `npm run eval:demo` | Same strict demo retrieval gate as `eval:retrieval` | Passed | PASS | Loaded 6 cases, evaluated 6, Recall@3/5/10=1.000, MRR=1.000. |
| Eval | Clean local smoke | `npm run smoke:local` | Uses temp runtime and fixture only; no live config/data, LM Studio, Qdrant, OCR, or LLM | Passed | PASS | Demo files=5, chunks=5, cases=6, evaluated=6, Recall@3/5=1.000, MRR=1.000; temp cleaned by default. |
| API runtime | Full local API smoke | `npm run smoke:api` | Starts temp local server and checks real HTTP endpoints without browser or external services | Passed | PASS | PASS 12, WARN 0, FAIL 0. Uses temp copied runtime, not live config/data. |
| API runtime | No-auth API smoke | `npm run smoke:api` | Health, sources, source add/index, job polling, source summary, chat fallback, SSE fallback, preview pass without auth | Passed | PASS | Uses `fixtures/demo-project`; indexes through public API. |
| API runtime | Auth API smoke | `npm run smoke:api` | `/api/*` rejects missing/wrong token and accepts smoke token | Passed | PASS | Smoke token used only inside script; token value not printed. |
| API runtime | Chat fallback | `npm run smoke:api` | `/api/chat` returns sources and local-only metadata with LLM disabled | Passed | PASS | `remoteContextAllowed=false`; selected provider/base URL are not remote. |
| API runtime | Streaming fallback | `npm run smoke:api` | `/api/chat/stream` returns SSE events and done payload without remote context | Passed | PASS | Checks `sources` and `done` events. |
| API runtime | Abort probe | `npm run smoke:api` | Abort stream request and verify server remains healthy | Passed | PASS | Uses AbortController against SSE stream, then checks `/api/health`. |
| API runtime | Preview endpoint | `npm run smoke:api` | Citation preview returns exact demo evidence by citation target; traversal probe returns 400/403/404 | Passed | PASS | Verifies `targetMatched=true` and exact evidence for contract amount and payment schedule. |
| API runtime | Citation exact evidence | `npm run smoke:api` | Preview opened from `/api/chat` source target lands on the exact chunk, not just any file preview | Passed | PASS | Checks `contract.md` contains `12 450 000 рублей` and `budget.md` contains payment schedule evidence. |
| Eval | LLM eval | `npm run eval:llm` | Do not call real LLM without explicit flag/env | Skipped | PASS | `eval:llm` calls `/api/chat`; safe skip per task. |
| Package scripts | Required scripts | Inspect `package.json` | `check`, `test`, `eval:retrieval`, `eval:llm` exist | All present | PASS | Scripts map to `node --check`, `node --test`, `scripts/run-evals.mjs`, and `--with-llm`. |
| Package scripts | Long/risky scripts | Inspect `package.json` | List but do not run migration/service scripts | Listed, not run | PASS | `agent:*`, `secrets:migrate*`, `metadata:migrate:sqlite`, `qdrant:*`, `reranker:*`, `vectors:*`. |
| Storage | JSON provider default | Compare `config/settings.example.json` and `defaultStorageSettings` | Default is `json` in template and code | Both `json` | PASS | No default mismatch. |
| Storage | JSON fallback format | `npm test` / `tests/sqlite-metadata.test.mjs` | JSON chunks/manifest remain supported | Covered and passing | PASS | `json metadata provider still writes and searches chunks json`. |
| Storage | SQLite provider | `npm test` / `tests/sqlite-metadata.test.mjs` | SQLite schema init and reads work | Covered and passing | PASS | Synthetic indexing creates `metadata.sqlite`; search reads SQLite chunks. |
| Storage | JSON -> SQLite migration | Inspect scripts/docs/tests | Migration documented or covered | Documented and script exists | PASS | `npm run metadata:migrate:sqlite`; migration helper in `store.js` and script. |
| Vector store | Default provider | Compare template and code | Default is `auto` in template and code | Both `auto` | PASS | No default mismatch. |
| Vector store | `provider=json` | `npm test` / `tests/vector-store.test.mjs` | Explicit JSON/debug store, no Qdrant required | Covered and passing | PASS | `writeJson=true`, `useQdrant=false`. |
| Vector store | `provider=auto` | `npm test` / `tests/vector-store.test.mjs` | Qdrant first; JSON fallback with warning when unavailable | Covered and passing | PASS | No silent failure; warning includes Qdrant error. |
| Vector store | `provider=qdrant` | `npm test` / `tests/vector-store.test.mjs` | Qdrant required; no JSON fallback | Covered and passing | PASS | `qdrantRequired=true`, `writeJson=false`. |
| LLM/privacy | Default provider | Compare template and code | Default provider is `local` | Both `local` | PASS | Stage 23 P1 cleanup kept local-first policy. |
| LLM/privacy | Remote context default | Compare template and code | Disabled until explicit allow | Disabled in both | PASS | `allowRemoteContext=false`, `remote.enabled=false`. |
| LLM/privacy | Local/auto/remote routing | `npm test` / `tests/llm-routing.test.mjs` | Local-only default; auto local-first; remote blocked without context | Covered and passing | PASS | No real remote requests. |
| LLM/privacy | Remote configured but not allowed | `tests/llm-routing.test.mjs` | Remote candidate has `missingRemoteContext` | Covered and passing | PASS | Remote URL/key presence alone does not allow context. |
| LLM/privacy | Fallback flag | `tests/llm-routing.test.mjs` | Remote-to-local fallback only with explicit flag | Covered and passing | PASS | `fallbackToLocalOnRemoteError=true` produces remote then local candidates. |
| LLM/privacy | `/api/chat` and stream policy | Inspect `server.js` | Both use `readSettings`, `chatLlmCandidates`, `runChatLlm` | Same routing path inspected | PASS | Streaming and non-stream duplicate retrieval flow but share candidate builder and LLM runner. |
| LLM/privacy | Project summary privacy | Inspect `source-summary.js`, `indexer.js` | Summary does not call remote LLM | Deterministic summary only | PASS | `llmSummary` is optional input; current indexer uses deterministic summary. |
| LLM/privacy | `eval:llm` privacy | Inspect `scripts/run-evals.mjs` | Uses `/api/chat`, same server policy | Confirmed | PASS | Skipped runtime LLM call. |
| Auth/security | Auth unset | `npm test` / `tests/security.test.mjs` | API middleware allows local requests without auth | Covered and passing | PASS | Also warns for unsafe non-loopback host without token. |
| Auth/security | Auth token set | `npm test` / `tests/security.test.mjs` | Missing/wrong Bearer rejected; correct Bearer accepted | Covered and passing | PASS | Values in tests are dummy placeholders. |
| Auth/security | `RAG_REQUIRE_AUTH=true` | `tests/security.test.mjs` | Requires token; missing token is config error | Covered and passing | PASS | Returns 503 when auth required without token. |
| Auth/security | Browser Origin | `tests/security.test.mjs` | localhost allowed; suspicious origin rejected | Covered and passing | PASS | Includes localhost, 127.0.0.1, ::1, and non-local origin. |
| Preview security | Unknown sourceId | `tests/preview-access.test.mjs` | Unknown source rejected | Covered and passing | PASS | `findKnownSource` returns null. |
| Preview security | Traversal and encoded traversal | `tests/preview-access.test.mjs` | `../` and `%2e%2e` rejected | Covered and passing | PASS | Query path and cache path checks covered. |
| Preview security | Absolute/Windows paths | `tests/preview-access.test.mjs` | Absolute path cannot match manifest; cache path must stay inside root | Covered and passing | PASS | Includes `C:\Windows\win.ini` and out-of-root cache path. |
| UI modules | Module entry | `rg` + `npm run check` | HTML uses `type="module"` with valid `/app.js`; app imports modules | Confirmed | PASS | `index.html` has `<script type="module" src="/app.js">`; `app.js` imports `./modules/*.js`. |
| UI modules | Inline handlers | `rg -n '<script|type="module"|src="/app\.js"|on[a-z]+=' apps/rag-ui/index.html` | No inline event handlers requiring globals | No inline handlers found | PASS | Only normal attributes like `content=` also matched broad rg; no `onclick=` style handlers. |
| UI modules | Static marker coverage | `npm run check:ui` | Chat, stop/send, sources, settings, RAG debug, source summary, remote warning, citation preview, stream and abort markers exist | Confirmed | PASS | Static coverage only; user interaction remains manual. |
| UI modules | Manual acceptance checklist | `docs/ui-acceptance-checklist.md` | Practical browser checklist exists | Present | PASS | Covers first load, indexing, chat fallback, streaming, stop/abort, citations, debug panel, auth, remote warning, optional SQLite. |
| UI modules | Manual UI acceptance results | `docs/ui-acceptance-results.md` | Human-executed browser acceptance is recorded without fake PASS | Stage 29B recorded PASS 7 / WARN 2 / FAIL 0 / NOT RUN 2 | WARN | No P0/P1 remains. WARN because optional/manual checks are still not run or not concretely reported. |
| UI modules | Browser behavior | Manual browser check | Full UI should load and interact | Stage 29B citation re-test passed | WARN | Demo citation/source preview exact evidence passed manually; private source and browser console statuses were not concretely supplied. |
| UI modules | Citation/source preview exact evidence | Manual Stage 29B re-test + `npm run smoke:api` | Citation click opens exact evidence/chunk, not just the file | Passed for demo contract amount and payment schedule | PASS | P1 resolved in demo browser re-test and API smoke exact-evidence gate. |
| SSE | Old endpoint | Inspect `server.js` | `/api/chat` preserved | Present | PASS | Non-stream JSON endpoint remains. |
| SSE | Streaming endpoint | Inspect `server.js`; `tests/sse.test.mjs` | `/api/chat/stream` exists and emits SSE events | Present; helper tests pass | PASS | Helper tests cover event formatting. |
| SSE | Stream fallback | Inspect `llm.js` | Falls back to non-stream LLM completion when stream endpoint fails before tokens | Present | PASS | `chatCompletionStream` calls `chatCompletion` if no token emitted. |
| SSE | Abort/stop path | Inspect `server.js`, `app.js` | AbortController cancels request and UI state is cleared | Inspected | WARN | Code path exists; no browser/integration test in this pass. |
| Source summary | Deterministic summary | `tests/source-summary.test.mjs` | Works without LLM | Covered and passing | PASS | Verifies counts, top file types, quality warnings. |
| Source summary | JSON storage round-trip | `npm test` / `tests/source-summary-storage.test.mjs` | Temp-only write, read, update, and missing summary checks pass | Covered and passing | PASS | Uses explicit temp `source-summaries.json`; does not read live config/data or require external services. |
| Source summary | SQLite storage round-trip | `npm test` / `tests/source-summary-storage.test.mjs` | Temp-only schema/init, write, read, update, and missing summary checks pass | Covered and passing | PASS | Uses temp `metadata.sqlite`; no LM Studio, Qdrant, OCR, or network. |
| Source summary | `/api/sources` exposure | Inspect `server.js` | Returns public source summary without API keys | Confirmed | PASS | `publicSource` includes source metadata and summary; settings masking is separate. |
| Docs | README local-first/privacy | `rg` and inspection | README describes local-first and remote context warning | Present | PASS | Also documents `eval:llm` uses `/api/chat` privacy policy. |
| Docs | README auth/streaming/storage/vector/templates | `rg` and inspection | Docs match code and templates | Present | PASS | Includes auth env, `/api/chat/stream`, SQLite, Qdrant, config templates. |
| Docs | `.env.example` env names | `rg` and code inspection | Names match actual code | Required names present | PASS | Includes `RAG_ALLOW_REMOTE_CONTEXT`, `RAG_REMOTE_LLM_ENABLED`, `RAG_LLM_FALLBACK_TO_LOCAL_ON_REMOTE_ERROR`. |
| Docs | AGENTS/codex policy | Inspection | No conflict with local-first privacy policy | No conflict found | PASS | Both require env-based real secrets and shared privacy policy. |
| Encoding | Mojibake scan | Precise common-marker `rg` over safe files, excluding live ignored config | No common mojibake markers in product/docs | No matches before this report was created | PASS | After report creation, this file can self-match if it documents the marker regex; that is a false positive. |
| Git status | Live config tracking | `git ls-files config/settings.json config/sources.yaml .env` | Live config and `.env` not tracked | No output | PASS | `git check-ignore` confirms ignore rules for live config, `.env`, `data/`. |
| Git status | Example/template tracking | `git ls-files ...example...`; `git ls-files --others --exclude-standard ...` | Templates should be committed/tracked in release branch | Present but untracked in this worktree | WARN | Entire repo appears largely untracked; files are not ignored and are ready to add in the release commit. |
| Git status | Release inventory | `docs/release-file-inventory.md` | Intended release files and protected local files documented | Present | PASS | Includes git status, tracked/ignored checks, do-not-commit list, and suggested commit grouping. |
| Git status | Generated output ignore | `git check-ignore -v scripts/__pycache__/... smoke-output/... benchmark-output/... .tmp/...` | Generated output is ignored | Confirmed | PASS | `.gitignore` now covers `__pycache__/` and `*.pyc` in addition to smoke/benchmark/temp output. |
| Git status | Analysis artifact ignore | `git check-ignore -v LocalAI-analysis-sanitized-2026-06-29-104140.zip` | Local analysis zip is ignored or explicitly do-not-commit | Ignored | PASS | `.gitignore` covers `LocalAI-analysis-*.zip` and `*-analysis-sanitized-*.zip`. |
| Stage 24 | Demo fixture | Inspect `fixtures/demo-project/*.md`, `evals/demo-project.json` | Safe fixture has 5 docs and 6 meaningful cases | Present | PASS | No real API keys or private source paths in fixture/eval definitions. |
| Stage 24 | Demo state paths | `npm test` / `tests/demo-eval.test.mjs` | Demo index results do not use absolute workspace paths | Covered and passing | PASS | Runtime still reads fixture files from repo, but generated demo chunk paths are neutral relative paths. |
| P1 cleanup | Neutral defaults/placeholders | `rg -n "01\.vibe|C:\\Users|odintsov"` safe files | No private remote URL in code/UI/docs; primary README/env data path is neutral | Private remote URL removed; README/env now use `D:\LOCAL_RAG\data` | PASS | Qdrant helper docs/script now default to `D:\LOCAL_RAG\data\qdrant`. |

## Findings

### P0

None found.

### P1

- Resolved: Stage 29 added stable citation target metadata, exact chunk preview resolution, UI click payload targeting, and `smoke:api` exact-evidence checks; Stage 29B demo browser re-test passed.
- Fixed: private remote default/placeholder URL was present in API/UI defaults. Replaced with neutral `https://example-lm-studio/v1`.
- Fixed: README and `.env.example` used an old user-specific data path. Replaced with `D:\LOCAL_RAG\data`, matching code default behavior better.

### P2 / Follow-up

- Manual UI acceptance results are recorded in `docs/ui-acceptance-results.md`: Stage 29B PASS 7, WARN 2, FAIL 0, NOT RUN 2; overall status WARN because optional/manual checks remain.
- Private source citation re-test and browser console status were not concretely supplied in Stage 29B.
- Optional LM Studio streaming has rough enable/startup timing and may require waiting before it works.
- Auth UI has no API auth Bearer token field; backend auth works with a dummy token and the UI fails clearly without crashing.
- Remote context warning and optional SQLite UI smoke remain `NOT RUN`.
- No browser automation dependency was added; visual/browser behavior remains governed by `docs/ui-acceptance-checklist.md`.
- Example/template files are present and not ignored, but not tracked in the current git index because this worktree appears largely untracked.
- Qdrant helper docs/script now default to `D:\LOCAL_RAG\data\qdrant`.

## Final Command Results

- `npm run check`: PASS.
- `npm test`: PASS, 86/86.
- `npm run check:ui`: PASS, 28 checks passed, 0 warnings, 0 failures.
- `npm run eval:retrieval`: PASS, 6 cases loaded, 6 recall-evaluated cases, Recall@3 1.000, Recall@5 1.000, Recall@10 1.000, MRR 1.000.
- `npm run eval:demo`: PASS, 6 cases loaded, 6 recall-evaluated cases, Recall@3 1.000, Recall@5 1.000, Recall@10 1.000, MRR 1.000.
- `npm run smoke:local`: PASS, temp runtime, 5 demo files, 5 chunks, 6 cases loaded/evaluated, Recall@3 1.000, Recall@5 1.000, MRR 1.000, LLM/Qdrant/OCR disabled.
- `npm run smoke:api`: PASS, 12 checks, temp local server, no-auth and auth API checks, source add/index, source summary, chat fallback, SSE fallback, abort probe, exact-evidence preview gate, traversal guard.
- `npm run eval:llm`: skipped safely; it calls `/api/chat` and would require an explicit real LLM/API target.

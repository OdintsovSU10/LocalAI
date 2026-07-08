# Release File Inventory

Date: 2026-06-30

Scope: feature-freeze release inventory after the local-first privacy cleanup,
demo eval gate, and source-summary storage round-trip coverage.

Live ignored files were not inspected for values: `.env`,
`config/settings.json`, `config/sources.yaml`, and `data/`.

## Intended Release Files

### Project Instructions

- `AGENTS.md`
- `codex.md`

### Config Templates

- `.env.example`
- `config/settings.example.json`
- `config/sources.example.yaml`

### Root Project Files

- `.gitignore`
- `compose.yaml`
- `package.json`
- `package-lock.json`

### Backend Changes

- `apps/rag-api/src/citations.js`
- `apps/rag-api/src/converters.js`
- `apps/rag-api/src/daily-agent.js`
- `apps/rag-api/src/dialog.js`
- `apps/rag-api/src/embeddings.js`
- `apps/rag-api/src/filesystem.js`
- `apps/rag-api/src/indexer.js`
- `apps/rag-api/src/llm-routing.js`
- `apps/rag-api/src/llm.js`
- `apps/rag-api/src/path-filter.js`
- `apps/rag-api/src/paths.js`
- `apps/rag-api/src/preview-access.js`
- `apps/rag-api/src/reranker.js`
- `apps/rag-api/src/search-bm25.js`
- `apps/rag-api/src/search-pipeline.js`
- `apps/rag-api/src/search-query.js`
- `apps/rag-api/src/search-scoring.js`
- `apps/rag-api/src/search.js`
- `apps/rag-api/src/security.js`
- `apps/rag-api/src/server.js`
- `apps/rag-api/src/source-match.js`
- `apps/rag-api/src/source-summary.js`
- `apps/rag-api/src/sqlite-metadata-store.js`
- `apps/rag-api/src/sse.js`
- `apps/rag-api/src/store.js`
- `apps/rag-api/src/text.js`
- `apps/rag-api/src/vector-store.js`

### Frontend Changes

- `apps/rag-ui/app.js`
- `apps/rag-ui/index.html`
- `apps/rag-ui/styles.css`
- `apps/rag-ui/modules/api-client.js`
- `apps/rag-ui/modules/citation-helpers.js`
- `apps/rag-ui/modules/formatting-helpers.js`
- `apps/rag-ui/modules/settings-helpers.js`

### Scripts

- `scripts/backfill-vectors.mjs`
- `scripts/check-ui-static.mjs`
- `scripts/daily-agent.mjs`
- `scripts/eval-utils.mjs`
- `scripts/index.ps1`
- `scripts/install-daily-agent.ps1`
- `scripts/install-reranker-autostart.ps1`
- `scripts/migrate-metadata-to-sqlite.mjs`
- `scripts/migrate-secrets-to-env.mjs`
- `scripts/requirements-reranker.txt`
- `scripts/reranker-service.py`
- `scripts/run-evals.mjs`
- `scripts/smoke-api-local.mjs`
- `scripts/smoke-local.mjs`
- `scripts/start-qdrant-windows.ps1`
- `scripts/start-reranker-windows.ps1`
- `scripts/start.ps1`
- `scripts/stop-qdrant-windows.ps1`
- `scripts/uninstall-daily-agent.ps1`

### Tests

- `tests/citations.test.mjs`
- `tests/demo-eval.test.mjs`
- `tests/frontend-helpers.test.mjs`
- `tests/llm-routing.test.mjs`
- `tests/path-filter.test.mjs`
- `tests/preview-access.test.mjs`
- `tests/search-bm25.test.mjs`
- `tests/search-candidates.test.mjs`
- `tests/search-pipeline.test.mjs`
- `tests/search.test.mjs`
- `tests/security.test.mjs`
- `tests/smoke.test.mjs`
- `tests/source-match.test.mjs`
- `tests/source-summary-storage.test.mjs`
- `tests/source-summary.test.mjs`
- `tests/sqlite-metadata.test.mjs`
- `tests/sse.test.mjs`
- `tests/text.test.mjs`
- `tests/vector-store.test.mjs`

### Fixtures And Evals

- `evals/demo-project.json`
- `evals/sample.json`
- `fixtures/demo-project/budget.md`
- `fixtures/demo-project/contacts.md`
- `fixtures/demo-project/contract.md`
- `fixtures/demo-project/risks.md`
- `fixtures/demo-project/schedule.md`

### Docs

- `README.md`
- `docs/DAILY_AGENT.md`
- `docs/PLAN.md`
- `docs/final-verification.md`
- `docs/integrations-plan.md`
- `docs/regression-matrix.md`
- `docs/release-file-inventory.md`
- `docs/release-notes-next.md`
- `docs/ui-acceptance-checklist.md`
- `docs/ui-acceptance-results.md`

## Protected Local Files

Do not commit these live or generated paths:

- `.env`
- `config/settings.json`
- `config/sources.yaml`
- `data/`
- `.tmp/`
- `smoke-output/`
- `benchmark-output/`
- `*.log`
- `*.tmp`
- `*.bak`
- `__pycache__/`
- `*.pyc`
- `LocalAI-analysis-*.zip`
- `*-analysis-sanitized-*.zip`

Do not include one-off local analysis artifacts such as
`LocalAI-analysis-sanitized-2026-06-29-104140.zip` unless a separate release
decision explicitly asks for it; these are ignored by the patterns above.

## Git Safety Checks

### `git status --short`

Result: the worktree is mostly untracked and must be staged deliberately.

```text
?? .env.example
?? .gitignore
?? AGENTS.md
?? README.md
?? apps/
?? codex.md
?? compose.yaml
?? config/
?? docs/
?? evals/
?? fixtures/
?? package-lock.json
?? package.json
?? scripts/
?? tests/
```

### `git ls-files config/settings.json config/sources.yaml .env`

Result: no output. Live config and `.env` are not tracked.

### Protected Ignore Check

Command:

```powershell
git check-ignore -v config/settings.json config/sources.yaml .env data
```

Result:

```text
.gitignore:6:config/settings.json	config/settings.json
.gitignore:7:config/sources.yaml	config/sources.yaml
.gitignore:5:.env	.env
.gitignore:3:data/	data
```

Generated output check:

```text
.gitignore:11:__pycache__/	scripts/__pycache__/reranker-service.cpython-311.pyc
.gitignore:14:*-analysis-sanitized-*.zip	LocalAI-analysis-sanitized-2026-06-29-104140.zip
.gitignore:15:smoke-output/	smoke-output/example.txt
.gitignore:16:benchmark-output/	benchmark-output/example.txt
.gitignore:9:*.tmp	.tmp/example.tmp
```

### Intended Release Ignore Check

Command:

```powershell
git check-ignore -v config/settings.example.json config/sources.example.yaml fixtures/demo-project/contract.md evals/demo-project.json scripts/smoke-local.mjs docs/final-verification.md docs/release-notes-next.md
```

Result: no output. Intended release files are not ignored.

## Suggested Commit Grouping

- Safety/config/docs: `.gitignore`, `.env.example`, config templates, README,
  AGENTS/codex policy docs, release inventory, regression matrix, final
  verification, release notes.
- Tests/fixtures/evals/smoke: demo fixture, eval JSON, eval utilities,
  smoke-local script, smoke-api script, demo eval tests.
- RAG retrieval/storage: search pipeline, BM25/scoring, storage provider,
  SQLite metadata provider, vector-store helpers.
- UI streaming/debug: UI app/modules, SSE helpers, `/api/chat/stream`
  handling, citation helpers.
- Source summary: deterministic summary builder, indexer summary writes,
  JSON/SQLite summary storage round-trip coverage.

## Do Not Commit

No `git add`, `git commit`, or `git push` was run during this inventory.

Before creating the release commit, avoid staging:

- `.env`
- `config/settings.json`
- `config/sources.yaml`
- `data/`
- `LocalAI-analysis-sanitized-2026-06-29-104140.zip`
- generated temp/cache output covered by `.gitignore`

# Release Notes Next

## Summary

Release candidate for a local RAG chat workspace with LM Studio, Qdrant, OCR,
local-first privacy, improved retrieval, exact citation preview, and expanded
smoke/eval/security coverage.

## Added

- `AGENTS.md` project guidance.
- `check`, `test`, `check:ui`, `eval:retrieval`, `eval:demo`, `eval:llm`,
  `smoke:local`, and `smoke:api` package scripts.
- Demo fixtures and strict demo eval cases.
- Clean local smoke gate.
- Runtime API smoke gate.
- Frontend static smoke gate.
- SSE `/api/chat/stream`.
- RAG debug panel.
- Deterministic project/source summary.
- Optional SQLite metadata provider.
- Qdrant provider modes.
- BM25/candidate-first/RRF retrieval flow.
- Exact citation/source preview by stable chunk target.
- API auth middleware.
- Release docs, checklists, regression matrix, and acceptance results.

## Changed

- LLM routing is local-first by default.
- Remote context is disabled by default and requires explicit enablement.
- Config templates are release files; live config remains local-only.
- Include/exclude indexing behavior is covered by tests and docs.
- Citation metadata now carries stable `chunkId`, `fileId`, labels, and source
  target metadata.
- Preview endpoint resolves exact evidence before falling back to legacy file
  preview.
- UI citation clicks send exact target metadata.
- Frontend code is split into app and helper modules.

## Security / Privacy

- `.env` is ignored.
- `config/settings.json` is ignored.
- `config/sources.yaml` is ignored.
- `data/` is ignored.
- Remote context requires explicit enablement before retrieved document
  fragments can be sent to a remote endpoint.
- Bearer auth is supported for `/api/*`.
- Preview path traversal protections are covered by tests and smoke.
- Secrets are masked and must not be logged or committed.
- Local analysis zips are ignored and marked do-not-commit.

## Testing / Verification

Final verification commands:

```powershell
npm run check
npm test
npm run check:ui
npm run eval:retrieval
npm run eval:demo
npm run smoke:local
npm run smoke:api
```

Latest known results:

- `npm test`: PASS, 86/86.
- `npm run check:ui`: PASS, 28 PASS / 0 WARN / 0 FAIL.
- `npm run eval:retrieval`: PASS, 6/6, Recall@3/5/10 = 1.000, MRR = 1.000.
- `npm run eval:demo`: PASS, 6/6, Recall@3/5/10 = 1.000, MRR = 1.000.
- `npm run smoke:local`: PASS.
- `npm run smoke:api`: PASS, 12 PASS / 0 WARN / 0 FAIL.

## Migration Notes

- `config/settings.json` and `config/sources.yaml` are local-only.
- Use `config/settings.example.json` and `config/sources.example.yaml` for a
  clean setup.
- Real tokens belong in env or `.env`, never in committed config.
- SQLite metadata provider is optional.
- JSON metadata provider remains supported.
- Old chunks without new citation metadata should fall back safely.

## Known Limitations

- `eval:llm` is not run by default.
- LM Studio, Qdrant, and OCR are not required by smoke gates; real target
  environments should still test the configured local model, OCR, and Qdrant.
- Manual UI status is WARN because optional checks remain not run or not
  concretely reported: private source re-test, browser console status, remote
  context warning, and optional SQLite UI smoke.
- Auth UI has no dedicated API Bearer token field.
- LM Studio startup/readiness can require waiting before generation works.

## Do Not Commit

- `.env`
- `config/settings.json`
- `config/sources.yaml`
- `data/`
- Local analysis zips.
- Temp, smoke, and benchmark outputs.
- User documents.

# Stage 00 report

Status: PASS

## Baseline
- Коммит `df27b45`, Node v24.14.1, Windows 10.
- До изменений: `npm test` 294/295 (падал тест global audit — писал в живой data dir), `smoke:api` FAIL (temp runtime переадресовывался на `D:\LOCAL_RAG\data`).
- Остальные gates PASS. Подробно — [00-current-state.md](00-current-state.md).

## Changed
- `docs/product-v2/00-current-state.md` -> фактическая карта, ответы на вопросы Stage 00, drift, риски
- `docs/product-v2/architecture-target.md` -> целевая архитектура с привязкой к модулям
- `docs/product-v2/adr/ADR-001-answer-core.md`, `ADR-002-app-state-db.md` -> решения
- `docs/product-v2/stage-ledger.md` -> журнал этапов
- `scripts/smoke-api-local.mjs` -> temp data dir `smoke-data` вместо `data` (не совпадает с legacy-путём)
- `tests/tender-global-audit.test.mjs` -> временный `RAG_DATA_DIR` для теста, сохраняющего audit-run

## Architecture decisions
- ADR-001: answer-core в `apps/rag-api/src/answer-core/`, зависимости передаются явно.
- ADR-002: отдельная `app-state.sqlite` для диалогов/traces.

## Tests / evidence
- `npm run check` -> PASS
- `npm test` -> PASS 295/295
- `npm run check:ui` -> PASS
- `npm run eval:demo` -> PASS (6 cases, R@5 1.000, MRR 1.000)
- `npm run mcp:check` -> PASS
- `npm run mcp:test` -> PASS 20/20
- `npm run smoke:api` -> PASS 15/0/0
- `npm run eval:llm` -> NOT RUN (нужен живой LM Studio и явный opt-in)
- Qdrant/reranker/OCR runtime -> NOT RUN (сервисы не запускались)

## Metrics before/after
- Retrieval demo: R@3/5/10 = 1.000, MRR = 1.000 (не различает правильный пункт/редакцию).

## Security/privacy
- Найдено и исправлено: два пути, по которым тесты/smoke могли писать в живой data dir.
- Зафиксировано (не исправлялось): абсолютные пути в LLM-контексте и API-ответе; нет trace-id; общий bearer.

## Known limitations
- Clean checkout без `config/settings.json` использует `D:\LOCAL_RAG\data` по умолчанию — не переносимо на Linux/CI.
- Документация с числом тестов устарела (не обновлялась на этом этапе).

## Manual checks still required
- `npm run eval:llm` на живом LM Studio владельцем.
- Независимая проверка отчёта (Codex review prompt).

## Ready for next stage?
YES
Reason: все gates воспроизводимы, NOT RUN с причинами, целевая архитектура опирается на код.

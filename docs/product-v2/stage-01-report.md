# Stage 01 report

Status: PASS

## Baseline
- Stage 00: gates PASS, `npm test` 295/295, `eval:demo` 6 кейсов с R@5 = 1.000, который не различает файл и правильный фрагмент.

## Changed
- `fixtures/product-v2/**` -> синтетический корпус: 3 проекта, договор + ДС, смета (формат xlsx-конвертера), скан (формат OCR-конвертера), `sources.json`
- `evals/product-v2/contracts-core.json` -> 17 кейсов, 15 классов, схема `product-v2/1`
- `scripts/product-eval/schema.mjs` -> классы, статусы, нормализация и валидация кейсов, проверка покрытия классов
- `scripts/product-eval/corpus.mjs` -> сборка чанков корпуса через `chunkMarkdown`
- `scripts/product-eval/retrieval.mjs` -> офлайн-повтор retrieval-пути `/api/chat` (scope, query expansion, BM25 + scoring, citationTarget)
- `scripts/product-eval/metrics.mjs` -> метрики с явным `ok | not_available + reason`, проверка «тихо не посчитанных» метрик
- `scripts/run-product-evals.mjs` -> CLI (`--dir`, `--json`), exit 1 при пустом наборе, невалидном кейсе, нехватке классов, непосчитанной обязательной метрике, evidence вне корпуса
- `tests/product-eval.test.mjs` -> 6 тестов (режимы сопоставления, OCR pages, валидация, NOT_AVAILABLE, пустой набор, покрытие закоммиченного набора)
- `package.json` -> `eval:product`; новые файлы в `npm run check`
- `.gitignore`, `evals-private/README.md` -> контракт приватных evals
- `docs/product-v2/01-eval-baseline.md` -> baseline и найденные дефекты

## Architecture decisions
- Фикстуры хранятся в формате вывода конвертеров (markdown): eval проверяет retrieval и метаданные цитат, конвертеры покрыты своими тестами.
- Retrieval-only runner без живых сервисов: детерминированный и запускается в CI.
- Метрика без данных — `NOT_AVAILABLE` с причиной; обязательные retrieval-метрики обязаны считаться на закоммиченном наборе.

## Tests / evidence
- `npm run check` -> PASS
- `npm test` -> PASS 301/301
- `npm run check:ui` -> PASS
- `npm run eval:demo` -> PASS (не изменён)
- `npm run eval:product` -> PASS (exit 0, метрики в baseline)
- `npm run mcp:test` -> PASS
- `npm run smoke:api` -> PASS
- `eval:llm` -> NOT RUN (живой LM Studio)

## Metrics before/after
- Before: только demo R@3/5/10 = 1.000, MRR = 1.000.
- After: exact R@5 0.870 и file R@5 1.000; citation target 0.400; current version 0.000; clarification recall 0.000. Подробно — `01-eval-baseline.md`.

## Security/privacy
- Фикстуры полностью вымышленные, реальных документов нет.
- `evals-private/` в `.gitignore`; JSON-отчёт пишется только по явному `--json`.

## Known limitations
- Нет embeddings/reranker в runner.
- Answer/verifier-метрики — NOT_AVAILABLE до Stage 07.
- Приватный набор обязан покрывать все 15 классов.

## Manual checks still required
- Независимая проверка отчёта.

## Ready for next stage?
YES
Reason: схема и runner существуют, baseline сохранён, набор различает «нашли файл» и «нашли правильный evidence/редакцию».

---

## Revision 1 — после независимой проверки (verdict PARTIAL)

Status: PASS (ожидает повторной проверки)

### Findings
1. **[P2] Исчезнувшие метрики проходили проверку.**
   - Причина: `silentMetricFailures` перебирал только ключи, которые есть в отчёте.
   - Исправление: полный контракт `EXPECTED_METRICS` в `scripts/product-eval/metrics.mjs`; проверяется каждая ожидаемая метрика и любая лишняя из отчёта.
   - Регрессионный тест: удаление `answer.numericFidelity` и всей группы `verifier` → метрики попадают в список сбоев. До исправления тест падал.
2. **[P2] Документированная команда ломалась при повторном запуске.**
   - Причина: отчёт `--json` сохранялся в каталог кейсов, а загрузчик читает все `*.json`.
   - Исправление: `scripts/run-product-evals.mjs` отклоняет `--json` внутри каталога кейсов (exit 1 с объяснением) и создаёт каталог отчёта; README использует `.tmp/product-eval-private-report.json`.
   - Регрессионный тест: отчёт внутри каталога → exit 1; два запуска подряд с отчётом вне каталога → без проблем. До исправления тест падал.

### Changed
- `scripts/product-eval/metrics.mjs`, `scripts/run-product-evals.mjs`, `evals-private/README.md`, `tests/product-eval.test.mjs`

### Tests / evidence
- `npm run check` -> PASS
- `npm test` -> PASS 303/303
- `npm run check:ui` -> PASS
- `npm run eval:demo` -> PASS
- `npm run eval:product` -> PASS, baseline не изменился (R@5 0.870, citation 0.400, current version 0.000)
- `npm run mcp:check`, `npm run mcp:test` -> PASS
- `npm run smoke:api` -> PASS

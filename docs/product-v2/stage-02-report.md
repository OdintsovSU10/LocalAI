# Stage 02 report

Status: PARTIAL — см. Revision 1 в конце отчёта; ожидает повторной проверки

## Baseline
- Коммит `70552d6`: логика ответа продублирована в `/api/chat` и `/api/chat/stream` внутри `server.js` (4339 строк). Состояние LLM (`llmRequests`, `lastLlmGenerations`, `lastLlmActivity`) — модульные переменные `server.js`. Unit-тестов на чат нет.

## Changed
- `apps/rag-api/src/answer-core/answer-question.js` -> `answerQuestion(input, deps)`: единый поток scope → retrieval → LLM → fallback → metadata; события `status` (phase `retrieval`/`llm`) и `token`
- `apps/rag-api/src/answer-core/chat-llm.js` -> `runChatLlm` (перебор кандидатов, ужатие контекста), `chatSearchLimit`, профили контекста, `generateChatTitle`
- `apps/rag-api/src/answer-core/chat-prompt.js` -> `buildRagContext`, `buildChatMessages`, title-промпт
- `apps/rag-api/src/answer-core/fallback-answers.js` -> `withFallbackSources`, `llmErrorAnswer`, тексты канонических ответов
- `apps/rag-api/src/answer-core/rag-metadata.js` -> `ragDebugMetadata`, `emptyRouteMetadata`
- `apps/rag-api/src/answer-core/llm-usage-tracker.js` -> `createLlmUsageTracker()` вместо модульных Map в `server.js`
- `apps/rag-api/src/server.js` -> чат-обработчики стали адаптерами (JSON: `res.json(payload)`, SSE: событие → `writeSseEvent`); `/api/llm/usage` и `/api/llm/diagnostics` читают трекер; 4339 → 3562 строки
- `tests/answer-core.test.mjs` -> 8 unit-тестов на фейковых зависимостях (без сети и сервера)
- `tests/chat-http-contract.contract.mjs`, `tests/helpers/chat-runtime.mjs` -> контракт «до/после»: поднимает API из git-ревизии `70552d6` и из рабочего дерева, прогоняет 11 сценариев × JSON/SSE, title, LLM usage/diagnostics, режим «LLM выключен» с фейковой LLM и сравнивает нормализованные ответы
- `package.json` -> `test:chat-contract`; новые модули в `npm run check`

## Architecture decisions
- ADR-001 реализован: зависимости answer-core передаются явно; всё, что зависит от in-memory состояния сервера (`jobs`, `publicMatchedSource`, трекер LLM), приходит через `deps`.
- `function publicMatchedSource` осталась в `server.js` (маркер `check:ui`).
- SSE-протокол и формат JSON-ответа не менялись; контракт сравнивает их с кодом до рефакторинга, а не с вручную записанным эталоном.
- Контрактный тест вынесен из `npm test` (поднимает 4 процесса API и индексирует корпус) — отдельная команда `npm run test:chat-contract`.

## Tests / evidence
Машина разработки: только `node --check` новых и изменённых файлов -> PASS.

На машине владельца (обязательно, в чистом checkout без незакоммиченных изменений в `apps/`):
- `npm run check` -> NOT RUN
- `npm test` (включая `tests/answer-core.test.mjs`) -> NOT RUN
- `npm run test:chat-contract` -> NOT RUN
- `npm run check:ui` -> NOT RUN
- `npm run eval:demo`, `npm run eval:product` -> NOT RUN
- `npm run mcp:test`, `npm run smoke:api` -> NOT RUN

## Metrics before/after
- `eval:product` не должен измениться (retrieval не затрагивался): R@5 0.870, file R@5 1.000, citation 0.400, current version 0.000.

## Security/privacy
- Local-first routing не менялся: кандидаты по-прежнему из `chatLlmCandidates`.
- Секреты в answer-core не передаются; settings читаются через `deps.readSettings`.
- Контрактный тест: временные каталоги в `.tmp/chat-contract`, `RAG_DATA_DIR` вне legacy-пути, фейковая LLM на 127.0.0.1, `.env` отключён.

## Known limitations
- Абсолютные пути в LLM-контексте и `matchedSource.path` сохранены как были (изменение поведения — вне Stage 02).
- Контракт зависит от наличия ревизии `70552d6` в локальном git (переопределяется `CHAT_CONTRACT_BASE_REV`).

## Manual checks still required
- Браузер: вопрос, стриминг, клик по цитате, отмена запроса, панель использования LLM.

## Ready for next stage?
NO
Reason: acceptance подтверждается прогоном на машине владельца.

---

## Revision 1 — после независимой проверки (verdict FAIL)

Проверка подтвердила: единый `answerQuestion`, отсутствие дублирования, local-first routing, UI-маркеры, gates `check`/`test` 311/311/`check:ui`/`eval:*`/`mcp:*`/`smoke:api` PASS, браузерный smoke PASS. Не прошёл `npm run test:chat-contract` — дефекты тестового стенда, не runtime.

### Findings
1. **[P2] Fake LLM не поддерживал lifecycle модели LM Studio.**
   - Причина: локальные LLM-настройки по умолчанию имеют `runtime: "lmstudio"`, поэтому сервер запрашивает native `/api/v1|v0/models` и загружает модель, если она не помечена загруженной. Fake отдавал модель без `state: "loaded"`, а на `/api/v1/models/load` отвечал 404 → ответ «Could not load local LM Studio model» уже в baseline; проверка веток (`assertScenarioBranches`) правильно остановила сравнение.
   - Исправление: `tests/helpers/chat-runtime.mjs` — модель отдаётся как загруженная (`state: "loaded"`, `loaded_context_length: 32768`), `POST …/models/load|unload` отвечает 200.
2. **[P2] Сравнение зависело от длины временного пути.**
   - Причина: абсолютные пути входят в LLM-контекст, `promptChars` (metadata, SSE `meta`/`done`, `lastActivity`) различался у каталогов `baseline` и `current`.
   - Исправление: `tests/chat-http-contract.contract.mjs` — метки runtime одинаковой длины (`base`/`head`); `promptChars` остаётся в сравнении как значимое поле.

### Changed
- `tests/helpers/chat-runtime.mjs`, `tests/chat-http-contract.contract.mjs`
- Runtime-код (`apps/`) не менялся.

### Tests / evidence
- Машина разработки: `node --check` изменённых файлов -> PASS.
- `npm run test:chat-contract` и остальные gates -> NOT RUN здесь, прогон у владельца.

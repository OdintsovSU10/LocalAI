# ADR-001 — answer-core с внедрением зависимостей

Статус: принято (Stage 00). Реализация: Stage 02.

## Контекст

Логика ответа (scope → retrieval → LLM → fallback → metadata) продублирована в обработчиках `/api/chat` и `/api/chat/stream` в `server.js` и опирается на модульное состояние (`llmRequests`, `lastLlmGenerations`, in-memory `jobs`). Telegram и verifier нельзя подключить без копирования.

## Решение

- Каталог `apps/rag-api/src/answer-core/`.
- Точка входа `answerQuestion({question, requestedSourceId, contextSourceId, conversationContext, signal, stream, onEvent}, deps)`, возвращает тот же объект, что сейчас отдаёт `/api/chat`.
- Зависимости передаются явно (`readSources`, `readSettings`, `readManifest`, `readJobs`, `searchChunksWithMetadata`, `chatCompletion`, `chatCompletionStream`, `usageTracker`, `indexStatus`), по образцу `dify-adapter.js` `runDifyRetrieval`.
- HTTP-адаптеры: JSON отдаёт результат, SSE маппит события в существующие `status/token/sources/meta/done/error`.
- Перед переносом — characterization-тесты на текущие ответы обоих эндпоинтов.

## Последствия

- Логика тестируется без HTTP и без LM Studio.
- Response shape и SSE-протокол для UI не меняются.
- `server.js` теряет ~500 строк.

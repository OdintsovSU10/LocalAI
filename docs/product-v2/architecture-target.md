# Product V2 — целевая архитектура (привязка к коду)

Основано на `00-current-state.md`. Стек сохраняется: Node ESM JavaScript, Express, `node:test`, без сборки.

## Pipeline

```text
Web (apps/rag-ui) / Telegram (apps/telegram-bot, Stage 08) / API
        │  HTTP adapters: server.js routes (тонкие)
        ▼
Conversation Service            apps/rag-api/src/conversation/     (Stage 03)
        ▼
Query Planner                   apps/rag-api/src/answer-core/planner  (Stage 05)
  rules: chat-scope.js, chat-intent.js, source-match.js — остаются fallback
        ▼
Retrieval Orchestrator          search.js (BM25+vector+RRF+rerank) + фильтры плана (Stage 06)
        ▼
Evidence Packet                 EvidenceSpan ids, page/sheet/row, bounded text (Stage 04)
        ▼
Answer Draft (claims)           answer-core (Stage 07)
        ▼
Hard checks + Verifier          answer-core/verify (Stage 07)
        ▼
Final Renderer                  статус: verified | verified_with_conflict |
                                clarification_required | insufficient_evidence | system_error
```

## Слои и модули

| Слой | Модуль | Stage |
|---|---|---|
| Answer-core | `apps/rag-api/src/answer-core/answer-question.js` — `answerQuestion(input, deps)`; события `planning/retrieval/llm/verifying/finalizing/error` + `token` | 02 |
| LLM usage state | `answer-core/llm-usage-tracker.js` (вынесено из модульных Map в server.js) | 02 |
| App-state DB | `apps/rag-api/src/conversation/app-state-db.js` (`node:sqlite`, отдельный файл `state/app-state.sqlite`) | 03 |
| Document/Evidence/Fact | `apps/rag-api/src/evidence/` — DocumentRecord, EvidenceSpan, StructuredFact | 04 |
| Evals | `evals/product-v2/`, `fixtures/product-v2/`, `scripts/run-product-evals.mjs` | 01 |
| Telegram | `apps/telegram-bot/` — только adapter к local API | 08 |
| Traces | trace-id на turn, safe metadata | 09 |

## Инварианты

- Web и Telegram вызывают один `answerQuestion`; `/api/chat` и `/api/chat/stream` — адаптеры без собственной логики.
- Local-first routing (`llm-routing.js`) не обходится ни одним новым путём.
- Абсолютные пути не уходят в Telegram и не пишутся в traces; для LLM-контекста — отдельное решение в Stage 07/09.
- Тесты и evals — только temp data dir и synthetic fixtures.
- BM25, Qdrant, reranker, preview, streaming, Dify adapter, MCP — не удаляются.

## Решения

- [ADR-001 — answer-core с внедрением зависимостей](adr/ADR-001-answer-core.md)
- [ADR-002 — отдельная app-state SQLite](adr/ADR-002-app-state-db.md)

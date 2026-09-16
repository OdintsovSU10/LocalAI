# Product V2 — Stage 00: фактическое состояние (baseline)

Дата фиксации: 2026-09-16. Коммит: `df27b45`. Node `v24.14.1`, Windows 10.
Источник истины — код и фактические прогоны, а не README/старые отчёты.

## 1. Baseline gates

| Команда | Результат | Примечание |
|---|---|---|
| `npm run check` | PASS | `node --check` по списку файлов |
| `npm test` | PASS 295/295 (после фикса изоляции, см. §7) | до фикса: 294/295 |
| `npm run check:ui` | PASS | маркеры AGENTS.md на месте |
| `npm run eval:demo` | PASS | 6 кейсов, Recall@3/5/10 = 1.000, MRR = 1.000 |
| `npm run mcp:check` | PASS | |
| `npm run mcp:test` | PASS 20/20 | |
| `npm run smoke:api` | PASS 15/0/0 (после фикса, см. §7) | до фикса: FAIL — сервер не стартовал |
| `npm run eval:llm` | NOT RUN | требует живой LM Studio и `RAG_EVAL_ALLOW_LLM=true` |
| Qdrant / reranker / OCR | NOT RUN | внешние сервисы не запускались; smoke их явно выключает |

## 2. Runtime flow `/api/chat` и `/api/chat/stream`

Оба обработчика в `apps/rag-api/src/server.js` (~3885 и ~4096) содержат **одну и ту же логику, скопированную дважды**:

1. `readSources()` + `readSettings()`.
2. `resolveChatSourceScope({question, requestedSourceId, contextSourceId, sources})` (`chat-scope.js`).
3. `hasBroadAnswerIntent`, `expandedChatRetrievalQuery` (`chat-intent.js`).
4. `requestedSourceMissing` → канонический ответ «Не понял, к какому проекту…» + `projectCandidates`.
5. `publicMatchedSource`, `chatSearchLimit` (12/20 проект, 24/36 все проекты), `indexSourceIdsForSources` (`index-status.js`).
6. `searchChunksWithMetadata` (`search.js`: BM25 + vectors (Qdrant | vectors.json) → RRF → hybrid score → optional reranker).
7. Нет результатов → `allSourcesNoResultsAnswer` / «нет готового индекса» (`indexedSnapshotForSource`, `latestJobForSource` — зависит от in-memory `jobs`) / «ничего не найдено».
8. `llm.enabled === false` → ответ без LLM с фрагментами.
9. `chatLlmCandidates(settings)` (`llm-routing.js`) — privacy policy local/remote/auto.
10. `runChatLlm` (server.js ~1557): перебор кандидатов × context profiles (`compact/tight`, `broad*`, `all-sources-*`), `buildRagContext` → `buildChatMessages` → `chatCompletion`/`chatCompletionStream`, retry на `isContextSizeError`. Учёт — модульные `llmRequests`, `lastLlmGenerations`, `lastLlmActivity`.
11. Ошибка LLM → `llmErrorAnswer` (extractive fallback); успех → `withFallbackSources`.
12. `ragDebugMetadata` → `{answer, model, provider, providerLabel, selectedBy, fallbackReason, matchedSource, sources, metadata}`.

SSE-события: `status` (`retrieval_started`, `retrieval_done`, `llm_started`), `token`, `sources`, `meta`, `done`, `error` (`sse.js`, `streamChatPayload`). Отмена — `res.on("close")` → `AbortController`.

## 3. Ответы на обязательные вопросы Stage 00

**Где хранится chat history.** Только в браузере: `localStorage` ключи `local-rag-chat-history-v1` (≤60 сессий), `local-rag-active-chat-v1` (`apps/rag-ui/app.js`). Сервер историю не хранит и не получает.

**Какой контекст получает LLM.** Один system prompt (правила цитирования, типов значений, редакций) + user-сообщение `/no_think` с вопросом и нумерованными блоками `[n] Источник / Проект / Файл / Путь / Фрагмент`. Истории диалога нет. В контекст уходит **абсолютный путь файла** (`Путь: item.path`), в т.ч. при remote-маршруте.

**Где определяется project scope.** `chat-scope.js` `resolveChatSourceScope`: явный `sourceId` → auto-match (`source-match.js` `matchSourceForQuestion`, только contract-источники) → `contextSourceId` (проект предыдущего вопроса из UI) → все проекты при `hasAllSourcesIntent`. Связанные тендеры добавляются через `source-scope.js`.

**Как формируются citation target.** `[n]` в ответе = `sources[n-1]` по порядку выдачи поиска; ответ модели не парсится и не сверяется. `citations.js` `buildCitationTarget` даёт `sourceId/chunkId/fileId/pageStart-End/sheetName/rowStart-End/sectionTitle/snippet`; превью — `GET /api/files/preview` (`preview-access.js`).

**Storage providers.** `store.js`: `sources.yaml`, `settings.json`; manifest/chunks/source-summaries — `json` (по умолчанию) или `sqlite` (`sqlite-metadata-store.js`, `node:sqlite`); vectors/jobs/agent-runs/audit-runs — всегда JSON; вектора — Qdrant или `vectors.json`. Данные — `dataDir()` (`paths.js`): `RAG_DATA_DIR` → `settings.dataDir` → `D:\LOCAL_RAG\data`.

**Что делает MCP и чего не умеет.** `apps/mcp-server` (stdio): read-only tools `listSources`, `getIndexedFiles`, `search`, `previewCitation`, `getAgentRuns`, `getIntegrationsStatus`, `getLlmDiagnostics` (только local). Только GET к локальному API, redaction/truncation. Не умеет: задавать вопрос через answer pipeline, смотреть traces/evals/conversations — их нет.

**Что уже product-grade и должно остаться.** Гибридный retrieval (BM25 + vectors + RRF + reranker, fallback на vectors.json), citation target + preview с защитой от traversal, local-first privacy routing, SSE-стриминг с отменой, auto project match, SQLite metadata provider, Dify adapter, read-only MCP, `smoke:api` на temp runtime.

**Что мешает Telegram.** (1) логика ответа внутри Express-обработчиков, дважды; (2) нет серверных диалогов и пользователя/канала; (3) ответ содержит абсолютные пути (`matchedSource.path`, `sources[].path`, `metadata.matchedSource`); (4) нет trace-id, rate limit, per-user auth — один общий bearer (`security.js`); (5) clarification — просто текст, не структурированное состояние с продолжением.

**Что мешает multi-turn.** API принимает только `question/sourceId/contextSourceId`; история не передаётся; follow-up работает лишь через «унаследовать проект». Нет bounded conversation context и состояния незавершённого уточнения.

**Есть ли runtime answer verification.** Нет. Есть только prompt-инструкции и `withFallbackSources`, который дописывает «Источники: [1], [2], [3]», если модель их не указала — это может создать видимость подтверждения. `.cursor/agents/verifier.md` — инструмент разработки.

**Какие данные нужны для version-aware договоров.** Тип документа (договор / ДС / приложение / спецификация), номер и дата документа, дата вступления в силу, ссылка на базовый договор, номер/название изменяемого пункта, признак «в редакции ДС №…». Сейчас у chunk есть только `documentType` (формат файла), page/sheet/row/section и tender-флаги; связей между документами нет.

**Слишком синтетичные тесты.** `tests/smoke.test.mjs` (заглушка); `evals/demo-project.json` — 6 кейсов по 5 markdown-файлам, одна тема на файл, Recall=1.0 не различает «нашёл файл» и «нашёл правильный пункт/редакцию»; нет кейсов no-answer, wrong-project, конфликт, ДС, xlsx-строк, OCR-страниц, follow-up. Нет тестов на `runChatLlm`/`buildChatMessages`/чат-обработчики (приватны в server.js).

**Критичные ограничения для строительных договоров.**
- Устаревшее условие базового договора может быть процитировано при наличии ДС — нет графа редакций.
- Числовая путаница (3% vs 30 дней vs 3 года) контролируется только промптом, без проверки.
- `[n]` не проверяется: номер может не соответствовать утверждению.
- Wrong-project: при авто-выборе нет проверки, что evidence принадлежит выбранному проекту кроме фильтра поиска.
- Нет честного `insufficient_evidence` статуса — только текстовые формулировки.

## 4. Drift документации

- `docs/final-verification.md`, `docs/regression-matrix.md`: «npm test 86/86» — фактически 295 тестов.
- `docs/claude-design-redesign-brief.md`: «259 tests» — устарело.
- `AGENTS.md`: «Project summary, `/api/chat`, `/api/chat/stream` and `eval:llm` share one privacy policy» — LLM-генерации project summary в коде нет: `buildSourceSummary` принимает `llmSummary`, но ни один вызывающий код его не передаёт.
- `.claude/agents/tender-price-audit.md`: путь схемы и «adapter TODO» устарели (вне scope V2, только фиксация).

## 5. Portability

- `paths.js`: дефолт `D:\LOCAL_RAG\data` захардкожен; на Linux `path.resolve("D:\\LOCAL_RAG\\data")` даст относительный путь внутри cwd.
- `isLegacyDefaultDataDir` переадресует `<projectRoot>/data` на `D:\LOCAL_RAG\data` — источник бага §7.
- Clean checkout: `config/settings.json` в `.gitignore` → `dataDir()` = `D:\LOCAL_RAG\data`; любой тест, пишущий в store без `RAG_DATA_DIR`, пойдёт в живой каталог или упадёт, если диска нет.

## 6. Privacy/security наблюдения

- Абсолютные пути: в LLM-контексте (включая remote), в `matchedSource.path`, `sources[].path` API-ответа.
- Логи — `console.*` без trace-id; `console.error(error)` в error middleware.
- Auth: общий bearer опционален (`RAG_AUTH_TOKEN`/`RAG_REQUIRE_AUTH`), по умолчанию bind `127.0.0.1` и проверка Origin.

## 7. Нарушения изоляции тестов (исправлены в рамках Stage 00)

1. **`scripts/smoke-api-local.mjs`** задавал `RAG_DATA_DIR=<tempProjectRoot>/data`. Сервер из временной копии считает это legacy-путём и переключается на `D:\LOCAL_RAG\data`: на машине без диска D: smoke падал, на машине с D: smoke **писал бы в живые данные**. Фикс: `smoke-data`.
2. **`tests/tender-global-audit.test.mjs`** («startGlobalTenderAudit runs sync dry-run») сохранял audit-run в `dataDir()/state/audit-runs.json` живого каталога. Фикс: временный `RAG_DATA_DIR` на время теста.

Runtime-поведение не менялось.

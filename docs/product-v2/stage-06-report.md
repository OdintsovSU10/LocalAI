# Stage 06 report

Status: IMPLEMENTED — ждёт независимой проверки на машине владельца

## Baseline
- Stage 05 PASS (`6504511`). Чат отдавал в LLM чанки поиска (BM25 + векторы + RRF + reranker) как есть: 1800 символов на чанк, без точного фрагмента, без учёта редакций.
- `eval:product` (legacy): Recall@5 0.870, Recall@10 0.870, MRR 0.661, citation target accuracy 0.400, current version accuracy 0.000.

## Changed
- `apps/rag-api/src/answer-core/evidence-packet.js` (новый) -> `buildEvidencePacket`: пакет доказательств поверх ранжированных чанков
  1. факты Stage 04 для сущностей плана (обзор — фиксированный набор условий);
  2. точные спаны внутри чанков (до 3 на чанк, со счётом ≥ 0.6 от лучшего);
  3. учёт редакций;
  4. dedup по спану и тексту;
  5. чередование источников для aggregate/compare;
  6. ограничение размера;
  7. расширение коротких пунктов следующим абзацем того же раздела.

  Диагностика: `packetVersion`, `versionPolicy`, кандидаты, понижённые устаревшие, fallback-чанки, причина каждого элемента.
- `apps/rag-api/src/evidence/memory-evidence-provider.js` (новый) -> тот же интерфейс, что у `evidence.sqlite`, в памяти (eval и тесты).
- `apps/rag-api/src/evidence/evidence-store.js` -> интерфейс провайдера: `spansForChunks`, `spansByIds`, `neighborSpan`, `factsForSources` (фильтры источник / тип / статус), `documentsByIds`.
- `apps/rag-api/src/answer-core/answer-question.js` -> пакет применяется после поиска. Откат на прежние чанки, если:
  - флаг выключен;
  - нет провайдера;
  - планировщик упал;
  - у чанков нет спанов;
  - `evidence.sqlite` недоступна.

  Диагностика пишется в `metadata.evidencePacket`.
- `apps/rag-api/src/store.js` -> `search.retrievalV2` (по умолчанию `true`). `RAG_RETRIEVAL_V2` переопределяет его только при чтении, в `settings.json` не сохраняется.
- `apps/rag-api/src/server.js` -> `getEvidenceProvider: evidenceStore` в зависимостях чата.
- Скрипты eval:
  - `scripts/product-eval/retrieval.mjs`, `scripts/product-eval/corpus.mjs` -> режимы `v2` и `legacy`; evidence корпуса строится тем же `buildSourceEvidence`;
  - `scripts/run-product-evals.mjs` -> `--retrieval legacy|v2` (по умолчанию `v2`).
- Тесты:
  - `tests/evidence-packet.test.mjs` (новый);
  - дополнения в `tests/answer-core.test.mjs`, `tests/product-eval.test.mjs`, `tests/evidence-api.contract.mjs`;
  - `tests/helpers/chat-runtime.mjs`: `startApi({ retrievalV2 })`, по умолчанию `false`.
- `package.json` -> новые модули в `npm run check`.

## Architecture decisions
- **Генератор кандидатов не заменялся.** BM25 + векторы + RRF + reranker по-прежнему дают кандидатов. Пакет — отдельный слой над ними, поэтому поиск, `/api/search` и MCP не меняются.
- **Элемент пакета — спан evidence, а не чанк:**
  - текст элемента и `citationEvidence` — это ровно спан;
  - `chunkId` остаётся, чтобы превью открывало тот же фрагмент (`focusText` = спан);
  - `citationTarget` несёт лист и строку, страницу или раздел спана.
- **Редакции:**
  - policy `current`: действующее значение первым, сразу за ним заменённое, с причиной `fact:<тип>:superseded`, чтобы ответ мог назвать изменение, а не молча потерять старый пункт;
  - policy `historical`: заменённое значение первым;
  - policy `all`: хронологически;
  - спаны чанков, которые доказывают только заменённый факт, уходят в конец пакета с пометкой `:superseded`.
- **Откат детерминированный.** Если спанов нет ни у одного элемента, в LLM уходят прежние чанки. Чанки без спанов (evidence ещё не построена) остаются в пакете в исходном виде.
- **Флаг и контракт.** С `retrievalV2: false` ответ API совпадает с тем, что было до Stage 06, включая `metadata` без `evidencePacket`. На этом держится сравнение `test:chat-contract` с ревизией до Stage 06. С включённым флагом `metadata` получает поле `evidencePacket`.

## Acceptance (Prompt Pack Stage 06) -> доказательство
- Рост на version / conflict / citation кейсах без регрессии recall -> метрики ниже и тест `v2 ≥ legacy` в `tests/product-eval.test.mjs`.
- Wrong project не попадает в top -> `wrongProjectLeakRateAt5` = 0.000. Пакет строится только внутри scope плана, факты берутся по `sourceIds` scope.
- Точная цитата (sheet/row, page, section) -> `citationTargetAccuracy` 1.000. Тесты «строка сметы» и «превью спана» (`targetMatched`) в evidence-контракте.
- Current vs superseded -> тесты policy `current` и `historical`, понижение устаревшего спана; HTTP: 10% (ДС №1) первым, 20% вторым.
- Diversity для aggregate -> тест чередования: первые 3 элемента из 3 проектов.
- Bounded и без дублей -> тест лимита и уникальных `evidenceId`, `MAX_ITEM_CHARS`.
- Fallback при отсутствии evidence -> тесты «нет спанов», «провайдер упал», «флаг выключен».

## Tests / evidence
Машина разработки:
- `node --check` -> PASS;
- `node scripts/run-product-evals.mjs` и `--retrieval legacy` -> метрики ниже;
- чистые вызовы `buildEvidencePacket` и `answerQuestion` на сценариях новых тестов совпали с ожиданиями.

`npm test` и контракты здесь не запускались.

На машине владельца (NOT RUN здесь):
- `npm run check`, `npm test`, `npm run check:ui`, `npm run eval:demo`, `npm run eval:product`, `npm run mcp:test`, `npm run smoke:api`;
- `npm run test:chat-contract`, `npm run test:conversation-contract`, `npm run test:evidence-contract`.

## Metrics before/after (`npm run eval:product`, офлайн BM25 без векторов и reranker)
| Метрика | До (legacy) | После (v2) |
|---|---|---|
| Recall@5 (exact) | 0.870 (20/23) | 1.000 (23/23) |
| Recall@10 (exact) | 0.870 (20/23) | 1.000 (23/23) |
| File Recall@5 | 1.000 | 1.000 |
| MRR | 0.661 | 0.806 |
| Citation target accuracy | 0.400 (2/5) | 1.000 (5/5) |
| Current version accuracy | 0.000 (0/1) | 1.000 (1/1) |
| Project selection / wrong-project leak | 1.000 / 0.000 | 1.000 / 0.000 |
| Clarification P / R | 1.000 / 1.000 | 1.000 / 1.000 |

Метрики ответа и verifier — NOT_AVAILABLE до Stage 07.

## Security/privacy
- В пакет попадает только redacted-текст спанов из `evidence.sqlite` (правила ADR-003). Нередактированный текст чанка уходит в LLM только в fallback — как и до Stage 06.
- В `metadata.evidencePacket` есть только идентификаторы (`evidenceId`, `chunkId`), причины и счётчики. Текста документов там нет. Ошибка провайдера обрезается до 200 символов.
- Local-first routing и UI-маркеры не менялись.

## Known limitations
- **Контекст LLM стал уже.** В LLM уходят спаны (абзац или строка), а не чанки по 1800 символов; соседний абзац добавляется только для 3 верхних коротких пунктов. Качество ответа до Stage 07 не измеряется, это проверяется вручную (см. промпт проверки).
- **Спан без `chunkId`.** Превью такого спана откроет файл, а не фрагмент.
- **Шумные факты для обзора.** Для «Какие условия расторжения, если Заказчик…» планировщик видит сущность `party_customer`, и в пакете первым идёт факт «Заказчик: …».
- **Порядок в eval ≠ порядок в рабочем поиске.** Офлайн-eval идёт по BM25 без векторов и reranker; в рабочем поиске порядок чанков может отличаться.

## Ready for next stage?
NO
Reason: acceptance подтверждается прогоном на машине владельца.

---

## Revision 1 — после независимой проверки (verdict FAIL)

Проверка подтвердила: все gates PASS (`npm test` 391/391, контракты chat/conversation/evidence PASS), метрики совпадают с таблицей, JSON и SSE согласованы, fallback и изоляция проектов работают. Найдено пять дефектов и один риск производительности.

### Findings
1. **«До допсоглашения» считалось текущей редакцией.**
   - Причина: планировщик знал «доп. соглашение» только раздельно.
   - Исправление: «допсоглашение», «доп. соглашение», «доп соглашение» и «до заключения ДС» распознаются в правилах редакции (historical/all) и домена договора.
2. **Одинаковые пункты разных проектов схлопывались.**
   - Причина: дедупликация по тексту шла по всему пакету.
   - Исправление: по тексту дедуплицируются только элементы одного проекта; одинаковые условия разных проектов остаются отдельными доказательствами.
3. **Текст исключения провайдера попадал в `metadata.evidencePacket.error`.**
   - Исправление: поле убрано; ответ сообщает только `reason: "error"`.
4. **Round-trip GET → PUT `/api/settings` сохранял env-значение `RAG_RETRIEVAL_V2`.**
   - Исправление: пока переменная задана, `writeSettings` не принимает `search.retrievalV2`; хранимое значение не меняется.
5. **Мутация «не исключать fact-спаны из выбора спанов чанка» не ловилась.**
   - Исправление: добавлен синтетический тест, в котором fact-спан поднимает порог и отсекает соседний пункт.

Риск производительности: `factsForSources` делал отдельный запрос evidence на каждый факт (N+1). Теперь при любом числе фактов выполняются два запроса: факты, затем все их evidence-ссылки одним JOIN с тем же фильтром.

### Регрессионные тесты
- `tests/query-planner.test.mjs`: формы допсоглашения → historical/all/current, домен договора.
- `tests/evidence-packet.test.mjs`:
  - fact-спан не поднимает порог для соседних спанов чанка;
  - одинаковые пункты трёх проектов → три элемента.
- `tests/answer-core.test.mjs`: при ошибке провайдера в `evidencePacket` нет поля `error`.
- `tests/evidence-store.test.mjs`: SQLite-провайдер совпадает с in-memory по фактам (фильтры источник/тип/статус, evidence ids), спанам, соседям и документам.
- `tests/evidence-api.contract.mjs`:
  - GET → PUT настроек при заданном `RAG_RETRIEVAL_V2` не пишет флаг в `settings.json`;
  - HTTP «Какой аванс был до допсоглашения?» → `versionPolicy: historical`, первым 20%.

### Changed
- `apps/rag-api/src/answer-core/query-planner.js`, `evidence-packet.js`, `answer-question.js`
- `apps/rag-api/src/evidence/evidence-store.js`
- `apps/rag-api/src/store.js`
- тесты выше, этот отчёт

### Tests / evidence
Машина разработки:
- `npm run check` -> PASS;
- `eval:product` без изменений (R@5 1.000, MRR 0.806, citation 1.000, current version 1.000);
- чистые пробы новых сценариев совпали с ожиданиями;
- SQLite- и in-memory-провайдер дали одинаковые факты по 5 фильтрам.

`npm test` и контракты здесь не запускались.

NOT RUN (переносится): качество ответов с реальной LLM (LM Studio недоступен на машине проверки).

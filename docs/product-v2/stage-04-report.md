# Stage 04 report

Status: PARTIAL — код и тесты написаны, прогон выполняется на машине владельца

## Baseline
- Stage 03 PASS (`4b73838`). Цитаты указывают на чанки индекса; `01-eval-baseline.md`: citation target accuracy 0.400 (раздел = последний заголовок чанка, несколько листов в одном чанке), current version accuracy 0.000 (базовый договор выше ДС). Документы и факты не моделируются.

## Changed
- `apps/rag-api/src/sqlite-migrations.js` -> общий запуск нумерованных миграций; `conversation/app-state-db.js` использует его (поведение Stage 03 без изменений)
- `apps/rag-api/src/evidence/migrations/001_evidence.sql` -> `documents`, `evidence_spans`, `facts`, `fact_evidence`, `document_relations`, `fact_conflicts`, `source_builds`
- `apps/rag-api/src/evidence/document-classifier.js` -> вид документа, номер, дата, ссылка на родительский договор; удаление front matter
- `apps/rag-api/src/evidence/evidence-spans.js` -> фрагменты по абзацам и строкам таблиц с собственными раздел/страница/лист/строка и привязкой к чанку
- `apps/rag-api/src/evidence/fact-extractor.js` -> правила `rules/1` для 13 типов фактов; каждый факт со ссылкой на фрагмент
- `apps/rag-api/src/evidence/version-graph.js` -> связи ДС/приложений с договором, замена пунктов, конфликты
- `apps/rag-api/src/evidence/build-source-evidence.js` -> сборка источника (markdown-кэш, при отсутствии — текст чанков)
- `apps/rag-api/src/evidence/evidence-store.js` -> атомарная замена сборки источника с проверкой ссылок; документы, связи, конфликты, факты, trace факта с параметрами превью
- `apps/rag-api/src/evidence/source-evidence-runtime.js` -> чтение manifest/чанков/кэша и пересборка источника
- `apps/rag-api/src/routes/evidence.js` -> `GET /api/evidence/sources/:sourceId`, `GET /api/evidence/facts`, `GET /api/evidence/facts/:factId/trace`, `POST /api/evidence/rebuild`
- `apps/rag-api/src/server.js` -> ленивое открытие `evidence.sqlite`, маршруты, фоновая пересборка после успешной индексации через API
- `apps/rag-api/src/paths.js` -> `evidenceSqlitePath()`
- `scripts/build-evidence.mjs` -> `npm run evidence:build -- --source-id=<id> | --all`
- Тесты: `tests/evidence-extraction.test.mjs`, `tests/evidence-store.test.mjs` (в `npm test`), `tests/evidence-api.contract.mjs` (`npm run test:evidence-contract`), `tests/helpers/evidence-fixtures.mjs`; `createTempRuntime` умеет копировать дополнительные фикстуры
- `docs/product-v2/adr/ADR-003-evidence-store.md`

## Architecture decisions
- См. ADR-003: evidence — производный пересобираемый слой, отдельный от индекса, app-state и metadata provider.
- Extraction — обогащение после индексации, не замена RAG; retrieval и ответы чата на этом этапе не меняются.
- Юридические связи не додумываются: неизвестный родитель → `unknown`; недатированное ДС не заменяет; неоднозначная замена → `conflict`.

## Acceptance (Prompt Pack Stage 04) -> доказательство
- «Один click/trace: fact → evidence → exact file/page» -> `GET /api/evidence/facts/:id/trace` + превью `chunkId`/`focusText`; `tests/evidence-api.contract.mjs` открывает превью фрагмента аванса 10%; `tests/evidence-store.test.mjs` — лист «Сводная», строка 12.
- «Позднее ДС — изменение конкретного условия» -> ДС № 1 заменяет п. 3.1 (аванс 20% → 10%) и п. 4.2 (30.11.2026 → 31.03.2027), `tests/evidence-extraction.test.mjs`.
- «Устаревший факт не исчезает, а получает history/status» -> `superseded`, `valid_to`, `superseded_by_fact_id`, evidence сохранён; trace показывает `supersedes`/`supersededBy`.
- «Факт без evidence не сохраняется» -> `validateEvidenceBuild`, тест отклонения сборки.
- «Неоднозначное значение — conflict/candidates, не молчаливый выбор» -> цена договора 245 млн vs итог сметы 244,8 млн; синтетические случаи неизвестного родителя, недатированного ДС и двух кандидатов.
- «Миграции обратимы/идемпотентны» -> повторное открытие без повторного применения (тест); слой производный — откат удалением файла и пересборкой.

## Tests / evidence
Машина разработки: `node --check` новых и изменённых файлов -> PASS; разовый прогон чистых функций сборки на `fixtures/product-v2` (без сервера и `npm test`) -> значения, связи и конфликты совпадают с ожиданиями тестов.

На машине владельца (NOT RUN здесь):
- `npm run check`, `npm test`
- `npm run check:ui`, `npm run eval:demo`, `npm run eval:product`, `npm run mcp:test`, `npm run smoke:api`
- `npm run test:chat-contract`, `npm run test:conversation-contract` (регрессия Stage 02–03)
- `npm run test:evidence-contract`

## Metrics before/after
- `eval:product` не меняется: retrieval ещё не использует фрагменты и факты (Stage 06). Точность на уровне evidence подтверждается тестами Stage 04.

## Security/privacy
- В `evidence.sqlite`: имена файлов (basename), текст фрагментов, нормализованные значения. Front matter кэша отрезается. **Исправлено в Revision 1:** абсолютные пути и похожие на секреты значения в теле документа маскируются (`[path]`/`[redacted]`), см. раздел Revision 1.
- Маршруты `/api/evidence*` проходят через API security middleware.

## Known limitations
- Правила извлечения — стартовый набор для договоров; формулировки вне шаблонов не извлекаются.
- Ежедневный агент и оркестратор переиндексации не запускают пересборку evidence (нужен `npm run evidence:build -- --all`).
- Номер пункта в ДС распознаётся для формулировки «Пункт N договора изложить в новой редакции».
- `effective_date` и ревизии документов не извлекаются.

## Manual checks still required
- `npm run evidence:build -- --all` на реальных данных владельцем и выборочная проверка фактов/конфликтов.

## Ready for next stage?
NO
Reason: acceptance подтверждается прогоном на машине владельца.

---

## Revision 1 — после независимой проверки (verdict FAIL)

Подтверждено проверкой: все gates PASS (`npm test` 345/345, контракты chat/conversation/evidence PASS и завершаются сами), trace до страницы/листа/строки, замена п. 3.1 и 4.2, сохранение устаревших фактов, отклонение фактов без evidence, неизвестный родитель / недатированное ДС / ДС без номера пункта → conflict, идемпотентность, сбой evidence-БД не валит индексацию. Не подтверждено — три adversarial-случая.

### Findings
1. **Срок чужого обязательства становился сроком аванса.** «Аванс в размере 3%. Подрядчик передает отчет в течение 30 календарных дней…» давал `advance_term=30`.
   - Причина: срок искался по всему абзацу.
   - Исправление: срок аванса, срок возврата удержания и предел неустойки читаются только из предложения, где задано само обязательство (`sentenceMatching` в `fact-extractor.js`).
2. **ДС заменяло факт из явно другого пункта.** «Пункт 9.9 … аванс 10%» заменял базовый п. 3.1.
   - Причина: единственный кандидат заменялся без сверки номеров пунктов.
   - Исправление (`version-graph.js`): факт с другим явно указанным пунктом не заменяется; без точного совпадения допускается только единственный кандидат с неизвестным номером пункта. Разные значения → `conflict`.
3. **Пути и секреты из тела документа сохранялись и возвращались API.** Заявление отчёта о privacy было шире реализации.
   - Исправление: `evidence-redaction.js` маскирует абсолютные пути (Windows, UNC, POSIX, `file://`) и похожие на секреты значения (`Bearer`, `api_key=`, `пароль:`, JWT, `sk-…`, приватные ключи, userinfo и токены в URL) до нарезки фрагментов и повторно при записи в хранилище (текст, заголовок, сырое значение, условие, нормализованные значения). Идемпотентно; обычный текст договора не меняется. Индекс и markdown-кэш не изменялись.

### Регрессионные тесты
- `tests/evidence-extraction.test.mjs`: чужой срок (аванс, удержание, неустойка) не извлекается, срок в том же предложении — извлекается; ДС п. 9.9 не заменяет п. 3.1; единственный факт без номера пункта заменяется; пути/секреты в теле документа не попадают в фрагменты и факты.
- `tests/evidence-redaction.test.mjs`: точные результаты маскировки путей без захвата последующего текста, секретов, неизменность обычного текста, идемпотентность.
- `tests/evidence-store.test.mjs`: хранилище маскирует пути и секреты даже в немаскированной сборке (документ, фрагмент, факт, trace).

### Changed
- `apps/rag-api/src/evidence/evidence-redaction.js` (новый), `fact-extractor.js`, `version-graph.js`, `evidence-spans.js`, `build-source-evidence.js`, `evidence-store.js`
- тесты выше; `package.json` (check); ADR-003; этот отчёт

### Tests / evidence
- Машина разработки: `node --check` -> PASS; чистые функции на воспроизведённых случаях Codex и на `fixtures/product-v2` -> ожидаемые результаты (значения штатных фикстур не изменились, все фрагменты привязаны к чанкам); точные строки маскировки из тестов сверены. `npm test` и контракты здесь не запускались.

### Known limitations (дополнение)
- Маскировка шаблонная и не гарантирует удаление любых чувствительных сведений из произвольного текста; `focusText` превью строится из маскированного текста, поэтому подсветка места с путём/секретом может не сработать (переход по `chunkId` работает).
- Деление на предложения эвристическое (сокращения вида «ул.» могут разрезать предложение).

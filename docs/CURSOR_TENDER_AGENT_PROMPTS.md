# Cursor prompts for tender analysis agents

Ниже два готовых промта для Cursor. Перед запуском вставляйте каждый промт в новый Cursor чат из корня репозитория `LocalAI`.

## 1. Агент проверки цены конкретного тендера

```text
Ты работаешь в репозитории LocalAI. Сначала прочитай AGENTS.md и соблюдай правила: не трогай data/, реальные config с секретами, .env и пользовательские документы; не логируй токены; не откатывай существующие изменения; не сбрасывай проект на старый MVP. После каждого изменения перечисляй файлы и проверки.

Задача: создать агента проверки конкретного тендера на правильность ввода цены в БД по распознанным КП из RAG.

Контекст проекта:
- Источники делятся на sourceType=contract и sourceType=tender.
- Тендеры синхронизируются из локального Google Drive на G: через scripts/sync-tender-sources.mjs и /api/tenders/sync.
- Индексация через indexSource/runDailyIndexAgent кладет chunks в общий RAG и векторизует через ensureChunkEmbeddings.
- В chunks/manifest уже есть tenderRecognition/tenderDocumentType/tenderCommercialProposal/tenderHasPriceSignals/tenderSignalScore.
- Чат и /api/chat должны сохранять существующую privacy policy: local-first, remote context запрещен до явного включения, fallback только по fallbackToLocalOnRemoteError=true.

Нужно реализовать аккуратный MVP агента:
1. Найди в коде, где можно подключиться к БД тендеров. Если явной БД нет, создай тонкий adapter-интерфейс без реальных секретов и с mock/test adapter, чтобы потом подключить настоящую БД.
2. Добавь backend-модуль агента, который принимает tenderId или внешний номер тендера, находит tender source, извлекает из RAG документы КП:
   - sourceType=tender
   - tenderDocumentType=commercial_proposal или tenderCommercialProposal=true
   - tenderHasPriceSignals=true
3. Агент должен извлекать кандидаты цены из КП, сопоставлять их с записью БД по поставщику/позиции/номеру тендера/файлу и находить расхождения.
4. Никаких автоматических правок БД. Только report.
5. Report JSON:
   - tenderId, tenderTitle, checkedAt
   - dbRecord summary без секретов
   - findings[] с severity, field, dbValue, expectedValue, delta, confidence, evidence[]
   - evidence[] обязано содержать sourceId, fileId/chunkId, title/path, citationLabel/snippet
   - status: ok | warning | error | needs_review
6. Добавь API endpoint вида POST /api/tenders/:id/price-audit и CLI/script для локального запуска dry-run.
7. Добавь focused tests на:
   - выбор только tender КП chunks
   - сравнение цены с допуском
   - отчет с citation evidence
   - отсутствие записи в БД
8. UI можно не делать, но если делаешь, только небольшую кнопку/панель в настройках выбранного тендера, без нарушения существующих маркеров AGENTS.md.

Важно:
- Не используй реальные токены и приватные URL.
- Не печатай содержимое секретных config/.env.
- Если нужна схема БД и ее нет в репозитории, не выдумывай реальные поля как факт: создай adapter contract и явно пометь TODO для подключения.
- Используй существующие searchChunksWithMetadata/readChunks/readSources, не дублируй RAG.
- Для цен используй Decimal/строковую нормализацию, не float для финального сравнения денежных сумм.
```

## 2. Глобальный агент аудита всех тендеров

```text
Ты работаешь в репозитории LocalAI. Сначала прочитай AGENTS.md и соблюдай правила: не трогай data/, реальные config с секретами, .env и пользовательские документы; не логируй токены; не откатывай существующие изменения; не сбрасывай проект на старый MVP. После каждого изменения перечисляй файлы и проверки.

Задача: создать глобального умного агента аудита всей БД по всем тендерам. Цель: находить ошибки, отклонения и неправильный ввод полей относительно документации в RAG, включая КП, тендерную документацию, сметы, коэффициенты расходов/переводов и глобальные расчеты. Идеального образца расчета нет, поэтому агент должен снижать человеческий фактор через evidence-based проверки, эвристики, cross-check и LLM-рассуждение с цитатами.

Контекст проекта:
- Источники: sourceType=contract и sourceType=tender.
- Тендерные документы из G: попадают в RAG через /api/tenders/sync + indexSource/runDailyIndexAgent.
- Чанки содержат metadata: sourceType, tenderDocumentType, tenderCommercialProposal, tenderHasPriceSignals, tenderSignalScore, tenderCategory, linkedContractId.
- Поиск: searchChunksWithMetadata, общий chunks store, Qdrant/json vectors.
- Privacy policy проекта обязательна: local-first, remote context только если явно включен в settings, fallback только по fallbackToLocalOnRemoteError=true.

Нужно спроектировать и реализовать глобальный агент:
1. Найди или создай безопасный DB adapter contract для чтения тендеров, строк расчета, цен, коэффициентов, расходов, переводов, поставщиков, статусов. Если реальной схемы нет, сделай mock adapter и документированный интерфейс.
2. Агент должен итерироваться по всем тендерам из БД, сопоставлять каждый тендер с RAG source:
   - по tenderId/source id
   - по номеру/названию/адресу
   - по linkedContractId
   - с явным статусом match confidence
3. Для каждого тендера агент должен собрать evidence pack из RAG:
   - КП: tenderDocumentType=commercial_proposal
   - сметы/расчеты: tenderDocumentType=cost_estimate или price_table
   - тендерная документация/ТЗ: tenderDocumentType=tender_document
   - fallback search по номеру тендера, поставщику, позиции, названию работ
4. Проверки:
   - цена в БД против КП/сметы/таблиц
   - валюта, НДС, единицы измерения, количество, итоговая сумма
   - коэффициенты расходов, переводов, логистики, накладных и прочие multiplier поля
   - арифметика: quantity * unit_price * coefficients = total с допусками
   - резкие отклонения от соседних строк/похожих тендеров
   - поля с пустыми/нулевыми значениями при наличии доказательств в документации
   - несоответствие поставщика/позиции/версии КП
5. Агент не должен менять БД. Только read-only audit report.
6. Report JSON:
   - runId, startedAt, finishedAt, status
   - totals: tendersChecked, findings, critical/high/medium/low, needsReview
   - tenderReports[] с tenderId, title, dbMatch, ragMatch, findings[]
   - finding: severity, category, fieldPath, dbValue, expectedValue, formula, delta, confidence, rationale, evidence[]
   - evidence: sourceId, chunkId/fileId, title/path, citationLabel, snippet, tenderDocumentType
7. Добавь API:
   - POST /api/tenders/audit/global для запуска dry-run/read-only аудита
   - GET /api/tenders/audit/runs/:id для статуса/результата
   или CLI script, если в проекте уже принят agent-run pattern.
8. Добавь checkpointing, чтобы большой аудит можно было продолжать после сбоя.
9. Добавь tests:
   - сопоставление БД-тендера с tender source
   - выбор evidence по metadata
   - арифметическое отклонение по коэффициентам
   - отчет не содержит секретов
   - read-only гарантия adapter-а
10. Документируй, какие поля реальной БД нужно подключить позднее, если их нет в репозитории.

Критерии качества:
- Не выдумывай уверенные выводы без evidence. Если документов мало, ставь needs_review.
- Каждый finding должен иметь цитаты/чанки или явное объяснение, почему evidence не найден.
- Денежные расчеты делай без float-ошибок.
- Логи и UI показывают masked state, не секреты.
- Существующие UI/API маркеры из AGENTS.md должны остаться.
```

# Product V2 — Stage 01: eval baseline

Дата: 2026-09-16. Коммит: `df27b45` + изменения Stage 00/01. Команда: `npm run eval:product`.

## Что измеряется

- Корпус `fixtures/product-v2/`: 3 синтетических проекта (два с «Сокольники» в названии), договор + ДС № 1, смета в формате xlsx-конвертера (2 листа), скан письма в формате OCR-конвертера (2 страницы).
- Кейсы `evals/product-v2/contracts-core.json`: 17 кейсов, все 15 классов.
- Режим **retrieval-only**, как `/api/chat` до LLM: `resolveChatSourceScope` → `expandedChatRetrievalQuery` → BM25 + hybrid scoring. Без embeddings/Qdrant/reranker — это живые сервисы.
- Follow-up воспроизводит поведение UI: проект предыдущего вопроса уходит в `contextSourceId`.
- Evidence сопоставляется в трёх режимах: `file` (нужный файл), `content` (файл + текст), `exact` (файл + текст + page/sheet/row/section в `citationTarget`).

## Baseline

| Метрика | Значение | Комментарий |
|---|---|---|
| Recall@5 (exact evidence) | 0.870 (20/23) | |
| Recall@10 (exact evidence) | 0.870 (20/23) | |
| File Recall@5 | 1.000 (23/23) | разница с exact = неверные метаданные цитаты |
| MRR | 0.661 (15 кейсов) | |
| Project selection accuracy | 1.000 (16/16) | |
| Wrong-project leak @5 | 0.000 (0/15) | скоуп фильтруется поиском |
| Citation target accuracy | 0.400 (2/5) | см. дефекты 1–2 |
| Current version accuracy | 0.000 (0/1) | базовый договор (20%) выше ДС (10%) |
| Clarification recall | 0.000 (0/1) | неоднозначный проект → поиск по всем |
| Clarification precision | NOT_AVAILABLE | система ни разу не запросила уточнение |
| Claim support / numeric fidelity / no-answer hallucination | NOT_AVAILABLE | нужен answer/verifier pipeline (Stage 07) |
| Verifier false-pass / false-reject | NOT_AVAILABLE | нужен verifier (Stage 07) |

## Найденные дефекты (не исправлялись — Stage 01 только измеряет)

1. **`sectionTitle` фрагмента = последний заголовок внутри фрагмента** (`text.js` `chunkMarkdown`/`mergeChunkMetadata`). Фрагмент с разделами 5–8 договора получает `sectionTitle: "8. Расторжение договора"`, поэтому цитата на п. 7 «Ответственность» указывает не на тот раздел. Кейс `pv2-citation-penalty`.
2. **Несколько листов xlsx в одном фрагменте**: `sheetName` = последний лист, `rowStart/rowEnd` объединяются по разным листам (`Материалы`, строки 1–12). Цитаты на строки листа «Сводная» неверны. Кейсы `pv2-spreadsheet-monolith`, `pv2-conflict-total-cost`.
3. **Заголовок страницы уходит в хвост предыдущего фрагмента**: фрагмент с текстом только страницы 1 получает `pageEnd: 2`, если за ним стоит `## OCR page 2`.
4. **Версии документов не учитываются**: на вопрос «какой сейчас аванс» базовый договор ранжируется выше ДС № 1. Кейс `pv2-amendment-advance`.
5. **Нет уточнения проекта**: вопрос «Какой аванс по Сокольникам?» при двух подходящих проектах уходит в поиск по всем проектам без вопроса пользователю. Кейс `pv2-ambiguous-sokolniki`.

Дефекты 1–3 относятся к Stage 04 (EvidenceSpan) и Stage 06 (Retrieval 2.0), дефект 4 — к Stage 04/06, дефект 5 — к Stage 05.

## Ограничения

- Retrieval без векторов и reranker: итоговые ранги на живом стеке будут другими. Метрики — регрессионный контракт логики scope/lexical/citation, а не оценка качества живого поиска.
- Answer/verifier-метрики появятся, когда будет answer-core со статусами (Stage 02 → 07).
- 17 кейсов — контракт и регрессия, а не статистически значимая оценка. Реальный корпус — `evals-private/` (Stage 10).

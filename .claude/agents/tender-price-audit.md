---
name: tender-price-audit
description: >-
  Агент проверки ввода цен в HubTender по распознанным КП из LocalAI RAG.
  Сравнивает boq_items/client_positions с tender КП chunks (commercial_proposal,
  price signals). Read-only report с citation evidence. Use when auditing tender
  price entry, KP mismatches, or quote_link validation.
model: sonnet
---

# Агент аудита цен тендера (LocalAI + HubTender)

Read-only агент: сверяет цены в HubTender PostgreSQL с распознанными коммерческими предложениями из LocalAI RAG. **Не изменяет БД.**

## Правила (AGENTS.md)

- Не трогать `data/`, секретные config, `.env`, пользовательские документы.
- Не логировать токены и приватные URL.
- Не откатывать существующие изменения и UI-маркеры.
- Privacy policy: local-first, remote context только при явном включении.

## Архитектура

```
LocalAI RAG (chunks)          HubTender PostgreSQL
  sourceType=tender    ←→    tenders, client_positions, boq_items
  tenderCommercialProposal     quote_link, total_commercial_*
  tenderHasPriceSignals
         ↓
  tender-price-audit.js → JSON report (findings + evidence)
```

## Запуск

**API:**
```http
POST /api/tenders/:sourceId/price-audit
?dryRun=true&hubTenderId=<uuid>&tolerance=1
```

**CLI (dry-run без реальной БД):**
```powershell
cd LocalAI
npm run agent:price-audit -- --source-id=tender-abc --hub-tender-id=<uuid>
```

**С реальным adapter (когда подключён):**
```powershell
npm run agent:price-audit:live -- --source-id=tender-abc --hub-tender-id=<uuid>
```

## Модули

| Файл | Назначение |
|------|------------|
| `apps/rag-api/src/tender-price-audit.js` | Оркестрация аудита |
| `apps/rag-api/src/hubtender-adapter.js` | Contract + mock adapter (TODO: PostgreSQL) |
| `apps/rag-api/src/money.js` | Сравнение сумм без float |
| `scripts/tender-price-audit.mjs` | CLI dry-run |

## Фильтр КП chunks

- `sourceType === "tender"`
- `tenderCommercialProposal === true` OR `tenderDocumentType === "commercial_proposal"`
- `tenderHasPriceSignals === true`

## Report JSON

- `tenderId`, `tenderTitle`, `checkedAt`, `status` (`ok|warning|error|needs_review`)
- `dbRecord` — summary без секретов
- `findings[]` — `severity`, `field`, `dbValue`, `expectedValue`, `delta`, `confidence`, `evidence[]`
- `evidence[]` — `sourceId`, `fileId`, `chunkId`, `title`, `path`, `citationLabel`, `snippet`

## HubTender adapter (TODO)

Реальное подключение: `HUBTENDER_DATABASE_URL` → read-only запросы к:
- `tenders` (`id`, `tender_number`, `title`, `version`, `client_name`)
- `client_positions` (`material_cost_per_unit`, `work_cost_per_unit`, `total_commercial_*`)
- `boq_items` (`quote_link`, `total_commercial_material_cost`, `total_commercial_work_cost`)

Схема: `HubTender/supabase/schemas/prod.sql`.

## Тесты

```powershell
npm test -- tests/tender-price-audit.test.mjs
```

# Tender audit (LocalAI + HubTender)

Read-only сверка цен в HubTender PostgreSQL с распознанными КП из LocalAI RAG.

## Архитектура

```
LocalAI (оркестратор)
  ├─ readChunks / readSources     → КП, сметы, ТЗ
  ├─ hubtender-adapter-pg         → tenders, boq_items (read-only)
  └─ tender-price-audit           → один тендер
      tender-global-audit         → все тендеры
```

HubTender Go BFF **не** участвует в аудите.

## Env (только LocalAI `.env`)

```env
HUBTENDER_DATABASE_URL=postgresql://...?sslmode=verify-full
```

Секрет только в локальном `.env`, не в `config/settings.json`.

## API

### Один тендер

```http
POST /api/tenders/:sourceId/price-audit?hubTenderId=<uuid>&tolerance=1
```

### Все тендеры

```http
POST /api/tenders/audit/global
Content-Type: application/json

{ "maxTenders": 500, "includeArchived": false, "tolerance": 1 }
```

Ответ `202` + `runId`. Статус:

```http
GET /api/tenders/audit/runs/:runId
```

Синхронный CLI: `?sync=true` или `--sync`.

## CLI

```powershell
cd LocalAI
npm run agent:price-audit:live -- --source-id=tender-abc --hub-tender-id=<uuid>
npm run agent:global-audit:live -- --wait
```

Dry-run без БД: `agent:price-audit` / `agent:global-audit` (mock adapter).

## Маппинг DB ↔ RAG

| HubTender | LocalAI |
|-----------|---------|
| `tenders.id` | `hubTenderId` |
| `tenders.tender_number` | `source.title` (`298. …`) |
| `boq_items.quote_link` | chunk `path` / `title` |

## Модули

| Файл | Роль |
|------|------|
| `hubtender-adapter-pg.js` | Read-only PostgreSQL |
| `tender-audit-match.js` | DB tender ↔ RAG source |
| `tender-price-audit.js` | КП vs BOQ, один тендер |
| `tender-global-audit.js` | Итерация + checkpoint |
| `audit-run-store.js` | `data/state/audit-runs.json` |

## Тесты

```powershell
npm test -- tests/tender-price-audit.test.mjs tests/tender-global-audit.test.mjs
```

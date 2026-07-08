# LocalAI MCP Server — план для Cursor

Документ описывает проектирование MCP server для безопасного инструментального доступа Cursor к LocalAI RAG **без прямого чтения** `data/`, `config/settings.json`, `config/sources.yaml`, `.env` и пользовательских документов на диске.

Реализация runtime-кода **не входит** в этот этап. Все операции должны идти через уже существующие HTTP API (`apps/rag-api`) и npm-скрипты (`package.json`).

---

## 1. Анализ существующих API и скриптов

### 1.1. Базовые параметры runtime

| Параметр | Значение |
|----------|----------|
| Default host | `127.0.0.1` (`RAG_HOST`) |
| Default port | `8787` (`RAG_PORT`) |
| Auth | `RAG_AUTH_TOKEN` + `RAG_REQUIRE_AUTH`; middleware в `security.js` |
| Origin policy | только loopback origins |
| Public masking | `publicSettings`, `publicLlmSettings`, `hasApiKey` вместо секретов |

MCP server должен вызывать API **только на loopback** и передавать Bearer token из env процесса MCP (не из ответов API и не из репозитория).

### 1.2. Релевантные read-only API endpoints

| Endpoint | Назначение |
|----------|------------|
| `GET /api/health` | readiness probe |
| `GET /api/sources` | список проектов с `indexStatus`, summary, context links |
| `GET /api/sources/:id/indexed-files` | дерево проиндексированных файлов |
| `GET /api/sources/match` | авто-определение проекта по вопросу |
| `GET /api/search?q=&sourceId=&limit=` | гибридный retrieval (BM25 + vector + rerank) |
| `GET /api/files/preview?sourceId=&chunkId\|fileId\|path=` | превью цитаты / файла |
| `GET /api/agent/runs` | последние 20 запусков daily agent |
| `GET /api/integrations/status` | Qdrant, reranker, PDF converter |
| `GET /api/llm/diagnostics?provider=local\|token` | диагностика LLM (latency, models, busy) |
| `GET /api/llm/status` | упрощённый online/offline статус |
| `GET /api/jobs/:id` | статус фоновой задачи (индекс / backfill) |

### 1.3. State-changing API (не включать в Phase 1–2 без gate)

| Endpoint | Риск |
|----------|------|
| `POST /api/agent/run` | запуск индексации всех sources |
| `POST /api/sources/:id/index` | индексация одного проекта |
| `POST /api/sources` / `DELETE /api/sources*` | изменение конфигурации sources |
| `PUT /api/settings` | изменение routing, remote context, credentials refs |
| `POST /api/vector-store/backfill` | embeddings + Qdrant write |
| `POST /api/system/restart` | перезапуск backend |
| `POST /api/chat`, `POST /api/chat/stream` | LLM + утечка контекста документов во внешний/локальный LLM |
| `POST /api/files/system-open` | открытие файлов в ОС |

### 1.4. Релевантные npm-скрипты

| Script | Что делает | Live data |
|--------|------------|-----------|
| `npm run check` | `node --check` синтаксис ключевых файлов | нет |
| `npm run check:ui` | `scripts/check-ui-static.mjs` — AGENTS.md markers, UI refs | нет (только исходники) |
| `npm run smoke:local` | `scripts/smoke-local.mjs` — demo fixture, retrieval без сервера | **нет** (temp dir) |
| `npm run smoke:api` | `scripts/smoke-api-local.mjs` — ephemeral server + demo | **нет** (temp copy) |
| `npm run eval:demo` | `scripts/run-evals.mjs --demo --strict` | **нет** (demo fixture) |
| `npm run eval:llm` | `run-evals.mjs --with-llm` → `/api/chat` | да, gated |
| `npm run agent:run` | `scripts/daily-agent.mjs` | да, индексация live sources |
| `npm run agent:dry-run` | dry-run без записи | read-only scan |
| `npm run agent:force` | force reindex | да, тяжёлая запись |

### 1.5. Принципы доступа MCP

1. **HTTP-first для live state**: sources, search, preview, diagnostics — только через running API.
2. **Scripts для проверок**: eval/smoke/check — через `child_process` с фиксированными argv, без произвольных shell-команд.
3. **Запрет прямого FS**: MCP не читает `data/state/*`, `config/*`, `.env`, markdown cache, исходные PDF/DOCX пользователя.
4. **Output sanitization**: повторное использование паттернов `redactedLine` из `smoke-api-local.mjs` и `public*` helpers из `server.js`.
5. **Local-first**: remote LLM diagnostics допустимы как masked status; chat/eval:llm — только с явным opt-in.

---

## 2. MCP tools — спецификация

Общие поля ответа для всех tools (обёртка MCP):

```json
{
  "ok": true,
  "tool": "search",
  "checkedAt": "2026-07-01T12:00:00.000Z",
  "apiBaseUrl": "http://127.0.0.1:8787",
  "data": {}
}
```

При ошибке: `ok: false`, `error: { code, message }`, без stack trace с env-секретами.

---

### 2.1. `listSources`

**Назначение:** получить список RAG-проектов (sources) с публичным статусом индексации и summary, без чтения `config/sources.yaml`.

| | |
|---|---|
| **Backend** | `GET /api/sources` |
| **Mode** | read-only |

**Input schema**

```json
{
  "type": "object",
  "properties": {
    "includeSummary": {
      "type": "boolean",
      "default": true,
      "description": "Включать deterministic project summary из API"
    }
  },
  "additionalProperties": false
}
```

**Output schema**

```json
{
  "type": "object",
  "properties": {
    "sources": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "id": { "type": "string" },
          "title": { "type": "string" },
          "path": { "type": "string" },
          "createdAt": { "type": "string" },
          "updatedAt": { "type": "string" },
          "indexStatus": { "type": "object" },
          "summary": { "type": ["object", "null"] },
          "contextLinks": { "type": "array" }
        },
        "required": ["id", "title", "indexStatus"]
      }
    },
    "count": { "type": "integer" }
  },
  "required": ["sources", "count"]
}
```

**Security / privacy**

| Risk | Mitigation |
|------|------------|
| Раскрытие абсолютных путей к проектам пользователя | Допустимо локально; опционально `maskPaths: true` → basename + hash |
| Google context link URLs | API уже отдаёт public context links; **маскировать query tokens** в URL (`/d/...`, `?id=`) |
| Summary может содержать фрагменты имён файлов | Оставить как в UI; не расширять за пределы API |

**Маскировать:** токены в context link URL, Bearer в логах, содержимое `summary.sampleTexts` если появится в API.

---

### 2.2. `getIndexedFiles`

**Назначение:** дерево проиндексированных файлов для source (аналог `#indexed-files-tree` в UI).

| | |
|---|---|
| **Backend** | `GET /api/sources/:id/indexed-files` |
| **Mode** | read-only |

**Input schema**

```json
{
  "type": "object",
  "properties": {
    "sourceId": { "type": "string", "minLength": 1 },
    "qualityFilter": {
      "type": "string",
      "enum": ["all", "ok", "warning", "error", "searchable"],
      "default": "all"
    }
  },
  "required": ["sourceId"],
  "additionalProperties": false
}
```

**Output schema**

```json
{
  "type": "object",
  "properties": {
    "sourceId": { "type": "string" },
    "sourceTitle": { "type": "string" },
    "root": { "type": "string" },
    "total": { "type": "integer" },
    "searchable": { "type": "integer" },
    "chunks": { "type": "integer" },
    "quality": {
      "type": "object",
      "properties": {
        "ok": { "type": "integer" },
        "warning": { "type": "integer" },
        "error": { "type": "integer" },
        "unchecked": { "type": "integer" }
      }
    },
    "files": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "fileId": { "type": "string" },
          "relativePath": { "type": "string" },
          "title": { "type": "string" },
          "extension": { "type": "string" },
          "chunks": { "type": "integer" },
          "indexedAt": { "type": "string" },
          "quality": { "type": ["object", "null"] },
          "recognition": { "type": ["object", "null"] }
        }
      }
    }
  },
  "required": ["sourceId", "files", "total"]
}
```

**Security / privacy**

| Risk | Mitigation |
|------|------------|
| Полные абсолютные пути файлов | Возвращать `relativePath` по умолчанию; `path` — только при `includeAbsolutePaths: true` + user confirm |
| `recognition` может содержать error messages с путями | Sanitize paths в error fields |

**Маскировать:** абсолютные пути (по умолчанию), секреты в recognition errors.

---

### 2.3. `search`

**Назначение:** retrieval по индексу для отладки RAG и подготовки цитат (без вызова LLM).

| | |
|---|---|
| **Backend** | `GET /api/search?q=&sourceId=&limit=` |
| **Mode** | read-only (читает indexed chunks через API) |

**Input schema**

```json
{
  "type": "object",
  "properties": {
    "query": { "type": "string", "minLength": 1, "maxLength": 2000 },
    "sourceId": { "type": "string", "description": "Пусто = поиск по всем проектам" },
    "limit": { "type": "integer", "minimum": 1, "maximum": 30, "default": 10 },
    "includeFullText": {
      "type": "boolean",
      "default": false,
      "description": "Включать полный chunk.text; иначе только snippet"
    }
  },
  "required": ["query"],
  "additionalProperties": false
}
```

**Output schema**

```json
{
  "type": "object",
  "properties": {
    "query": { "type": "string" },
    "results": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "rank": { "type": "integer" },
          "chunkId": { "type": "string" },
          "fileId": { "type": "string" },
          "sourceId": { "type": "string" },
          "sourceTitle": { "type": "string" },
          "citationLabel": { "type": "string" },
          "score": { "type": "number" },
          "snippet": { "type": "string" },
          "text": { "type": "string" },
          "citationTarget": { "type": "object" }
        },
        "required": ["chunkId", "citationLabel", "score", "snippet"]
      }
    },
    "metadata": {
      "type": "object",
      "description": "Публичные search timings / vector flags из API metadata"
    }
  },
  "required": ["query", "results", "metadata"]
}
```

**Security / privacy**

| Risk | Mitigation |
|------|------------|
| Утечка содержимого деловых документов в контекст Cursor | `includeFullText: false` по умолчанию; лимит snippet; предупреждение в tool description |
| Remote vector query | metadata показывает provider; remote context forbidden by policy unless enabled in settings — MCP не обходит это |

**Маскировать:** ничего из scores/metadata; PII в snippet — ответственность пользователя (локальный инструмент).

---

### 2.4. `previewCitation`

**Назначение:** превью фрагмента для inline citation `[n]` — markdown window, focus range, label.

| | |
|---|---|
| **Backend** | `GET /api/files/preview?sourceId=&chunkId=` (предпочтительно) или `fileId` / safe `path` |
| **Mode** | read-only |

**Input schema**

```json
{
  "type": "object",
  "properties": {
    "sourceId": { "type": "string", "minLength": 1 },
    "chunkId": { "type": "string" },
    "fileId": { "type": "string" },
    "path": { "type": "string", "description": "Relative path within source; traversal запрещён API" },
    "focusText": { "type": "string", "maxLength": 900 },
    "maxChars": {
      "type": "integer",
      "minimum": 500,
      "maximum": 50000,
      "default": 12000,
      "description": "Клиентский лимит на возвращаемый markdown/excerpt"
    }
  },
  "required": ["sourceId"],
  "additionalProperties": false
}
```

Constraint: хотя бы одно из `chunkId`, `fileId`, `path`.

**Output schema**

```json
{
  "type": "object",
  "properties": {
    "targetMatched": { "type": "boolean" },
    "sourceId": { "type": "string" },
    "chunkId": { "type": "string" },
    "fileId": { "type": "string" },
    "label": { "type": "string" },
    "title": { "type": "string" },
    "relativePath": { "type": "string" },
    "excerpt": { "type": "string" },
    "markdown": { "type": "string" },
    "focus": { "type": "object" },
    "truncated": { "type": "boolean" },
    "truncatedBefore": { "type": "boolean" },
    "truncatedAfter": { "type": "boolean" },
    "evidenceMatched": { "type": "boolean" }
  },
  "required": ["targetMatched", "label"]
}
```

**Security / privacy**

| Risk | Mitigation |
|------|------------|
| Path traversal (`../../`) | API + `preview-access.js` блокируют; MCP не принимает encoded traversal |
| Огромные markdown ответы | `maxChars` truncate на стороне MCP после API |
| Полный документ вместо цитаты | по умолчанию передавать `chunkId` из search result |

**Маскировать:** абсолютный `path` в output (заменить на `relativePath`).

---

### 2.5. `runAgent`

**Назначение:** запустить daily index agent (все sources, scan + convert + chunks + optional embeddings).

| | |
|---|---|
| **Backend** | `POST /api/agent/run` (если API online) **или** `npm run agent:run` / `agent:dry-run` / `agent:force` |
| **Mode** | **state-changing** |

**Input schema**

```json
{
  "type": "object",
  "properties": {
    "force": { "type": "boolean", "default": false },
    "dryRun": { "type": "boolean", "default": false },
    "transport": {
      "type": "string",
      "enum": ["api", "cli"],
      "default": "api",
      "description": "api — POST /api/agent/run; cli — scripts/daily-agent.mjs"
    }
  },
  "additionalProperties": false
}
```

**Output schema**

```json
{
  "type": "object",
  "properties": {
    "status": { "type": "string", "enum": ["started", "running", "completed", "failed", "skipped"] },
    "force": { "type": "boolean" },
    "dryRun": { "type": "boolean" },
    "startedAt": { "type": "string" },
    "finishedAt": { "type": "string" },
    "message": { "type": "string" },
    "totals": { "type": "object" },
    "runId": { "type": "string" }
  },
  "required": ["status"]
}
```

**Security / privacy**

| Risk | Mitigation |
|------|------------|
| Длительная нагрузка CPU/disk | **требует explicit user confirmation** |
| Параллельный запуск | API возвращает `running`; agent lock на CLI |
| `force` перезаписывает cache | отдельный confirm flag `confirmForce: true` |

**Маскировать:** пути в progress logs; stderr с токенами.

**User confirmation:** обязательно для `dryRun: false`. Для `force: true` — отдельное подтверждение.

---

### 2.6. `getAgentRuns`

**Назначение:** история последних запусков daily agent (статус, totals, ошибки).

| | |
|---|---|
| **Backend** | `GET /api/agent/runs` |
| **Mode** | read-only |

**Input schema**

```json
{
  "type": "object",
  "properties": {
    "limit": { "type": "integer", "minimum": 1, "maximum": 20, "default": 10 }
  },
  "additionalProperties": false
}
```

**Output schema**

```json
{
  "type": "object",
  "properties": {
    "runs": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "id": { "type": "string" },
          "status": { "type": "string" },
          "trigger": { "type": "string" },
          "force": { "type": "boolean" },
          "dryRun": { "type": "boolean" },
          "startedAt": { "type": "string" },
          "finishedAt": { "type": "string" },
          "totals": { "type": "object" },
          "error": { "type": "string" }
        }
      }
    }
  },
  "required": ["runs"]
}
```

**Security / privacy**

| Risk | Mitigation |
|------|------------|
| Error messages с путями | sanitize absolute paths |
| Нет секретов в runs | не добавлять env dump |

**Маскировать:** user home paths в `error`.

---

### 2.7. `getIntegrationsStatus`

**Назначение:** статус Qdrant, reranker, PDF converter — для диагностики инфраструктуры RAG.

| | |
|---|---|
| **Backend** | `GET /api/integrations/status` |
| **Mode** | read-only |

**Input schema**

```json
{
  "type": "object",
  "properties": {},
  "additionalProperties": false
}
```

**Output schema**

```json
{
  "type": "object",
  "properties": {
    "vectorStore": { "type": "object" },
    "reranker": { "type": "object" },
    "pdf": { "type": "object" }
  },
  "required": ["vectorStore", "reranker", "pdf"]
}
```

Поля совпадают с API (`qdrantAvailable`, `collectionName`, `provider`, errors).

**Security / privacy**

| Risk | Mitigation |
|------|------------|
| Qdrant URL / API key | API отдаёт `hasApiKey`, не ключ; URL может быть LAN — **маскировать credentials в URL** |
| Internal hostnames | показывать host без userinfo |

**Маскировать:** `apiKey`, userinfo в URL, токены в error strings.

---

### 2.8. `getLlmDiagnostics`

**Назначение:** диагностика LLM routing (local / remote), latency, model match, busy state — аналог вкладки LLM в settings.

| | |
|---|---|
| **Backend** | `GET /api/llm/diagnostics?provider=local|token` |
| **Mode** | read-only (делает probe к LLM endpoint) |

**Input schema**

```json
{
  "type": "object",
  "properties": {
    "provider": {
      "type": "string",
      "enum": ["local", "token"],
      "default": "local",
      "description": "local = on-device LM Studio; token = remote (masked)"
    }
  },
  "additionalProperties": false
}
```

**Output schema**

```json
{
  "type": "object",
  "properties": {
    "online": { "type": "boolean" },
    "provider": { "type": "string" },
    "providerLabel": { "type": "string" },
    "activeProvider": { "type": "string" },
    "baseUrl": { "type": "string" },
    "configured": { "type": "boolean" },
    "busy": { "type": "boolean" },
    "activeRequestsCount": { "type": "integer" },
    "latencyMs": { "type": "number" },
    "configuredModel": { "type": "object" },
    "models": { "type": "array" },
    "openai": { "type": ["object", "null"] },
    "nativeRest": { "type": ["object", "null"] },
    "error": { "type": "string" }
  },
  "required": ["online", "provider"]
}
```

**Security / privacy**

| Risk | Mitigation |
|------|------------|
| Remote baseUrl — приватный endpoint | показывать host + port; **не** query secrets |
| Probe уходит на remote host | `provider=token` только с confirm если `RAG_REMOTE_LLM_ENABLED` |
| `lastGeneration` может содержать prompt stats | не включать raw prompts; только counts из API |

**Маскировать:** api keys, Bearer, private URLs с токенами, поля `remote.apiKey`.

---

### 2.9. `runEvalDemo`

**Назначение:** strict retrieval eval на demo fixture (`fixtures/demo-project`) — регрессия качества поиска без live data.

| | |
|---|---|
| **Backend** | `npm run eval:demo` → `node scripts/run-evals.mjs --demo --strict` |
| **Mode** | read-only (temp in-memory / no user data) |

**Input schema**

```json
{
  "type": "object",
  "properties": {
    "timeoutMs": { "type": "integer", "minimum": 5000, "maximum": 300000, "default": 120000 }
  },
  "additionalProperties": false
}
```

**Output schema**

```json
{
  "type": "object",
  "properties": {
    "exitCode": { "type": "integer" },
    "passed": { "type": "boolean" },
    "cases": { "type": "integer" },
    "evaluated": { "type": "integer" },
    "metrics": {
      "type": "object",
      "properties": {
        "recallAt3": { "type": "number" },
        "recallAt5": { "type": "number" },
        "recallAt10": { "type": "number" },
        "mrr": { "type": "number" }
      }
    },
    "stdout": { "type": "string" },
    "stderr": { "type": "string" }
  },
  "required": ["exitCode", "passed"]
}
```

**Security / privacy**

| Risk | Mitigation |
|------|------------|
| stdout содержит citation labels demo docs | безопасно — только fixture |
| Случайный запуск eval:llm | **не** экспонировать `--with-llm` в этом tool |

**Маскировать:** Bearer в stderr при misconfiguration.

---

### 2.10. `runSmokeLocal`

**Назначение:** быстрый offline smoke retrieval + citation labels на demo fixture (без поднятия API).

| | |
|---|---|
| **Backend** | `npm run smoke:local` → `scripts/smoke-local.mjs` |
| **Mode** | read-only (temp directory, удаляется после run) |

**Input schema**

```json
{
  "type": "object",
  "properties": {
    "timeoutMs": { "type": "integer", "minimum": 5000, "maximum": 180000, "default": 90000 },
    "keepTemp": { "type": "boolean", "default": false }
  },
  "additionalProperties": false
}
```

`keepTemp: true` — **требует user confirmation** (оставляет temp на диске).

**Output schema**

```json
{
  "type": "object",
  "properties": {
    "exitCode": { "type": "integer" },
    "passed": { "type": "boolean" },
    "metrics": { "type": "object" },
    "stdout": { "type": "string" },
    "stderr": { "type": "string" }
  },
  "required": ["exitCode", "passed"]
}
```

**Security / privacy:** минимальный риск; не трогает user `data/`.

**Маскировать:** токены в stderr.

---

### 2.11. `runCheckUi`

**Назначение:** статическая проверка UI markers из AGENTS.md (`#indexed-files-tree`, citations, source match и т.д.).

| | |
|---|---|
| **Backend** | `npm run check:ui` → `scripts/check-ui-static.mjs` |
| **Mode** | read-only |

**Input schema**

```json
{
  "type": "object",
  "properties": {
    "timeoutMs": { "type": "integer", "minimum": 5000, "maximum": 120000, "default": 60000 }
  },
  "additionalProperties": false
}
```

**Output schema**

```json
{
  "type": "object",
  "properties": {
    "exitCode": { "type": "integer" },
    "passed": { "type": "boolean" },
    "pass": { "type": "array", "items": { "type": "string" } },
    "warn": { "type": "array", "items": { "type": "string" } },
    "fail": { "type": "array", "items": { "type": "string" } },
    "stdout": { "type": "string" },
    "stderr": { "type": "string" }
  },
  "required": ["exitCode", "passed"]
}
```

**Security / privacy:** только исходники репозитория; без user data.

---

## 3. Tools вне MVP (не включать без отдельного ADR)

| Tool | Почему не в MVP |
|------|-----------------|
| `chat` / `chatStream` | LLM + document context; privacy policy; remote routing |
| `matchSource` | можно добавить в Phase 1 как часть search UX |
| `putSettings` | меняет routing и integration flags |
| `indexSource` | state-changing, тяжёлый IO |
| `runSmokeApi` | поднимает ephemeral server (Phase 2 optional) |
| `runEvalLlm` | gated `RAG_EVAL_ALLOW_LLM` |
| `systemOpenFile` | открывает файлы в ОС пользователя |

---

## 4. Структура файлов будущей реализации

```
apps/mcp-server/
  package.json                 # "@modelcontextprotocol/sdk", type: module
  README.md                    # Cursor mcp.json snippet, env vars
  src/
    index.js                   # stdio entrypoint, register tools
    server.js                  # McpServer bootstrap
    config.js                  # RAG_API_URL, RAG_AUTH_TOKEN, timeouts, feature flags
    client/
      api-client.js            # fetch wrapper: loopback-only, auth, JSON errors
      script-runner.js         # spawn npm scripts with fixed args (no shell)
    tools/
      list-sources.js
      get-indexed-files.js
      search.js
      preview-citation.js
      run-agent.js
      get-agent-runs.js
      get-integrations-status.js
      get-llm-diagnostics.js
      run-eval-demo.js
      run-smoke-local.js
      run-check-ui.js
    schema/
      tools.json               # JSON Schema для input/output (single source of truth)
    sanitize/
      redact.js                # tokens, Bearer, URL userinfo, home paths
      truncate.js              # maxChars для preview/search
    policy/
      confirmations.js         # gates: state-changing, force, keepTemp, remote
      allowlist.js             # allowed hosts, allowed scripts
  tests/
    redact.test.mjs
    api-client.test.mjs
    policy.test.mjs

.cursor/
  mcp.json.example             # шаблон регистрации server в Cursor (без секретов)

docs/
  localai-mcp-plan.md          # этот документ
  localai-mcp-ops.md           # (Phase 4) troubleshooting, logs, versioning
```

### 4.1. Конфигурация Cursor (пример)

```json
{
  "mcpServers": {
    "localai-rag": {
      "command": "node",
      "args": ["apps/mcp-server/src/index.js"],
      "env": {
        "RAG_API_URL": "http://127.0.0.1:8787",
        "RAG_AUTH_TOKEN": "${env:RAG_AUTH_TOKEN}",
        "LOCALAI_MCP_PHASE": "1"
      }
    }
  }
}
```

`LOCALAI_MCP_PHASE` ограничивает набор зарегистрированных tools на этапе rollout.

### 4.2. Зависимости от существующего кода

| MCP module | Reuse |
|------------|-------|
| `sanitize/redact.js` | паттерны из `scripts/smoke-api-local.mjs` |
| `policy/allowlist.js` | `isLoopbackHost` из `apps/rag-api/src/security.js` (копия или shared package) |
| Tool schemas | синхронизировать с публичными API shapes в `server.js` |

**Не импортировать** `store.js`, `paths.js` data accessors в MCP — только HTTP/scripts.

---

## 5. Phased roadmap

### Phase 1 — read-only diagnostics

> **Implementation note (2026-07-01):** Phase 1 реализован в `apps/mcp-server/` (stdio MCP, 7 read-only tools). Регистрация в Cursor: `.cursor/mcp.json.example`. Проверки: `npm run mcp:check`, `npm run mcp:test`.

**Цель:** дать Cursor безопасный обзор состояния RAG без записи и без LLM.

| Tools | Enabled |
|-------|---------|
| `getIntegrationsStatus` | yes |
| `getLlmDiagnostics` | yes (`provider=local` only by default) |
| `getAgentRuns` | yes |
| `listSources` | yes |
| `getIndexedFiles` | yes (relative paths only) |
| `search` | yes (`includeFullText: false` default) |
| `previewCitation` | yes (truncated) |

**Критерии готовности**

- [ ] MCP стартует через stdio, проходит `npm run check`
- [ ] Все вызовы только к `127.0.0.1` / `localhost`
- [ ] Нет утечки `RAG_AUTH_TOKEN` / API keys в tool results
- [ ] Unit tests на `redact.js` и host allowlist
- [ ] Документирован `mcp.json.example`

### Phase 2 — safe local checks

**Цель:** запуск изолированных проверок качества и UI markers без live user data.

| Tools | Enabled |
|-------|---------|
| `runCheckUi` | yes |
| `runSmokeLocal` | yes (`keepTemp: false` only) |
| `runEvalDemo` | yes |
| optional: `runSmokeApi` | behind flag |

**Критерии готовности**

- [ ] Script runner не использует shell (`spawn` с argv array)
- [ ] Timeout + max stdout capture (например 512 KB)
- [ ] CI-friendly: exit code propagates to `passed`
- [ ] Интеграция с `.cursor/skills/local-rag-ui-acceptance` и `local-rag-retrieval-eval`

### Phase 3 — controlled agent / index actions

**Цель:** ограниченные state-changing операции с подтверждением пользователя.

| Tools | Enabled |
|-------|---------|
| `runAgent` | yes with confirmation |
| future: `indexSource` | single source, confirm |
| future: `getJobStatus` | poll `GET /api/jobs/:id` |

**Правила**

- `runAgent({ dryRun: true })` — без confirm (read-only scan)
- `runAgent({ force: true })` — double confirm
- Блокировать параллельный `runAgent` если API вернул `running`
- Логировать только masked summary

### Phase 4 — optional UI app / view

**Цель:** richer UX в Cursor (не обязателен для core value).

Идеи:

- MCP **resource** `localai://sources` — cached JSON list (ETag from `updatedAt`)
- MCP **resource** `localai://runs/latest`
- Lightweight **prompt** templates: «diagnose RAG», «explain index status»
- `@cursor/skills-cursor/canvas` view: integrations dashboard (read-only)
- Связка с `.cursor/agents/retrieval-quality.md` и `privacy-auditor.md`

Не реализовывать запись settings через UI app до отдельного privacy review.

---

## 6. Tools, требующие явного подтверждения пользователя

Cursor MCP должен использовать `ask`/`confirmation` (или аналог в policy layer) **до** вызова backend.

| Tool / параметр | Почему |
|-----------------|--------|
| `runAgent` с `dryRun: false` | индексация, запись в `data/state`, нагрузка на диск |
| `runAgent` с `force: true` | полный пересчёт recognition/cache |
| `runSmokeLocal` с `keepTemp: true` | оставляет temp dirs |
| `search` с `includeFullText: true` | массовая выгрузка текста документов в чат |
| `previewCitation` с большим `maxChars` (>20000) | большие фрагменты деловых документов |
| `getLlmDiagnostics` с `provider: token` | probe удалённого LLM endpoint |
| **Любой будущий** `chat` / `eval:llm` | LLM + document context; remote privacy |
| **Любой будущий** `putSettings` / `indexSource` / `deleteSource` | изменение конфигурации и индекса |
| **Любой будущий** `vectorBackfill` | embeddings write + Qdrant |
| **Любой будущий** `systemRestart` | downtime |
| **Любой будущий** `systemOpenFile` | side effect в ОС |

### 6.1. Tools, которые нельзя включать без явного подтверждения при **регистрации** server

Эти tools не должны появляться в `LOCALAI_MCP_PHASE=1` и требуют opt-in в config:

1. `runAgent` (любой не-dry-run)
2. `chat` / `chatStream` (когда будут добавлены)
3. `runEvalLlm` / `eval:llm`
4. `putSettings`, `indexSource`, `deleteSource`, `addSource`
5. `vectorBackfill`, `systemRestart`, `rerankerStart/Stop`
6. `systemOpenFile`
7. `getLlmDiagnostics?provider=token` как default

---

## 7. Чеклист перед merge реализации

- [ ] `npm run check`, `npm test`, `npm run check:ui` green
- [ ] Privacy review по `.cursor/skills/local-rag-privacy-review/SKILL.md`
- [ ] Нет чтения `data/`, `config/settings.json`, `config/sources.yaml`, `.env` из MCP
- [ ] AGENTS.md markers не затронуты
- [ ] README: как включить MCP в Cursor, какие env нужны
- [ ] Пример сессии: `listSources` → `search` → `previewCitation`

---

## 8. Краткая матрица tools

| Tool | Endpoint / Script | R/W | Phase | User confirm |
|------|-------------------|-----|-------|--------------|
| `listSources` | `GET /api/sources` | R | 1 | no |
| `getIndexedFiles` | `GET /api/sources/:id/indexed-files` | R | 1 | no |
| `search` | `GET /api/search` | R | 1 | if full text |
| `previewCitation` | `GET /api/files/preview` | R | 1 | if large |
| `getAgentRuns` | `GET /api/agent/runs` | R | 1 | no |
| `getIntegrationsStatus` | `GET /api/integrations/status` | R | 1 | no |
| `getLlmDiagnostics` | `GET /api/llm/diagnostics` | R | 1 | if remote |
| `runCheckUi` | `npm run check:ui` | R | 2 | no |
| `runSmokeLocal` | `npm run smoke:local` | R | 2 | if keepTemp |
| `runEvalDemo` | `npm run eval:demo` | R | 2 | no |
| `runAgent` | `POST /api/agent/run` or `agent:run` | W | 3 | yes |

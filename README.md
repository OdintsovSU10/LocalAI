# LOCAL RAG

Локальный RAG/notebook-поиск по выбранным папкам из локальной сети.

## Что делает MVP

- Добавляет сетевую или локальную папку как источник через кнопку выбора папки.
- По кнопке индексирует PDF, TXT, MD и DOCX.
- Сохраняет производные Markdown-файлы только в выбранное локальное хранилище.
- Ведет manifest файлов, чтобы повторная индексация пропускала неизмененные документы.
- Дает быстрый поиск и простой режим чата по найденным фрагментам.

## Запуск

```powershell
.\scripts\start.ps1
```

Откройте:

```text
http://127.0.0.1:8787
```

## Конфиги

Live-файлы `config/settings.json` и `config/sources.yaml` локальные и не должны
коммититься. Для чистой установки используйте безопасные шаблоны:

- `config/settings.example.json` - local-first настройки без реальных ключей.
- `config/sources.example.yaml` - demo source без приватных путей.

Release staging checklist: `docs/release-file-inventory.md`.

Реальные токены, API keys и приватные remote URL задавайте через `.env` или env.
UI/API могут показывать только masked-состояние вроде `hasApiKey`.

## API auth

По умолчанию сервер слушает `127.0.0.1` и static UI открыт без токена.
Если задан `RAG_AUTH_TOKEN`, все `/api/*` endpoints требуют:

```text
Authorization: Bearer <token>
```

Browser API requests разрешены только с localhost/127.0.0.1 origins. Если
`RAG_HOST` не loopback и `RAG_AUTH_TOKEN` не задан, сервер пишет warning без
вывода токенов.

`RAG_REQUIRE_AUTH=true` принудительно включает проверку `/api/*`; при этом
`RAG_AUTH_TOKEN` тоже должен быть задан, иначе API вернет ошибку конфигурации.

## LLM privacy

По умолчанию routing local-only: `provider=local` использует только локальную
LM Studio. `provider=auto` остается local-first: сначала local, затем remote
только после local failure и только если remote context явно разрешен.

Remote context запрещен по умолчанию. При включении `RAG_ALLOW_REMOTE_CONTEXT`
или `RAG_REMOTE_LLM_ENABLED` найденные RAG-фрагменты документов могут быть
отправлены на remote endpoint. Remote-to-local fallback разрешен только при
`RAG_LLM_FALLBACK_TO_LOCAL_ON_REMOTE_ERROR=true`.

## Streaming chat API

`POST /api/chat` возвращает обычный JSON-ответ. `POST /api/chat/stream`
возвращает Server-Sent Events: `status`, `token`, `sources`, `meta`, `done`
или `error`. Streaming endpoint использует ту же privacy/routing policy, что
и `/api/chat`.

## Dify adapter

`POST /api/dify/retrieval` дает self-hosted Dify безопасный retrieval-слой поверх
`LOCAL_RAG`. Dify используется как optional workflow/UI/orchestration layer, а
не как второй RAG-core. Dify не получает прямой доступ к `data/`, `.env`,
`config/settings.json`, `config/sources.yaml` или пользовательским документам.

Endpoint требует отдельный токен:

```text
Authorization: Bearer <LOCALAI_DIFY_ADAPTER_TOKEN>
```

Задавайте `LOCALAI_DIFY_ADAPTER_TOKEN` только через env на стороне backend и
secret variable на стороне Dify. Не храните этот токен в prompts, live config,
логах, screenshots или git. Browser GET `/api/dify/retrieval` показывает только
non-secret diagnostic page.

Prompt pack для Dify лежит в `docs/dify-localai-prompt-pack/`, архив -
`docs/dify-localai-prompt-pack.zip`. Контракт adapter endpoint описан в
`docs/dify-localai-prompt-pack/contracts/localai-dify-retrieval-contract.md`.
Adapter возвращает только bounded excerpts, citation labels и безопасную
metadata без абсолютных локальных путей; remote context остается запрещенным,
пока это явно не разрешено политикой `LOCAL_RAG` и запросом Dify.

Для External Knowledge API в Dify регистрируйте base endpoint
`http://127.0.0.1:8787/api/dify`; Dify сам вызывает `/retrieval`. Для HTTP tool
используйте полный `http://127.0.0.1:8787/api/dify/retrieval`. POC checklist:
`docs/dify-localai-poc.md`.

## Eval cases

Локальные evals лежат в `evals/*.json`. Файл может содержать один кейс, массив
кейсов или объект `{ "cases": [...] }`.

Минимальный формат:

```json
{
  "id": "contract-payment-1",
  "sourceId": "source-id-from-ui",
  "question": "Какой срок оплаты?",
  "mustContain": ["30 дней"],
  "mustCite": true,
  "expectedFileHint": "Договор.pdf"
}
```

`expectedFileHint` сверяется с `title/path/citationLabel` найденных chunks и
используется для Recall@5 / Recall@10. Retrieval eval не вызывает LLM:

```powershell
npm run eval:retrieval
```

Для проверки полного ответа через запущенный API:

```powershell
npm run eval:llm
```

`eval:llm` вызывает `/api/chat` и использует ту же local-first privacy policy:
remote context не используется без явного разрешения.

## Local smoke and demo eval

The local smoke and demo eval gates use only `fixtures/demo-project` plus a
temporary runtime directory. They do not read live `.env`, `config/settings.json`,
`config/sources.yaml`, or `data/`, and they do not require LM Studio, Qdrant,
embeddings, reranker, or OCR.

```powershell
npm run smoke:local
npm run eval:demo
npm run eval:retrieval
npm run check:ui
npm run smoke:api
```

`eval:retrieval` is currently wired to the strict demo fixture gate. It fails
when zero retrieval cases are evaluated or when an `expectedFileHint` is missed
in the top five results. `smoke:local` cleans its temp runtime by default; use
`npm run smoke:local -- --keep-temp` only when debugging generated smoke state.
`check:ui` statically validates the frontend entrypoint, local assets, module
imports, key UI markers, and suspicious private defaults without reading live
config or opening a browser.
`smoke:api` starts a temporary local server, indexes `fixtures/demo-project`,
checks real HTTP API endpoints, auth on/off, chat fallback, SSE fallback,
preview, source summary, and Dify retrieval. The preview gate opens citations by
stable chunk target and verifies exact evidence for demo contract amount and
payment schedule, rather than accepting any file-level preview. The Dify gate
checks the dedicated adapter token, citations, privacy metadata, and response
redaction. It does not require LM Studio, Qdrant, OCR, live data, live config,
or secrets.

Manual browser acceptance checklist: `docs/ui-acceptance-checklist.md`. Run it
with a temp runtime such as `.tmp/ui-smoke-data` and the
`fixtures/demo-project` source; do not use live data/config/secrets.

## Metadata storage

По умолчанию metadata индекса хранится в JSON: `D:\LOCAL_RAG\data\state\manifest.json` и
`D:\LOCAL_RAG\data\state\chunks.json`.

Для SQLite включите:

```json
{
  "storage": {
    "metadataProvider": "sqlite",
    "sqlite": {
      "databasePath": "",
      "fallbackToJson": false
    }
  }
}
```

Пустой `databasePath` означает `D:\LOCAL_RAG\data\state\metadata.sqlite`. Для временного
запуска можно использовать env `RAG_METADATA_PROVIDER=sqlite`.

Миграция текущих JSON metadata в SQLite:

```powershell
npm run metadata:migrate:sqlite
```

## Vector store

`vectorStore.provider` поддерживает три режима:

- `qdrant` - Qdrant обязателен; embeddings пишутся в коллекцию, `vectors.json`
  не используется как основное хранилище.
- `auto` - сначала Qdrant; если он недоступен, используется `vectors.json`
  fallback с warning в diagnostics/job metadata.
- `json` - явный fallback/debug режим через `D:\LOCAL_RAG\data\state\vectors.json`.

Qdrant sync пересобирает точки безопасно в рамках одного `sourceId`: новые
vectors готовятся заранее, затем старые точки этого source удаляются и
заливаются новые.

## Хранение

По умолчанию данные лежат здесь:

```text
D:\LOCAL_RAG\data
```

Путь можно поменять в UI в блоке "Хранилище". Сетевые папки не изменяются и не захламляются Markdown-файлами.

## Следующий слой

Следующий этап: расширять eval-наборы, качество reranker и точность citation labels.

## LOCAL_RAG CURRENT STATE - DO NOT RESET

Last updated: 2026-06-26.

Important: LOCAL_RAG code is now in `C:\Users\odintsov.a.a\Desktop\Projects\LocalAI`.
Do not replace it with the first MVP/simple version. The current UI/API has many later changes.

### Hard rules

- Do not revert existing LOCAL_RAG changes unless explicitly asked.
- Do not mass-fix mojibake/encoding unless explicitly asked.
- Do not print, log, expose, or commit tokens/API keys.
- Real tokens and private remote URLs must be set through `.env`/env, not `config/settings.json`.
- UI/backend may expose only masked secret state such as `hasApiKey`; never log or commit secret values.
- After JS edits run:
  - `node --check apps/rag-ui/app.js`
  - `node --check apps/rag-api/src/server.js`

### Main files

- `apps/rag-ui/index.html`
- `apps/rag-ui/app.js`
- `apps/rag-ui/styles.css`
- `apps/rag-api/src/server.js`
- `apps/rag-api/src/llm.js`
- `apps/rag-api/src/store.js`
- `apps/rag-api/src/indexer.js`
- `apps/rag-api/src/search.js`

Server: `http://127.0.0.1:8787`

### Current UI state

- Dark UI with chat history in the left sidebar.
- Chat project selector supports auto mode.
- Settings are fullscreen.
- Settings tabs: `Источники`, `LLM`.
- Sources settings:
  - projects list on the left;
  - selected project settings in the main area;
  - indexed files tree in the right column;
  - Google context links;
  - add project form;
  - storage path form.
- File preview opens on the far right and has close button `#source-viewer-close`.

### Must-keep markers

These markers should exist. If they disappear, someone probably reset the project:

- `#source-viewer-close`
- `#indexed-files-panel`
- `#indexed-files-tree`
- `#source-add-shortcut`
- `state.addingSource`
- `Авто: определить по вопросу`
- `source-citation`
- `/api/sources/match`
- `ensureRemoteModelLoaded`
- `remoteRagContextLength = 16384`
- `matchedSource`

### Add project mode

The `+` button in `Проекты` opens a clean add-project mode.

Expected:

- selected project settings hidden;
- Google context hidden;
- indexed files panel hidden;
- no project card remains active;
- fields are empty;
- focus goes to `#source-title`;
- selecting a project exits add mode.

Relevant markers: `state.addingSource`, `focusNewSourceForm()`, `#new-source-panel`.

### Indexed files tree

`Индексированные файлы` is a right-column panel in Sources settings.

Expected:

- API endpoint: `/api/sources/:id/indexed-files`;
- reads manifest/chunks state, not a fresh network folder scan;
- shows folder hierarchy;
- shows total files, searchable files, and chunks;
- files without chunks are muted and show `нет фрагментов`;
- clicking a file opens the right file preview.

Current Balchug signal previously observed:

- `36 файлов · 17 с фрагментами · 653 фрагментов`

Relevant markers: `loadIndexedFiles()`, `renderIndexedFilesPanel()`, `buildIndexedFileTree()`.

### File preview close

The right preview panel must be closable.

Expected:

- button `#source-viewer-close` in the preview header;
- click calls `resetSourcePreview()`;
- hides `#source-viewer`;
- removes `.has-source-viewer` from `.app`.

### Inline citations

Assistant answer citations like `[1]`, `[2]` render as clickable chips and open source preview.

Relevant markers:

- `.source-citation`
- `renderMessageTextContent()`
- `sourcesByCitationNumber()`

### Auto project detection from chat

The chat can auto-select a project by question text.

Expected:

- Empty selector option says `Авто: определить по вопросу`.
- Example question:
  - `Demo Project, demo address - what are the main contract terms?`
- Server matches project by title/path tokens.
- Search then runs only inside the matched project.
- UI applies `payload.matchedSource`, switches selector to that project, and shows meta:
  - `Project: Demo Project (auto)`
- Generic questions without project hints should not randomly choose a project; ask user to specify project name/address.

Relevant markers:

- `/api/sources/match?q=...`
- `matchSourceForQuestion()`
- `publicMatchedSource()`
- `matchedSource`
- `applyMatchedSource()`
- `Авто по вопросу`
- `Проект определится из вопроса`

### LLM routing

Project policy is local-first and safe by default.

Expected:

- Default provider is `local`.
- Remote context is disabled unless `llm.remote.enabled` / `allowRemoteContext` is explicitly true.
- `provider=local`: only local LM Studio.
- `provider=remote`: remote LM Studio only, unless explicit remote-to-local fallback is enabled.
- `provider=auto`: local-first; remote is used only after local failure and only when remote context is enabled.
- `fallbackToLocalOnRemoteError=true` is required for remote-to-local fallback.
- `/api/chat` and `/api/chat/stream` return/use routing metadata: `selectedProvider`, `selectedBaseUrlKind`, `fallbackUsed`, `remoteContextAllowed`.
- Project summary, `/api/chat`, `/api/chat/stream`, and `eval:llm` must share this privacy policy.
- No silent remote usage just because remote token/base URL exist.
- Remote timeout is 300 seconds.

Remote LM Studio:

- base URL comes from `.env`/env or a placeholder example, never a private URL in docs;
- real token comes from `.env`/env and is represented in UI/API only as masked state;
- correct model: `qwen3.6-27b-mtp`;
- do not restore old typo `qwen36-27b-mtp`.

### Remote LM Studio preload

`apps/rag-api/src/llm.js` must keep remote model loading logic.

Expected:

- `ensureRemoteModelLoaded()`
- native LM Studio endpoints:
  - `GET /api/v0/models`
  - `POST /api/v1/models/load`
  - `POST /api/v1/models/unload`
- target RAG context length: `16384`;
- if model is loaded with too-small context, unload and reload with `context_length: 16384`.

Progress phases:

- `checking_model`
- `loading_model`
- `reloading_model`
- `compacting_context`

### LLM settings UI

Keep LLM tab simple:

- access fields;
- statuses;
- diagnostics;
- select lists for models.

Do not restore old controls unless explicitly requested:

- temperature;
- max tokens;
- batch size.

### RAG answer behavior

Expected:

- user prompt includes `/no_think`;
- remote `max_tokens` at least 3000;
- compact context profile: `maxSources: 8`, `maxCharsPerSource: 1400`;
- tight retry profile: `maxSources: 6`, `maxCharsPerSource: 900`;
- context-size errors retry with tighter context;
- answers cite facts inline with `[n]`;
- do not invent amounts, dates, periods, percentages, or conditions.

### Recovery checks

Run in `C:\Users\odintsov.a.a\Desktop\Projects\LocalAI`:

```powershell
rg -n "source-viewer-close|Авто: определить|indexed-files-panel|/api/sources/match|ensureRemoteModelLoaded|context_length|matchedSource|source-citation" apps/rag-ui/index.html apps/rag-ui/app.js apps/rag-ui/styles.css apps/rag-api/src/server.js apps/rag-api/src/llm.js
node --check apps/rag-ui/app.js
node --check apps/rag-api/src/server.js
```

Expected: all markers exist.

Quick auto-match check:

```powershell
$q=[uri]::EscapeDataString('Demo Project, demo address - what are the main contract terms?')
Invoke-RestMethod -Uri "http://127.0.0.1:8787/api/sources/match?q=$q" | ConvertTo-Json -Depth 5
```

Expected: confident match to `Demo Project`.

### Old MVP did not have these features

If a change removes any of these, stop and ask:

- fullscreen settings;
- right-column indexed files tree;
- auto project detection;
- remote LM Studio preload/reload;
- inline citations;
- closeable file preview;
- simplified LLM tab;
- Google context links.

---

## MVP

- Всегда делай минимально работающую версию
- Не добавляй фичи "на будущее"
- Сначала работает — потом улучшаем

## КРАТКОСТЬ

- Всегда отвечай на русском языке.
- Отвечай максимально сжато. Без пояснений и предисловий.
- Если запрашивают код — выводи только рабочие фрагменты кода в блоках, без текста.
- Изменения выдавай как *минимальный diff/patch* или как *конкретные вставки*.
- Не перечисляй, «что было сделано», если прямо не попросили.
- Если нужен текст — не более 5 пунктов, каждый ≤ 12 слов.

## .env

- НИКОГДА не изменять `.env` файлы (`frontend/.env`, `backend/.env`)
- Реальные ключи, токены и приватные URL добавляет только пользователь вручную через `.env`/env
- Production-секреты — только в protected secret storage (§18), не в config/settings.json/образах/коде/логах/БД

## Git

- Коммиты на русском, кратко (1-2 предложения)
- Без приписок "Generated with Claude Code" и "Co-Authored-By"

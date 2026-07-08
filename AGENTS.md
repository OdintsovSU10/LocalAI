# AGENTS.md

Практичные правила для работы с `LOCAL_RAG` в этом репозитории.

## Главные правила

- Не сбрасывать и не заменять текущий проект старым MVP.
- Не откатывать существующие изменения без прямой просьбы.
- Не трогать `data/`, `config` с секретами, `.env` и пользовательские документы.
- Не печатать, не логировать и не коммитить токены, ключи и приватные URL.
- Реальные токены нельзя хранить в `config/settings.json`; задавать только через `.env`/env.
- UI/backend могут показывать только masked state, но не секретные значения.
- Русскую mojibake-кодировку исправлять только отдельным этапом `encoding recovery`.
- После каждого изменения показывать краткий список изменённых файлов и как проверялось.

## Что сохранить

- Fullscreen settings, left chat history, project auto mode.
- Sources: projects, selected project settings, indexed files tree, Google context links.
- Right file preview with close button.
- Inline citations `[n]` as clickable source chips.
- Auto project detection from chat text.
- Remote LM Studio preload/reload with `context_length: 16384`.
- Simplified LLM tab: access fields, statuses, diagnostics, model lists.
- LLM routing is local-first by default.
- Remote context is forbidden until explicitly enabled in settings.
- Remote-to-local fallback is allowed only with `fallbackToLocalOnRemoteError=true`.
- Project summary, `/api/chat`, `/api/chat/stream` and `eval:llm` share one privacy policy.
- Do not expose remote tokens or API keys in UI, logs, tests, or docs.

## Важные маркеры UI/API

If these disappear, stop and check that the project was not reset:

- `#source-viewer-close`
- `#indexed-files-panel`
- `#indexed-files-tree`
- `#source-add-shortcut`
- `#new-source-panel`
- `state.addingSource`
- `focusNewSourceForm()`
- `loadIndexedFiles()`
- `renderIndexedFilesPanel()`
- `buildIndexedFileTree()`
- `.source-citation`
- `renderMessageTextContent()`
- `sourcesByCitationNumber()`
- `/api/sources/match`
- `/api/sources/:id/indexed-files`
- `matchSourceForQuestion()`
- `publicMatchedSource()`
- `applyMatchedSource()`
- `matchedSource`
- `ensureRemoteModelLoaded`
- `remoteRagContextLength = 16384`
- `context_length`
- `Авто: определить по вопросу`
- `Авто по вопросу`
- `Проект определится из вопроса`

## Проверка

Run from the repository root:

```powershell
npm run check
npm test
npm run check:ui
npm run eval:demo
```

For recovery checks, also search key markers in UI/API files before editing risky areas.
`npm run check:ui` statically verifies AGENTS.md UI/API markers.

---
name: local-rag-safe-change
description: >-
  Безопасные правки LOCAL_RAG без сброса на старый MVP. Use when editing
  apps/rag-ui, apps/rag-api, risky refactors, or when the user asks for a safe
  change, recovery check, or marker verification before/after edits.
---

# local-rag-safe-change

## When to use

- Любая правка `apps/rag-ui/**` или `apps/rag-api/**`.
- Рефакторинг chat, sources, settings, citations, indexed files, LLM tab.
- Подозрение на reset MVP или пропажу маркеров из `AGENTS.md`.
- Перед merge: убедиться, что diff минимальный и инварианты на месте.

## Workflow

1. **Не трогать:** `data/`, live `config/`, `.env`, пользовательские документы.
2. **Не откатывать** существующие изменения без явной просьбы.
3. Перед рискованной правкой — `rg` по ключевым маркерам (см. `AGENTS.md`, секция «Важные маркеры UI/API»).
4. Делать **минимальный diff**; не «упрощать» UI до старого MVP.
5. После правок — команды проверки ниже.
6. В ответе: список изменённых файлов + какие команды запускались.

## Stop signals

Если пропали `#source-viewer-close`, `#indexed-files-panel`, `source-citation`, `/api/sources/match`, `ensureRemoteModelLoaded`, `matchedSource`, строки авто-проекта — **остановиться** и восстановить.

## Проверка

Из корня репозитория:

```powershell
npm run check
npm test
npm run check:ui
```

Опционально — быстрый marker scan:

```powershell
rg -n "source-viewer-close|indexed-files-panel|/api/sources/match|ensureRemoteModelLoaded|matchedSource|source-citation" apps/rag-ui apps/rag-api/src/server.js apps/rag-api/src/llm.js apps/rag-api/src/source-match.js
```

## См. также

- `AGENTS.md`, `.cursor/rules/ui-invariants.mdc`
- `codex.md` — must-keep markers и recovery checks

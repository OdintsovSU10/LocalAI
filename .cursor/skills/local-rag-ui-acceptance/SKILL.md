---
name: local-rag-ui-acceptance
description: >-
  UI acceptance для LOCAL_RAG: static markers, API smoke, manual browser checklist.
  Use after UI/CSS/chat/sources/settings changes, before release, or when the user
  asks for UI smoke, acceptance test, or browser verification.
---

# local-rag-ui-acceptance

## When to use

- После правок `apps/rag-ui/**` (layout, chat, sources, settings, citations, preview).
- Перед релизом или после крупного UI-рефакторинга.
- Нужна проверка click-flow, layout, console — то, что `check:ui` не покрывает.

## Layers

| Слой | Что проверяет |
|------|----------------|
| `npm run check:ui` | Статические маркеры DOM/JS/API из `AGENTS.md` |
| `npm run smoke:api` | Реальные HTTP: auth, chat fallback, SSE, preview, summary |
| Manual browser | Визуал, клики, console — `docs/ui-acceptance-checklist.md` |

## Automated checks (сначала)

```powershell
npm run check
npm test
npm run check:ui
npm run smoke:api
```

## Manual browser (при необходимости)

1. Temp data, без live `.env` / `config/settings.json` / `data/` — см. checklist.
2. Запуск:

```powershell
$env:RAG_DATA_DIR = ".tmp/ui-smoke-data"
$env:RAG_REQUIRE_AUTH = "false"
$env:RAG_AUTH_TOKEN = ""
$env:RAG_ALLOW_REMOTE_CONTEXT = "false"
$env:RAG_REMOTE_LLM_ENABLED = "false"
$env:RAG_LLM_FALLBACK_TO_LOCAL_ON_REMOTE_ERROR = "false"
$env:RAG_VECTOR_STORE_ENABLED = "false"
$env:RAG_RERANKER_ENABLED = "false"
$env:RAG_OCR_ENABLED = "false"
npm run dev
```

3. Открыть `http://127.0.0.1:8787`.
4. Пройти сценарии из `docs/ui-acceptance-checklist.md`.
5. Результаты — в `docs/ui-acceptance-results.md` (NOT RUN, если браузер не открывали).

## Key manual scenarios

- First load: CSS, console, нет mojibake в затронутых областях.
- Sources: demo fixture, indexed files tree, source summary card.
- Chat: авто-проект (`Авто: определить по вопросу`), citations `[n]` → preview, `#source-viewer-close`.
- Settings: fullscreen, LLM tab (masked token, remote context warning).

## См. также

- `scripts/check-ui-static.mjs`
- `.cursor/rules/ui-invariants.mdc`, `AGENTS.md`

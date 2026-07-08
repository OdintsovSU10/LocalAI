---
name: local-rag-privacy-review
description: >-
  Privacy/security review для LOCAL_RAG: секреты, masked state, LLM routing,
  remote context. Use before merging LLM/settings/API changes, when reviewing
  logs, tests, docs, or when the user asks for a privacy or security check.
---

# local-rag-privacy-review

## When to use

- Правки `llm.js`, `llm-routing.js`, `store.js`, LLM tab, `/api/chat`, `/api/chat/stream`.
- Добавление логов, ошибок, API-ответов, тестовых фикстур, документации.
- Review PR с remote LM Studio, auth, fallback, project summary.
- Подозрение на утечку token/API key/private URL.

## Checklist

- [ ] Нет токенов, ключей, приватных remote URL в коде, логах, тестах, docs, коммитах.
- [ ] Реальные секреты только в `.env`/env, не в `config/settings.json`.
- [ ] UI/API показывают только masked state (`hasApiKey`, placeholder), не значения.
- [ ] **local-first** по умолчанию; remote context только при явном `allowRemoteContext` / `llm.remote.enabled`.
- [ ] Remote-to-local fallback только при `fallbackToLocalOnRemoteError=true`.
- [ ] Нет silent remote при наличии token/base URL.
- [ ] Единая политика: project summary, `/api/chat`, `/api/chat/stream`, `eval:llm`.
- [ ] `remoteRagContextLength = 16384`, preload через `ensureRemoteModelLoaded`.
- [ ] Не трогать `data/`, live config, `.env`.

## Review commands

```powershell
npm run check
npm test
```

Поиск подозрительных паттернов (исключая live ignored paths):

```powershell
rg -n "Bearer [A-Za-z0-9._-]{8,}|sk-[A-Za-z0-9]{10,}|api[_-]?key\s*[:=]\s*['\"][^'\"]+['\"]" apps tests scripts docs --glob "!**/.env*" --glob "!config/settings.json"
rg -n "hasApiKey|fallbackToLocalOnRemoteError|allowRemoteContext|remoteContextAllowed|selectedProvider" apps/rag-api apps/rag-ui
```

## Output format

```markdown
## Privacy review

- **Verdict:** PASS | WARN | FAIL
- **Findings:** (критичные → предупреждения)
- **Checked:** файлы и команды
```

## См. также

- `apps/rag-api/src/security.js`, `tests/security.test.mjs`, `tests/llm-routing.test.mjs`
- `.cursor/rules/privacy-security.mdc`, `AGENTS.md`

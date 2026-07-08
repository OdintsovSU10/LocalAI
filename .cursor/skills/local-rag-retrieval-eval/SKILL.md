---
name: local-rag-retrieval-eval
description: >-
  Retrieval и eval workflow для LOCAL_RAG: demo fixture, strict eval, LLM eval.
  Use when changing search, indexer, reranker, citations, evals/, fixtures/, run-evals.mjs,
  or when the user asks to run or fix eval:demo, eval:llm, retrieval metrics.
---

# local-rag-retrieval-eval

## When to use

- Правки `search*.js`, `indexer.js`, `reranker.js`, `citations.js`, `chat-scope.js`, BM25/reranker/pipeline.
- Новые или изменённые кейсы в `evals/`, `fixtures/demo-project/`.
- Проверка качества retrieval после индексации или query-логики.
- End-to-end ответов через `/api/chat` (`eval:llm`).

## Workflow

1. Demo fixture: `fixtures/demo-project/` + `evals/demo-project.json` — без реальных ключей и приватных путей.
2. Новый eval-кейс: `question`, `sourceId`, `mustContain`; опционально `mustCite`, `expectedFileHint`.
3. Сначала unit-тесты и syntax, затем retrieval demo, затем LLM eval (если нужен).
4. `eval:llm` — та же privacy policy, что `/api/chat` и `/api/chat/stream`.

## eval:llm gates

```powershell
$env:RAG_EVAL_ALLOW_LLM = "true"
# при необходимости:
# $env:RAG_AUTH_TOKEN = "..."   # только из env пользователя, не коммитить
# $env:RAG_EVAL_API_URL = "http://127.0.0.1:8787"
npm run eval:llm
```

Или: `node scripts/run-evals.mjs --with-llm --allow-llm`

## Проверка

```powershell
npm run check
npm test
npm run eval:demo
```

С LLM (сервер должен быть запущен):

```powershell
$env:RAG_EVAL_ALLOW_LLM = "true"
npm run eval:llm
```

Опционально API smoke:

```powershell
npm run smoke:api
```

## См. также

- `scripts/run-evals.mjs`, `scripts/eval-utils.mjs`
- `tests/demo-eval.test.mjs`, `tests/search*.test.mjs`
- `.cursor/rules/rag-eval-workflow.mdc`

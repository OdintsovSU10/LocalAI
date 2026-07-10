# Dify + LOCAL_RAG prompt pack

Пакет промтов для интеграции, где Dify используется как visual workflow / chatflow слой, а `LOCAL_RAG` остается владельцем документов, индекса, поиска, цитат и privacy policy.

## Как использовать

1. Поднимите Dify self-hosted отдельно от `LOCAL_RAG`.
2. Не давайте Dify прямой доступ к `data/`, `.env`, `config/settings.json`, `config/sources.yaml` и пользовательским документам.
3. В Dify заведите External Knowledge API / HTTP tool, который ходит только в безопасный adapter endpoint.

Для External Knowledge API укажите base endpoint. Dify сам вызовет `/retrieval`:

```text
http://127.0.0.1:8787/api/dify
```

Для HTTP tool используйте полный URL:

```text
POST http://127.0.0.1:8787/api/dify/retrieval
```

4. Используйте промты из `prompts/` в Dify nodes:

- `01-system-localai-rag.md` - system prompt главного chatflow.
- `02-query-rewriter.md` - node для подготовки retrieval query.
- `03-retrieval-result-normalizer.md` - node для нормализации найденных chunks.
- `04-answer-synthesizer.md` - node финального ответа с clickable-style citation markers.
- `05-privacy-router.md` - node/gate для local-first privacy decisions.
- `06-tender-audit-workflow.md` - доменный workflow для тендерного анализа.
- `07-no-evidence-refusal.md` - fallback, когда доказательств недостаточно.
- `08-eval-and-regression-prompts.md` - проверочные промты и expected behavior.

5. Используйте `contracts/localai-dify-retrieval-contract.md` как контракт между Dify и adapter endpoint.
6. Для POC-canvas используйте `templates/dify-chatflow-poc-blueprint.json`: он описывает маршрут "вопрос -> privacy gate -> query rewrite -> retrieval -> normalizer -> optional human gate -> answer".

## Принцип интеграции

Dify не индексирует live-документы и не хранит приватный контекст. Он отправляет вопрос и необязательные hints в adapter. Adapter вызывает существующие безопасные endpoints `LOCAL_RAG`, например `/api/search` и `/api/sources/match`, и возвращает только ограниченные excerpts, metadata и citation labels.

## Privacy baseline

- Local-first по умолчанию.
- Remote context запрещен, пока пользователь явно не включил его в настройках `LOCAL_RAG`.
- Токены и приватные URL не показывать в UI, prompts, logs, evals и docs.
- Если retrieval пустой или сомнительный, ответ должен честно сказать, что доказательств недостаточно.
- Dify не должен обходить политику `/api/chat`, `/api/chat/stream`, `eval:llm` и project summary.

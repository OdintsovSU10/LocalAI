# Dify optional workflow POC

Цель: проверить Dify как visual workflow / orchestration layer поверх `LOCAL_RAG`, не заменяя текущий RAG core.

## Граница ответственности

- `LOCAL_RAG` владеет документами, индексами, Qdrant/vector fallback, reranker, source preview, citations, project auto-detection, privacy policy и LLM routing.
- Dify владеет только workflow canvas: query rewrite, routing, human-in-loop, answer synthesis и публикация отдельных chatflow/API сценариев.
- Dify не индексирует live-документы и не получает доступ к `data/`, `.env`, `config/settings.json`, `config/sources.yaml`, markdown cache, PDF/DOCX и пользовательским папкам.

## Self-host setup

1. Поднимите Dify self-hosted отдельно от `LOCAL_RAG`.
2. Убедитесь, что Dify может достучаться до `LOCAL_RAG` backend по loopback/LAN адресу.
3. Если Dify запущен в Docker, `127.0.0.1` внутри контейнера не указывает на host с `LOCAL_RAG`. Используйте host route вроде `host.docker.internal` или отдельный LAN address.
4. Если self-host Dify блокирует private/loopback outbound requests через SSRF proxy, настройте узкое разрешение только до host/port `LOCAL_RAG`. Не отключайте SSRF protection глобально ради POC.
5. Создайте отдельный secret для adapter:

```powershell
$env:LOCALAI_DIFY_ADAPTER_TOKEN="replace-with-local-secret"
npm run start
```

Не храните реальный token в prompts, screenshots, docs, `config/settings.json` или git.

## External Knowledge API mode

В Dify External Knowledge API регистрируйте endpoint без `/retrieval`:

```text
http://127.0.0.1:8787/api/dify
```

Dify сам вызывает:

```text
POST http://127.0.0.1:8787/api/dify/retrieval
Authorization: Bearer <LOCALAI_DIFY_ADAPTER_TOKEN>
```

`knowledge_id` задавайте как `sourceId` из `LOCAL_RAG` или как точный title/alias источника. Adapter также принимает `sourceId` напрямую для HTTP tool workflows.

## HTTP tool mode

Для HTTP Request node используйте полный URL:

```text
POST http://127.0.0.1:8787/api/dify/retrieval
```

Headers:

```text
Authorization: Bearer {{LOCALAI_DIFY_ADAPTER_TOKEN}}
Content-Type: application/json
```

Body шаблоны лежат в `docs/dify-localai-prompt-pack/templates/`.

## Canvas route

Минимальный POC route:

```text
Start
  -> Privacy router
  -> Query rewriter
  -> LOCAL_RAG retrieval adapter
  -> Retrieval result normalizer
  -> Human gate if evidence is missing or action is risky
  -> Answer synthesizer with citation markers
```

Use `docs/dify-localai-prompt-pack/templates/dify-chatflow-poc-blueprint.json` as the manual canvas blueprint. It is intentionally not a Dify import dump, so it stays stable across Dify versions.

## Acceptance checklist

- Dify request to `POST /api/dify/retrieval` without adapter token returns `401`.
- `RAG_AUTH_TOKEN` alone is not accepted as the Dify adapter token.
- `knowledge_id` maps to a LOCAL_RAG `sourceId` or source title.
- Response contains `records[]` with `content`, `score`, `title`, `metadata.citationLabel`, `metadata.sourceId`, `metadata.chunkId`.
- Response does not contain absolute local paths, temp runtime roots, adapter token, `.env`, live config or full files.
- Empty retrieval routes to no-evidence refusal.
- `privacy.remoteContextAllowed` remains `false` unless both LOCAL_RAG settings and Dify request explicitly allow it.
- Final answer cites document claims with `[n]` markers from retrieval metadata.
- Risky write/index/delete/settings actions require explicit human confirmation.

## Local verification

```powershell
npm run check
npm test
npm run check:ui
npm run smoke:api
npm run eval:demo
```

`smoke:api` uses only `fixtures/demo-project` and a temp runtime. It does not read live `.env`, live config, `data/`, LM Studio, Qdrant, OCR or real Dify.

## References

- Dify External Knowledge API: `https://docs.dify.ai/en/cloud/use-dify/knowledge/external-knowledge-api`
- Dify HTTP Request node: `https://docs.dify.ai/en/cloud/use-dify/nodes/http-request`
- Dify Human Input flow: `https://docs.dify.ai/en/self-host/use-dify/nodes/hitl-api-integration-flow`

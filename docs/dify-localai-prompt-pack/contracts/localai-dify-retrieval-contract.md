# LocalAI -> Dify External Knowledge contract

Этот контракт описывает безопасный adapter endpoint между Dify и `LOCAL_RAG`.

## Adapter endpoint

External Knowledge API registration endpoint:

```text
http://127.0.0.1:8787/api/dify
```

Dify calls `/retrieval` under that endpoint. HTTP tool workflows can call the full URL directly:

```http
POST /api/dify/retrieval
Authorization: Bearer ${LOCALAI_DIFY_ADAPTER_TOKEN}
Content-Type: application/json
```

Token должен задаваться только через env. Не хранить его в Dify prompt text, git, `config/settings.json` или screenshots.

## Request

External Knowledge API shape:

```json
{
  "knowledge_id": "optional source id or source alias",
  "query": "string",
  "retrieval_setting": {
    "top_k": 8,
    "score_threshold": 0.15
  },
  "metadata_condition": {
    "logical_operator": "and",
    "conditions": []
  }
}
```

HTTP tool shape:

```json
{
  "query": "string",
  "knowledge_id": "optional source id or source alias",
  "sourceId": "optional explicit LOCAL_RAG source id",
  "top_k": 8,
  "score_threshold": 0.15,
  "hints": {
    "project": "optional project name from Dify variable",
    "questionLanguage": "ru",
    "needFreshIndex": false
  },
  "privacy": {
    "allowRemoteContext": false,
    "requestedBy": "dify-chatflow"
  }
}
```

## Adapter behavior

1. Reject requests without adapter token.
2. Never read `data/`, `.env`, live config, markdown cache, PDFs or DOCX directly.
3. Resolve source through `sourceId`, `knowledge_id`, or `GET /api/sources/match?q=...`.
4. Call `GET /api/search?q=&sourceId=&limit=`.
5. Return excerpts only, not full files.
6. Include stable citation metadata: `sourceId`, `chunkId`, `fileId`, `path`, `citationLabel`.
7. Preserve `LOCAL_RAG` privacy decisions. If remote context is forbidden, tell Dify in metadata.
8. Accept Dify `retrieval_setting.top_k` / `retrieval_setting.score_threshold`; top-level HTTP tool aliases are also supported.
9. Treat `metadata_condition` as advisory in this POC unless it maps to `sourceId` / `knowledge_id`; return a warning when conditions were received.

## Response

```json
{
  "query": "normalized retrieval query",
  "source": {
    "sourceId": "source-xxxxxxxxxx",
    "title": "Project title",
    "matchedAutomatically": true
  },
  "records": [
    {
      "content": "short excerpt from indexed chunk",
      "score": 0.82,
      "title": "Contract.pdf",
      "metadata": {
        "sourceId": "source-xxxxxxxxxx",
        "chunkId": "chunk-id",
        "fileId": "file-id",
        "path": "relative/path/Contract.pdf",
        "citationLabel": "[1]",
        "page": 12
      }
    }
  ],
  "privacy": {
    "localFirst": true,
    "remoteContextAllowed": false,
    "policySource": "LOCAL_RAG"
  },
  "warnings": []
}
```

## Dify mapping

Map every `records[i]` item into Dify context variables:

- `content` -> evidence text
- `score` -> retrieval score
- `metadata.citationLabel` -> citation marker
- `metadata.path` -> source display path
- `metadata.sourceId` + `metadata.chunkId` -> preview target

The final answer prompt must cite claims using `citationLabel` from metadata.

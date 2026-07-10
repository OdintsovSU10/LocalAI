# Node prompt: retrieval result normalizer

Назначение node: привести ответ adapter endpoint к компактному evidence bundle для финального LLM node.

Input variables:

```text
{{retrieval_json}}
{{user_question}}
```

Prompt:

```text
Ты нормализуешь результаты LOCAL_RAG retrieval. Не отвечай пользователю. Верни только JSON.

Правила:
1. Используй только records из retrieval_json.
2. Удали дублирующиеся excerpts, если они почти одинаковые.
3. Сохрани citationLabel, sourceId, chunkId, file path и score.
4. Не раскрывай абсолютные локальные пути, если они пришли случайно. Оставь только относительный path/title.
5. Отсортируй evidence по релевантности и полезности для user_question.
6. Если records пустой, верни hasEvidence=false.

Верни JSON:
{
  "hasEvidence": true,
  "sourceTitle": "...",
  "evidence": [
    {
      "citation": "[1]",
      "excerpt": "...",
      "title": "...",
      "path": "...",
      "score": 0.82,
      "previewTarget": {
        "sourceId": "...",
        "chunkId": "..."
      }
    }
  ],
  "warnings": []
}

Данные:
user_question={{user_question}}
retrieval_json={{retrieval_json}}
```


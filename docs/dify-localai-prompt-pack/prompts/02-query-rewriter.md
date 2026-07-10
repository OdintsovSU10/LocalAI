# Node prompt: retrieval query rewriter

Назначение node: превратить пользовательский вопрос в безопасный retrieval request для `LOCAL_RAG`.

Input variables:

```text
{{user_question}}
{{selected_project}}
{{chat_history_summary}}
{{privacy_remote_context_allowed}}
```

Prompt:

```text
Ты готовишь запрос к локальному RAG-поиску. Не отвечай пользователю. Верни только JSON.

Задача:
1. Извлеки главный поисковый запрос из вопроса пользователя.
2. Сохрани важные сущности: проект, договор, тендер, сумма, дата, номер, организация, файл.
3. Если пользователь явно указал проект, заполни sourceHint.
4. Если проект не указан, оставь sourceHint пустым и поставь autoDetectProject=true.
5. Не добавляй секреты, токены, приватные URL и локальные абсолютные пути.
6. Не расширяй вопрос догадками, которые не следуют из текста.

Верни JSON:
{
  "query": "...",
  "sourceHint": "...",
  "autoDetectProject": true,
  "topK": 8,
  "language": "ru",
  "mustCite": true,
  "privacy": {
    "allowRemoteContext": false
  }
}

Данные:
user_question={{user_question}}
selected_project={{selected_project}}
chat_history_summary={{chat_history_summary}}
privacy_remote_context_allowed={{privacy_remote_context_allowed}}
```

Expected behavior:

- Для "найди срок оплаты по договору Альфа" query должен содержать "срок оплаты договор Альфа".
- Для "что по проекту?" без проекта autoDetectProject=true.
- Если пользователь вставил токен или URL, не копировать его в query без необходимости.


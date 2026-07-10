# Node prompt: privacy router

Назначение node: принять безопасное routing decision перед LLM/retrieval шагом.

Input variables:

```text
{{user_question}}
{{localai_policy_json}}
{{dify_runtime_json}}
{{requested_action}}
```

Prompt:

```text
Ты privacy gate для Dify workflow поверх LOCAL_RAG. Не отвечай пользователю. Верни только JSON.

Правила:
1. LOCAL_RAG policy имеет приоритет над Dify settings.
2. По умолчанию localFirst=true и remoteContextAllowed=false.
3. Remote context allowed только если localai_policy_json явно содержит remoteContextAllowed=true.
4. Remote-to-local fallback allowed только если localai_policy_json явно содержит fallbackToLocalOnRemoteError=true.
5. Если requested_action требует записи, индексации, удаления, изменения settings или запуска агента, поставь requiresUserConfirmation=true.
6. Если question содержит секреты или приватные URL, поставь containsSensitiveInput=true и redactInLogs=true.
7. Не возвращай сам секрет в JSON. Используй только masked state.

Верни JSON:
{
  "localFirst": true,
  "remoteContextAllowed": false,
  "fallbackToLocalOnRemoteError": false,
  "allowRetrieval": true,
  "allowRemoteLlm": false,
  "requiresUserConfirmation": false,
  "containsSensitiveInput": false,
  "redactInLogs": true,
  "reason": "..."
}

Данные:
user_question={{user_question}}
localai_policy_json={{localai_policy_json}}
dify_runtime_json={{dify_runtime_json}}
requested_action={{requested_action}}
```


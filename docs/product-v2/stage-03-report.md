# Stage 03 report

Status: PARTIAL — код и тесты написаны, прогон выполняется на машине владельца

## Baseline
- Stage 02 PASS (`0fbd870`): единый `answerQuestion`; история чата только в браузере (`localStorage`), сервер получает `question/sourceId/contextSourceId`, модель не видит предыдущих реплик.

## Changed
- `apps/rag-api/src/conversation/migrations/001_conversations.sql` -> таблицы `conversations`, `messages`, `turn_state`
- `apps/rag-api/src/conversation/app-state-db.js` -> `node:sqlite` (WAL, foreign keys), идемпотентные нумерованные миграции с `schema_migrations`
- `apps/rag-api/src/conversation/conversation-store.js` -> create/get/list/update (архив)/delete, `appendMessage`, атомарный `appendTurn` (пара вопрос/ответ + закрепление проекта), `listMessages`, идемпотентный `importLegacySession`; цитаты хранятся только как id и расположение (`safeCitations`), без путей и текста документов
- `apps/rag-api/src/conversation/chat-turn.js` -> загрузка диалога для чата (404 для неизвестного), сохранение хода со статусом ответа (`unverified` / `insufficient_evidence` / `clarification_required` / `system_error`) и trace id
- `apps/rag-api/src/answer-core/conversation-turns.js` -> ограниченный контекст: последние 6 ходов, ответы ≤600 символов без старых `[n]`; детерминированное правило follow-up для поискового запроса
- `apps/rag-api/src/answer-core/answer-question.js`, `chat-llm.js`, `chat-prompt.js` -> необязательный `conversationContext`: закреплённый проект как `contextSourceId`, история как предыдущие реплики в промпте; без диалога промпт и запрос не меняются
- `apps/rag-api/src/routes/conversations.js` -> `GET/POST /api/conversations`, `POST /api/conversations/import`, `GET/PATCH/DELETE /api/conversations/:id`, `GET/POST /api/conversations/:id/messages` (канал `web`)
- `apps/rag-api/src/server.js` -> ленивое открытие `app-state.sqlite`; `/api/chat` и `/api/chat/stream` принимают `conversationId`, сохраняют ход и возвращают `conversationId` + `turn`
- `apps/rag-api/src/paths.js` -> `appStateSqlitePath()`
- `apps/rag-ui/app.js` -> при первом вопросе сессия импортируется на сервер (`serverConversationId`), `conversationId` уходит в `/api/chat/stream`; при 404 — повторный импорт и один повтор; архив/восстановление/удаление дублируются на сервер; при старом сервере UI работает как раньше
- Тесты: `tests/conversation-store.test.mjs`, `tests/conversation-turns.test.mjs`, дополнения `tests/answer-core.test.mjs` (в `npm test`); `tests/conversation-api.contract.mjs` (`npm run test:conversation-contract`); fake LLM записывает полученные сообщения (`tests/helpers/chat-runtime.mjs`)
- `package.json` -> новые модули в `npm run check`, скрипт `test:conversation-contract`

## Architecture decisions
- ADR-002 реализован: `state/app-state.sqlite` отдельно от metadata provider; открывается при первом обращении, поэтому сбой этой БД не ломает обычный чат без `conversationId`.
- Сохранение хода — в HTTP-адаптере, answer-core остаётся без побочных эффектов хранения.
- Закреплённый проект диалога действует как `contextSourceId`: явный проект в запросе и авто-определение по вопросу имеют приоритет (поведение Stage 02 сохранено).
- Follow-up (начинается с «а/и/тоже/ещё…» или ≤4 слов) ищется вместе с предыдущим вопросом диалога — детерминированно, без LLM.
- История в промпте не несёт номеров `[n]` старых источников, чтобы модель не ссылалась на чужой список evidence.
- UI: localStorage остаётся источником отображения (мягкая миграция); сервер хранит диалог для multi-turn. Полный переход UI на серверный список — отдельный шаг.
- Внешние id пользователей (`external_user_id_hash`) предусмотрены схемой, хеширование появится вместе с Telegram (Stage 08).

## Tests / evidence
Машина разработки: `node --check` новых и изменённых файлов -> PASS.

На машине владельца (NOT RUN здесь):
- `npm run check`, `npm test` (включая conversation-store / conversation-turns / answer-core)
- `npm run check:ui`, `npm run eval:demo`, `npm run eval:product`, `npm run mcp:test`, `npm run smoke:api`
- `npm run test:chat-contract` — ответы без `conversationId` обязаны совпасть с `70552d6`
- `npm run test:conversation-contract` — follow-up без проекта (JSON и SSE), изоляция истории между диалогами, 404, импорт, перезапуск, архив/удаление

## Metrics before/after
- `eval:product` не меняется (retrieval без диалога не затронут).

## Security/privacy
- В app-state не пишутся пути файлов, тексты фрагментов и секреты; цитаты — id, метки и page/sheet/row.
- Тексты вопросов и ответов хранятся локально в `stateDir()` (как раньше в localStorage).
- Маршруты `/api/conversations*` проходят через существующий API security middleware.

## Known limitations
- Путь к `app-state.sqlite` фиксируется при первом открытии; смена `dataDir` в настройках вступает в силу после перезапуска сервера.
- `turn_state` (незавершённые уточнения) создан, но заполняется в Stage 05.
- UI не загружает список диалогов с сервера; переименование чата на сервер не синхронизируется.
- Нет backup/recovery для app-state (Stage 09).

## Manual checks still required
- Браузер: новый чат → вопрос с проектом → follow-up без проекта → перезагрузка страницы → ещё follow-up; архив и удаление чата.

## Ready for next stage?
NO
Reason: acceptance подтверждается прогоном на машине владельца.

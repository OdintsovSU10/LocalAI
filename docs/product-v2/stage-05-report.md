# Stage 05 report

Status: PARTIAL — код и тесты написаны, прогон выполняется на машине владельца

## Baseline
- Stage 04 PASS (`ac5e4e5`). Проект определялся только авто-подбором (`resolveChatSourceScope`): при двух одинаково подходящих проектах («Какой аванс по Сокольникам?») вопрос уходил в поиск по всем проектам без уточнения. `01-eval-baseline.md`: clarification recall 0.000, precision NOT_AVAILABLE.

## Changed
- `apps/rag-api/src/answer-core/query-planner.js` -> `planQuery` (QueryPlan: intent, domain, sourceScope, entities, timeScope, versionPolicy, retrievalMode, needsClarification, clarification), `resolveClarificationReply`, `projectClarification`, `planSummary`
- `apps/rag-api/src/answer-core/answer-question.js` -> планировщик перед retrieval; при неоднозначном проекте — ответ-уточнение без поиска и LLM; ответ на уточнение продолжает исходный вопрос для выбранного проекта; при сбое планировщика — прежнее разрешение scope; план возвращается рядом с payload
- `apps/rag-api/src/conversation/conversation-store.js` -> `getPendingClarification` / `setPendingClarification` (`turn_state`)
- `apps/rag-api/src/conversation/chat-turn.js` -> незавершённое уточнение в контексте диалога; сохранение сводки плана в ходе; уточнение сохраняется, любой другой ответ его снимает
- `apps/rag-api/src/server.js` -> план передаётся в сохранение хода (JSON и SSE)
- `apps/rag-ui/app.js`, `apps/rag-ui/locus-redesign.css` -> кнопки вариантов проекта под сообщением-уточнением (ответ = название проекта, тап-зона 44 px, `prefers-reduced-motion`)
- `scripts/product-eval/retrieval.mjs` -> уточнение в eval предсказывается тем же планировщиком
- Тесты: `tests/query-planner.test.mjs`; дополнения `tests/answer-core.test.mjs`, `tests/conversation-store.test.mjs`, `tests/conversation-api.contract.mjs`
- `package.json` -> планировщик в `npm run check`

## Architecture decisions
- Планировщик детерминированный (`rules/1`); LLM-планировщик не добавлен — правил достаточно для текущих сценариев, а схемная LLM-подстраховка появится, если eval покажет пробелы. Прежний авто-подбор остаётся внутри планировщика и как fallback при его сбое.
- Уточнение только когда без него нельзя выбрать scope: ≥ 2 проекта совпадают по названию с сопоставимым счётом, нет уверенного совпадения, нет явного проекта в запросе, закреплённый проект диалога не среди кандидатов. «По всем проектам» не сужается и не уточняется.
- Не более одного уточнения на ход: новое заменяет незавершённое, любой другой ответ снимает его. Ответ выбирает вариант номером, явным проектом или коротким названием (≤ 6 слов, без «?»); полноценный новый вопрос с названием проекта — это новый вопрос.
- Уточнение одинаково для web и Telegram: `payload.clarification` (варианты с номерами и названиями), ответ — обычное сообщение (номер или название); web показывает кнопки, Telegram (Stage 08) — inline-кнопки.
- Версии документов: `versionPolicy` = `current` / `historical` («первоначальная редакция», «до ДС») / `all` («история изменений»). Уточнение по редакции не задаётся: выбор редакции без вопроса пользователю применит Stage 06 на основе фактов Stage 04.
- План не добавляется в ответ API (формат ответа без уточнения прежний — контракт Stage 02); сводка плана без текста вопроса сохраняется в ходе диалога.

## Acceptance (Prompt Pack Stage 05) -> доказательство
- Тесты на ambiguous project, follow-up, all-projects, version request -> `tests/query-planner.test.mjs`.
- Clarification обрабатывается одинаково web/TG -> структура `clarification` + ответ обычным сообщением; `tests/conversation-api.contract.mjs` (JSON и SSE, ответ названием и номером).
- Planner failure имеет deterministic fallback -> тест с падающим планировщиком в `tests/answer-core.test.mjs`.
- Старый auto-match остаётся fallback и не исчезает молча -> используется внутри планировщика и при его сбое; сценарии Stage 02 без неоднозначности отвечают как раньше (`npm run test:chat-contract`).
- Не спрашивать проект, если диалог уже закрепил scope -> тест «pinned среди кандидатов».
- Максимум одно уточнение, после ответа — возобновление исходного плана -> тесты планировщика и HTTP-контракт.

## Tests / evidence
Машина разработки: `node --check` -> PASS; чистые вызовы планировщика и `answerQuestion` на сценариях тестов -> совпадают с ожиданиями; 67 регулярных выражений статического UI-теста совпадают. `npm test` и контракты здесь не запускались.

На машине владельца (NOT RUN здесь):
- `npm run check`, `npm test`, `npm run check:ui`, `npm run eval:demo`, `npm run eval:product`, `npm run mcp:test`, `npm run smoke:api`
- `npm run test:chat-contract`, `npm run test:conversation-contract`, `npm run test:evidence-contract`

## Metrics before/after (`npm run eval:product`, расчёт офлайн-модулей)
| Метрика | До | После |
|---|---|---|
| Clarification recall | 0.000 (0/1) | 1.000 (1/1) |
| Clarification precision | NOT_AVAILABLE | 1.000 (1/1) |
| Project selection accuracy | 1.000 (16/16) | 1.000 (16/16) |
| Recall@5 / file Recall@5 / MRR / citation / current version | 0.870 / 1.000 / 0.661 / 0.400 / 0.000 | без изменений (retrieval — Stage 06) |

## Security/privacy
- В `turn_state` хранится исходный вопрос и варианты (id и названия проектов) — те же данные, что уже есть в сообщениях диалога; сводка плана в ходе не содержит текста вопроса.
- Local-first routing и UI-маркеры не менялись.

## Known limitations
- Неоднозначность определяется только по названиям проектов (авто-подбор); неоднозначность документа/редакции не уточняется.
- Кнопки уточнения не сохраняются в localStorage: после перезагрузки страницы можно ответить номером или названием текстом.
- `subquestions` и `documentScope` в плане пока пустые (используются в Stage 06).

## Ready for next stage?
NO
Reason: acceptance подтверждается прогоном на машине владельца.

# Stage 07 report

Status: IMPLEMENTED — ждёт независимой проверки на машине владельца

## Baseline
- Stage 06 PASS (`ac17929`). Модель писала ответ свободным текстом по пакету доказательств; числа, типы значений, редакции, проект и ссылки [n] не проверялись.
- `eval:product`: retrieval-метрики Stage 06; `answer.*` и `verifier.*` — NOT_AVAILABLE.

## Changed
- Новые модули `apps/rag-api/src/answer-core/`:
  - `claim-numbers.js` — числа с единицами (процент, дни/недели/месяцы/годы, рубли с тыс/млн, даты, календарный год, доля `1/300`); коды и ссылки (B30, КС-2, п. 3.1, № 15-П) числами не считаются;
  - `claim-checks.js` — детерминированные проверки утверждения: метки, проект, цель цитаты, числа и единицы, тип значения, заменённая редакция, отметка конфликта;
  - `answer-draft.js` — метки E1..En, промпт и JSON-схема черновика, разбор ответа модели;
  - `answer-verifier.js` — выбор verifier-модели (`separate_model` / `same_model` / `off`), промпт, JSON-схема, разбор вердикта;
  - `answer-renderer.js` — финальный текст, статус, источники;
  - `verified-answer.js` — конвейер: черновик → проверки → verifier → до `maxRepairs` исправлений → рендер.
- `answer-question.js`:
  - при `answering.verified` ответ идёт через `runVerifiedAnswer`;
  - `retrieveMore` для исправлений — поиск и пакет в том же scope;
  - статусы у всех видов ответа;
  - черновик не стримится.
- `chat-llm.js` -> `runChatLlm` принимает свой построитель сообщений и `responseFormat`; `llm.js` -> `response_format` в запросе.
- `evidence-packet.js`, `evidence/version-graph.js` -> для вопроса о цене (или итоге сметы) в пакет попадает вторая сторона межд документного конфликта. Она ставится после первых трёх элементов и не добавляется в обзор, поэтому метрики Stage 06 не изменились.
- `rag-metadata.js` -> `timings.verifyMs` (только у проверенных ответов).
- `conversation/chat-turn.js` -> статус ответа и сводка проверки (коды, без текста) сохраняются с ходом.
- `store.js`, `server.js`:
  - настройки `answering { verified, maxRepairs }` и `verifier { mode, model, maxTokens, timeoutSeconds }`;
  - env `RAG_VERIFIED_ANSWERING`, `RAG_VERIFIER_MODE`, `RAG_VERIFIER_MODEL` действуют только при чтении и не сохраняются в `settings.json`;
  - PUT `/api/settings` принимает обе секции.
- UI:
  - `apps/rag-ui/app.js` — статусы «Проверяю ответ по документам…», «Уточняю ответ…», «Собираю проверенный ответ…» и бейдж статуса под ответом;
  - `modules/formatting-helpers.js` — `answerStatusBadge`;
  - `locus-redesign.css` — `.answer-status-*` на токенах `--status-*`.
- Eval:
  - `evals/verifier/claims-core.json` — 28 размеченных утверждений: 12 верных и 16 ложных (числовые, редакция, чужой проект, цитата, смысловые);
  - `scripts/product-eval/verifier-eval.mjs`;
  - `run-product-evals.mjs` считает `verifier.falsePassRate` и `falseRejectRate`, печатает разбивку по категориям; `--verifier-llm` добавляет verifier-модель (`RAG_LLM_BASE_URL`, `RAG_VERIFIER_MODEL` / `RAG_LLM_MODEL`).
- Тесты:
  - новые `tests/claim-checks.test.mjs`, `tests/answer-draft.test.mjs`, `tests/verified-answer.test.mjs`, `tests/verified-answer.contract.mjs` (`npm run test:verified-contract`);
  - дополнения в `answer-core`, `conversation-store`, `frontend-helpers`, `product-eval`;
  - `tests/helpers/chat-runtime.mjs`: `startApi({ verifiedAnswering, verifierMode })` (по умолчанию выключено ради контракта Stage 02); фейковая LLM отвечает на схемы черновика и вердикта.
- Документы: `adr/ADR-004-verified-answering.md`, этот отчёт, ledger. `package.json` — новые модули в `npm run check`, `test:verified-contract`.

## Architecture decisions
См. ADR-004. Коротко:
- **Проверки до модели и без неё.** Детерминированные проверки идут до verifier-модели и не зависят от неё: ложный пропуск модели не выпускает неверное число, единицу, проект или устаревшую редакцию.
- **Какая модель проверяет:**
  - целевая — отдельная модель;
  - та же модель в изолированном прогоне — только по явной настройке `same_model`;
  - без verifier-модели ответ честно помечен уровнем `hard_checks`: «Числа и ссылки сверены с документами».
- **Финальный текст** собирается только из подтверждённых утверждений и номеров ссылок. Текст модели вне утверждений (`summary`, заметки verifier-а) не показывается.
- **Цикл исправления ограничен:** 1 по умолчанию, максимум 2. После лимита остаётся `insufficient_evidence`, а не бесконечный цикл.

## Acceptance (Prompt Pack Stage 07) -> доказательство
- **Ни одно неподтверждённое существенное утверждение не попадает в финальный ответ** (синтетические adversarial-тесты):
  - `tests/verified-answer.test.mjs` — verifier пропускает всё, а 4 ложных утверждения из 6 всё равно не показаны;
  - verifier отклоняет смысловое утверждение, которое проверки пропустили;
  - в контракте `ЛОЖЬ` / `ОПРОВЕРГНИ` дают `insufficient_evidence`.
- **Числовые негативные тесты** (3% vs 30 дней, 3 года vs 30 дней, сумма vs процент): `tests/claim-checks.test.mjs`, `tests/verified-answer.test.mjs`, категория `numeric` в `evals/verifier` — 8/8 отклонены.
- **Конфликт с ДС:**
  - заменённый аванс 20% как текущий → `superseded_evidence`, не показан;
  - «Ранее аванс составлял 20%…» → показан;
  - цена договора vs итог сметы → `verified_with_conflict` со ссылками на оба документа.
- **Метрика false-pass verifier-а считается:** `verifier.falsePassRate` / `falseRejectRate` в `eval:product`; с `--verifier-llm` — вместе с моделью.
- **`/api/chat` и `/api/chat/stream` проверяют одинаково:** один `runVerifiedAnswer`; в контракте JSON и SSE дают одинаковые ответ и статус, в SSE один `token` с финальным текстом и фазы проверки.

## Tests / evidence
Машина разработки:
- `npm run check`, `npm run check:ui` -> PASS.
- `node scripts/run-product-evals.mjs` -> метрики ниже.
- Новые unit-кейсы (claim-checks 7, answer-draft 6, verified-answer 10, answer-core 20, conversation-store 9, product-eval 11) прогнаны лёгкой пробой без `node --test` -> все совпали. Фронтенд-кейсы проверены напрямую.
- Сквозная проба: `answerQuestion` → настоящий `llm.js` → фейковая HTTP-LLM (`response_format` доходит, черновик не стримится, исправление ограничено) -> как ожидалось.

`npm test` и контракты здесь не запускались.

На машине владельца (NOT RUN здесь):
- `npm run check`, `npm test`, `npm run check:ui`, `npm run eval:demo`, `npm run eval:product`, `npm run mcp:test`, `npm run smoke:api`;
- `npm run test:chat-contract`, `npm run test:conversation-contract`, `npm run test:evidence-contract`, `npm run test:verified-contract`.

## Metrics before/after
Retrieval (`eval:product`) без изменений: R@5 1.000, R@10 1.000, MRR 0.806, citation 1.000, current version 1.000, leak 0.000, clarification P/R 1.000/1.000.

Verifier gate (`evals/verifier`, 28 утверждений):

| Режим | False-pass | False-reject |
|---|---|---|
| До Stage 07 | нет проверки (все утверждения попадали в ответ) | — |
| Детерминированные проверки (офлайн) | 0.188 (3/16) — только 3 смысловых | 0.000 (0/12) |
| + verifier-модель (`--verifier-llm`) | NOT RUN — нет LM Studio | NOT RUN |

По категориям в детерминированном режиме: numeric 8/8, version 2/2, scope 1/1, citation 2/2, supported 12/12, semantic 0/3 (это работа verifier-модели).

`answer.*` — NOT_AVAILABLE: нужна живая модель ответа, сравнение — Stage 11.

## Security/privacy
- Verifier идёт тем же маршрутом, что модель ответа, с теми же правами на remote context. Новых внешних адресов нет. `apiKey` для verifier не заводится.
- В LLM уходит redacted-текст спанов (как в Stage 06).
- В истории диалога сохраняются только статусы и коды проверки, без текста утверждений.
- Текст verifier-а и `summary` пользователю не показываются.
- Env-флаги не пишутся в `settings.json`.

## Known limitations
- **Verifier-модель по умолчанию не настроена** (`separate_model` без имени). Смысловые ошибки без чисел до её настройки не ловятся; уровень честно показан как `hard_checks`. Настроить: `RAG_VERIFIER_MODEL=<модель>` или `verifier.model` в настройках; `RAG_VERIFIER_MODE=same_model` — изолированный прогон той же модели. UI-полей для этого пока нет.
- **Задержка.** Минимум два вызова LLM; первый токен приходит после проверки. На слабой машине ответ станет заметно медленнее.
- **Малые локальные модели могут не выдать JSON.** Тогда `system_error` с найденными фрагментами. Частоту нужно измерить на реальной модели.
- **Ответ суше.** Это список проверенных утверждений, связного `summary` нет.
- **Проверка чисел не понимает числа словами** («тридцать дней»). Такое утверждение без цифр проходит только смысловую проверку.
- **Расхождение документов показывается общей фразой с номерами ссылок**, без пересказа.

## Manual checks still required
- Браузер (360/430/768/1280 px, светлая и тёмная темы): статусы проверки во время ответа, бейдж под ответом, отсутствие черновика в потоке.
- Реальная LM Studio: одна модель (`same_model`) и отдельная verifier-модель; частота невалидного JSON, задержка, `eval:product -- --verifier-llm`.

## Ready for next stage?
NO
Reason: acceptance подтверждается прогоном на машине владельца.

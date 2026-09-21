# Stage 07 report

Status: PASS — независимая проверка после Revision 3: npm test 432/432, четыре контракта PASS, 12/12 мутаций ловятся, блокеров нет. NOT RUN: прогон с реальной LM Studio (недоступна)

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
- Браузер (360/430/768/1280 px, тёмная тема — единственная в UI; светлая исключена из Stage 07, см. Revision 1): статусы проверки во время ответа, бейдж под ответом, отсутствие черновика в потоке.
- Реальная LM Studio: одна модель (`same_model`) и отдельная verifier-модель; частота невалидного JSON, задержка, `eval:product -- --verifier-llm`.

## Ready for next stage?
NO
Reason: acceptance подтверждается прогоном на машине владельца.

---

## Revision 1 — после независимой проверки (verdict FAIL)

Проверка подтвердила: все gates PASS (`npm test` 426/426, четыре контракта PASS), метрики совпадают с отчётом, 5 из 6 мутаций ловятся. Также подтверждены все пункты acceptance, кроме находки 1: JSON и SSE одинаковы, черновик не стримится, флаги и env не пишутся в настройки.

### Findings
1. **[P1] Процент проходил как сумма.**
   - Причина: правило типа для `amount` принимало любую единицу, кроме срока и даты. Утверждение «Сумма аванса составляет 10% от цены договора» (`kind: amount`) проходило проверки и попадало в ответ.
   - Исправление: `amount` допускает только рубли или число без единицы. Процент и доля дают `type_mismatch`.
2. **[P2] Verifier не повторял запрос без `response_format`.**
   - Исправление: как у черновика — при отказе runtime от схемы или при неразборчивом ответе со схемой один повтор без схемы.
3. **[P3] Внутренний лимит `maxRepairs` не был защищён тестом.**
   - Исправление: добавлен тест `runVerifiedAnswer` с `maxRepairs: 9` → 2 исправления, 3 черновика.
4. **[P2] Светлой темы нет.**
   - Решение: исключено из приёмки Stage 07. UI LocalAI был только тёмным и до Product V2 (`locus-tokens.css`: `color-scheme: dark`). Stage 07 добавил лишь бейдж на существующих токенах `--status-*`; контраст в тёмной теме 4.97–7.43.
   - Светлая тема — отдельная задача для всего UI, в ledger отмечена как открытый пункт.

### Регрессионные тесты
- `tests/claim-checks.test.mjs`:
  - «Сумма аванса — 10%» и «Пени — 1/300» при `amount` → `type_mismatch`;
  - «Цена … рублей, в том числе НДС 20%» → без `type_mismatch`.
- `tests/verified-answer.test.mjs`:
  - runtime отклоняет любую схему → черновик и вердикт повторяются без схемы, `level: model`;
  - лимит исправлений при `maxRepairs: 9`.
- `evals/verifier/claims-core.json`: кейс `vc-neg-percent-as-amount` (numeric).
- `tests/verified-answer.contract.mjs` (+ маркер «СУММА» в фейковой LLM): процент как сумма по JSON и SSE → `insufficient_evidence`, текста утверждения нет ни в ответе, ни в токенах.

### Changed
- `apps/rag-api/src/answer-core/claim-checks.js`, `verified-answer.js`
- тесты выше, `tests/helpers/chat-runtime.mjs`, `evals/verifier/claims-core.json`, этот отчёт, ledger

### Metrics
Verifier gate (29 утверждений, детерминированные проверки): false-pass 0.176 (3/17, только semantic), false-reject 0.000 (0/12); numeric 9/9. Retrieval без изменений.

### Tests / evidence
Машина разработки:
- `npm run check` -> PASS;
- кейсы claim-checks 7, verified-answer 12, answer-core 20, product-eval 11 прогнаны лёгкой пробой -> все совпали;
- сквозная проба «СУММА» через `llm.js` и фейковую HTTP-LLM -> `insufficient_evidence`, `type_mismatch`.

`npm test` и контракты здесь не запускались.

---

## Revision 2 — после повторной проверки (verdict FAIL)

Проверка подтвердила исправления Revision 1: процент и доля как сумма отклоняются; verifier повторяет запрос без схемы; лимит исправлений под тестом. Все gates PASS (`npm test` 428/428, четыре контракта PASS), 8 из 9 мутаций ловятся тестами.

### Findings
1. **[P1] Число без единицы подтверждалось процентом или сроком.**
   - Пример: «Сумма аванса составляет 10» при доказательстве «аванс 10%»; «Сумма удержания составляет 30» при «30 календарных дней».
   - Причина: число без единицы сравнивалось только по значению.
   - Исправление: его подтверждает только число без единицы (строка сметы) или сумма в рублях. При том же числе с другой единицей — `unit_mismatch`.
2. **[P2] `eval:product` завершался с кодом 0 при регрессии детерминированных категорий.**
   - Исправление: `verifierGateProblems` делает регрессию причиной `exit 1`: пропущенное ложное утверждение в numeric/version/scope/citation или, без verifier-модели, отклонённое верное.
   - Промахи semantic и отказы verifier-модели остаются метриками.
   - Проверено мутацией: старое правило → `FAIL: verifier gate: numeric claim … passed the checks`, `exit=1`.
3. **[P3] Ручная проверка в отчёте требовала светлую тему.**
   - Исправление: строка согласована с Revision 1.

### Регрессионные тесты
- `tests/claim-checks.test.mjs`:
  - «Сумма аванса — 10» против 10% → `unit_mismatch`;
  - «Сумма удержания — 30» против 30 дней → `unit_mismatch`;
  - «Пени 300» против 1/300 → `missing`;
  - голое число против строки сметы или суммы в рублях → подтверждено.
- `tests/verified-answer.test.mjs`: весь конвейер, verifier пропускает всё → `insufficient_evidence`.
- `tests/verified-answer.contract.mjs` (маркер «ГОЛОЕ»): JSON и SSE → `insufficient_evidence`, `unit_mismatch`, текста утверждения нет.
- `evals/verifier/claims-core.json`: +2 numeric-кейса и +1 supported («Итого по смете — 244 800 000» без «рублей»).
- `tests/product-eval.test.mjs`: регрессия numeric даёт ровно одну проблему гейта; промах semantic и верное утверждение проблем не дают.

### Metrics
Verifier gate (32 утверждения, детерминированные проверки): false-pass 0.158 (3/19, только semantic), false-reject 0.000 (0/13); numeric 11/11, supported 13/13. Retrieval без изменений.

### Tests / evidence
Машина разработки:
- `npm run check` -> PASS;
- кейсы claim-checks 7, verified-answer 13, product-eval 12 прогнаны лёгкой пробой -> все совпали;
- мутация правила числа: `eval:product` -> exit 1, после отката -> exit 0.

`npm test` и контракты здесь не запускались.

---

## Revision 3 — после повторной проверки (verdict FAIL)

Проверка подтвердила исправления Revision 2: число без единицы не подтверждается процентом или сроком; регрессия детерминированных категорий роняет `eval:product`. Все gates PASS (`npm test` 430/430, четыре контракта PASS), все 9 мутаций ловятся.

### Findings
1. **[P1] Одинаковое число в разных единицах.**
   - Пример: утверждение «Сумма аванса составляет 10» при доказательстве «аванс 10%, комиссия — 10 рублей» подтверждалось нерелевантными 10 рублями.
   - Исправление: если голое число есть в доказательстве и как сумма/число, и с другой единицей (процент, срок, доля, год), результат — `ambiguous_number`, утверждение не показывается. Утверждения с явной единицей («Комиссия 10 рублей», «Аванс 10%») проходят.
   - Второй пример проверки («Сумма аванса — 245 000 000» при «аванс 10%; цена 245 000 000 рублей») — связь значения с условием. Детерминированно её не решить: это работа verifier-модели, категория semantic.
2. **[P2] Verifier-модель могла скрыть регрессию детерминированных проверок в eval.**
   - Исправление: `verifierGateProblems` судит только по результату детерминированных проверок (`row.check.passed`): verifier-модель не может ни скрыть регрессию гейта, ни создать её. Её отказы — метрика false-reject.
3. **[P2] «245 млн» без «руб.» ложно отклонялось.**
   - Политика: множитель тыс/млн/млрд масштабирует и число без валюты. «245 млн» = 245 000 000, подтверждается «245 млн руб.» и «245 000 000 рублей», и наоборот.

### Регрессионные тесты
- `tests/claim-checks.test.mjs`:
  - неоднозначное голое число → `ambiguous_number`; с явной единицей — `ok`;
  - новый тест денежных сокращений: 245 млн ↔ 245 млн руб. ↔ 245 000 000 рублей; 250 млн → `missing`.
- `tests/verified-answer.test.mjs`: весь конвейер, verifier пропускает всё → неоднозначное утверждение не показано.
- `tests/product-eval.test.mjs`: verifier-модель, отклоняющая всё, не скрывает регрессию numeric и не создаёт проблему гейта (false-reject 1/1 остаётся метрикой).
- `evals/verifier/claims-core.json`: supported «Цена договора составляет 245 млн».

### Metrics
Verifier gate (33 утверждения, детерминированные проверки): false-pass 0.158 (3/19, только semantic), false-reject 0.000 (0/14); numeric 11/11, supported 14/14. Retrieval без изменений.

### Tests / evidence
Машина разработки:
- `npm run check` -> PASS;
- кейсы claim-checks 8, verified-answer 14, product-eval 12, answer-core 20 прогнаны лёгкой пробой -> все совпали;
- `eval:product` -> exit 0.

`npm test` и контракты здесь не запускались.

### Предложения проверки, принятые к сведению без изменений
- **Сузить `ambiguous` для `kind: amount`, если в доказательстве ровно одна сумма с тем же значением.** Отклонено: это ровно тот обход, который нашла проверка Revision 2 («аванс 10%, комиссия — 10 рублей» подтверждало «Сумма аванса — 10»). Утверждение с единицей («Комиссия 10 рублей») проходит и сейчас, а голая формулировка суммы рядом с тем же числом в процентах остаётся скрытой сознательно.
- **Постоянный HTTP-кейс на `ambiguous_number`.** Отложено: в синтетическом корпусе нет пункта, где одно значение стоит и суммой, и в другой единице; кейс пришлось бы собирать из номера строки сметы и пункта договора. Путь закрыт на уровне модулей, всего конвейера и набора `evals/verifier`, HTTP-контракт проверяет соседний путь (`unit_mismatch`). Вернуться к этому при появлении реальных документов в наборе (Stage 10).
- **Связь значения с условием** («Сумма аванса — 245 000 000» при цене договора в доказательстве) остаётся работой verifier-модели: детерминированно это даёт высокий процент ложных отказов.

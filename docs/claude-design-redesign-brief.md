# Locus / LOCAL_RAG: полный контекст для планирования редизайна в Claude.ai

Дата аудита: 10 июля 2026 года  
Репозиторий: `LocalAI`  
Продуктовый бренд в UI: `Locus`  
Назначение документа: передача Claude.ai полного контекста проекта перед подготовкой плана редизайна.

## Роль и задача для Claude.ai

Ты выступаешь одновременно как senior product designer, UX-архитектор и frontend-архитектор.

Нужно подготовить подробный, поэтапный план редизайна существующего продукта Locus / LOCAL_RAG. Пока не пиши код и не предлагай полную замену приложения. Сначала зафиксируй информационную архитектуру, функциональные контракты, состояния интерфейса и риски миграции.

Редизайн должен улучшить:

- визуальную иерархию;
- навигацию;
- читаемость сложных статусов;
- работу с источниками и индексацией;
- чат и просмотр доказательств;
- адаптивность;
- доступность;
- безопасность опасных операций.

При этом необходимо сохранить существующую функциональность, API, privacy-политику и обязательные DOM/JS-контракты.

## 1. Что это за продукт

LOCAL_RAG — локальный Windows-first RAG-портал. В интерфейсе продукт называется Locus, подзаголовок — «Локальная память проектов».

Это не простой AI-чат. Продукт объединяет три рабочих контура.

### 1.1. Пользовательский контур

- выбор или автоматическое определение проекта;
- вопросы по документам;
- потоковый ответ;
- ссылки `[n]`;
- просмотр точного доказательства из документа;
- история диалогов.

### 1.2. Контур управления знаниями

- добавление локальных и сетевых папок;
- договоры и тендеры;
- дополнительные папки проекта;
- Google context links;
- индексация;
- OCR;
- контроль качества распознавания;
- дерево файлов;
- пропущенные и проблемные документы.

### 1.3. Операторский контур

- LM Studio;
- local/remote LLM routing;
- Qdrant;
- JSON vector fallback;
- embeddings;
- reranker;
- Dify;
- управление локальными сервисами;
- аудит обработки;
- синхронизация и аудит тендеров.

Основной пользователь — сотрудник, работающий с договорами, тендерами и проектной документацией. Приложение также содержит функции для технического оператора, который контролирует индексацию и локальную AI-инфраструктуру.

## 2. Основная продуктовая цепочка

```text
Локальные/сетевые папки и Google-документы
    → сканирование
    → PDF/DOCX/XLSX/TXT/MD/CSV-конвертация
    → OCR и проверка качества
    → Markdown-кэш
    → chunks
    → embeddings
    → Qdrant или JSON vectors
    → BM25 + vector retrieval + optional reranker
    → local-first LLM routing
    → ответ с [n]
    → точный preview evidence chunk
```

Приложение должно продолжать работать и без LLM: если модель выключена или недоступна, UI показывает релевантные фрагменты индекса.

## 3. Технологическая архитектура

### 3.1. Frontend

Frontend написан без фреймворка:

- vanilla HTML;
- единый CSS;
- JavaScript ES modules;
- без React/Vue;
- без TypeScript;
- без bundler;
- без отдельного production build.

Основные файлы:

| Файл | Назначение |
| --- | --- |
| `apps/rag-ui/index.html` | Статический каркас экранов и модалок, 551 строка |
| `apps/rag-ui/app.js` | Состояние, routing, рендеры, polling и обработчики, 7972 строки |
| `apps/rag-ui/styles.css` | Вся визуальная система и responsive, 4912 строк |
| `apps/rag-ui/modules/api-client.js` | JSON API и ручной SSE parser |
| `apps/rag-ui/modules/citation-helpers.js` | Citations, deduplication, preview targets |
| `apps/rag-ui/modules/formatting-helpers.js` | Метаданные ответа, диагностика и форматирование |
| `apps/rag-ui/modules/settings-helpers.js` | Выбор и сортировка моделей |
| `apps/rag-ui/manifest.webmanifest` | PWA metadata и standalone shell |

Express напрямую раздаёт эти файлы. Большинство сложных элементов создаётся динамически из `app.js`, поэтому изучение одного `index.html` не даёт полной картины интерфейса.

Критический технический факт: DOM IDs, классы состояний и некоторые тексты фактически являются программным API. Их произвольное переименование ломает приложение без compile-time ошибки.

### 3.2. Backend

Backend — Node.js ESM + Express.

- Главная точка входа: `apps/rag-api/src/server.js`.
- По умолчанию: `http://127.0.0.1:8787`.
- `server.js` содержит около 4219 строк и 64 HTTP-маршрута.
- Он одновременно раздаёт UI и обслуживает `/api/*`.

### 3.3. Карта backend-модулей

| Контур | Основные файлы |
| --- | --- |
| HTTP orchestration | `server.js` |
| Хранение | `paths.js`, `store.js`, `sqlite-metadata-store.js` |
| Индексация | `indexer.js`, `converters.js`, `text.js`, `path-filter.js` |
| Статусы и повторная обработка | `index-status.js`, `reindex-orchestrator.js`, `source-summary.js`, `daily-agent.js` |
| Retrieval | `search.js`, `search-bm25.js`, `search-pipeline.js`, `search-query.js`, `search-scoring.js` |
| Vectors | `embeddings.js`, `vector-store.js`, `vector-backfill-status.js` |
| LLM | `llm.js`, `llm-routing.js`, `chat-scope.js`, `chat-intent.js` |
| Проекты | `source-match.js`, `source-scope.js`, `source-updates.js` |
| Citations и preview | `citations.js`, `preview-access.js`, `sse.js` |
| Security | `security.js` |
| Google | `context-links.js`, `google-auth.js`, `google-context.js`, `google-drive-match.js` |
| Тендеры | `tender-sync.js`, `tender-recognition.js`, `tender-price-audit.js`, `tender-global-audit.js` |
| HubTender | `hubtender-adapter.js`, `hubtender-adapter-pg.js`, `audit-run-store.js` |
| Dify | `dify-adapter.js` |
| Сервисы | `qdrant-process.js`, `reranker-process.js` |
| MCP | `apps/mcp-server/` |

Dify является только optional workflow/orchestration layer. Он не заменяет существующий RAG-core и не должен получать прямой доступ к пользовательским документам или локальному хранилищу.

MCP-сервер — отдельный read-only façade поверх loopback API. Он предоставляет безопасные инструменты поиска и диагностики с redaction/truncation.

## 4. Данные и предметная модель

### 4.1. Source / проект

Источник содержит примерно следующие поля:

```text
id
title
path
sourceType: contract | tender
additionalPaths[]
include[]
exclude[]
contextLinks[]
tenderCategory
linkedContractId
createdAt
updatedAt
```

Семантика:

- `contract` — основной проект/договор;
- `tender` — тендерный источник;
- в selector чата попадают только договоры;
- поиск по договору автоматически может включать связанные тендеры;
- tender можно связать с contract;
- основной и дополнительные пути индексируются как один логический источник.

### 4.2. Индексированные документы

Поддерживаются:

- PDF;
- DOCX;
- XLS, XLSX, XLSM;
- TXT;
- Markdown;
- CSV.

Для каждого файла хранятся:

- стабильный `fileId`;
- путь и относительный путь;
- тип документа;
- Markdown cache;
- дата и размер;
- recognition metadata;
- OCR metadata;
- quality status;
- reindex report;
- тендерная классификация.

Quality имеет состояния `ok`, `warning`, `error`, `unchecked` и числовую оценку 0–100.

### 4.3. Chunks

Chunk содержит:

- стабильный `chunkId`;
- source/file IDs;
- текст;
- номер chunk;
- section title;
- PDF page/range;
- Excel sheet и строки;
- document type;
- citation metadata.

Примерный размер chunk — 1800 символов, overlap — 220.

### 4.4. Хранение

По умолчанию данные находятся в `D:\LOCAL_RAG\data`.

Основные артефакты:

```text
state/manifest.json
state/chunks.json
state/source-summaries.json
state/vectors.json
state/jobs.json
state/agent-runs.json
state/audit-runs.json
md-cache/
metadata.sqlite — опционально
```

Metadata provider:

- JSON — default;
- SQLite — optional.

Vector provider:

- `qdrant`;
- `json`;
- `auto` — Qdrant first, затем JSON fallback с предупреждением.

## 5. Текущая информационная архитектура UI

### 5.1. Главный чат

Desktop-layout:

```text
360 px sidebar | chat workspace | optional evidence viewer 330–420 px
```

Левая sidebar:

- логотип и Locus;
- подпись;
- LM Studio status;
- Dify status;
- «Новый чат»;
- история по месяцам;
- действия чата: archive/delete;
- кнопка настроек.

История хранится в `localStorage`, максимум 60 чатов. Архивировать чат можно, но отдельного экрана архива и восстановления сейчас нет.

Центральная область:

- selector проекта;
- вариант «Авто: определить по вопросу»;
- «Обновить индекс»;
- «Полная переиндексация»;
- остановка индексации;
- status bar готовности;
- ссылка на аудит;
- поток сообщений;
- composer;
- send/stop.

Ответ ассистента содержит:

- plain text;
- inline citations `[n]`, превращаемые в кнопки;
- provider/model/project metadata;
- список использованных файлов;
- раскрываемую «Диагностику RAG»;
- retrieval mode;
- candidate counts;
- timings;
- top sources.

Chat работает через `/api/chat/stream`.

SSE-события:

```text
status: retrieval_started
status: retrieval_done
status: llm_started
token
sources
meta
done
error
```

Запрос можно остановить через AbortController.

### 5.2. Автоопределение проекта

При пустом selector backend пытается определить проект по вопросу.

UI должен сохранить:

- «Авто: определить по вопросу»;
- «Авто по вопросу»;
- «Проект определится из вопроса»;
- применение `matchedSource`;
- явное отображение auto-selected проекта.

Текущее поведение: если уверенного совпадения нет, backend может искать по всем источникам. Предыдущий выбранный проект используется для follow-up-вопросов.

### 5.3. Evidence viewer

Правая панель открывается:

- по inline citation;
- по карточке файла под ответом;
- по indexed file;
- по Google context link.

Для локального документа она показывает:

- название файла;
- источник;
- section/page/sheet metadata;
- exact/fallback status;
- Markdown excerpt;
- подсветку evidence;
- сообщения о скрытом тексте выше/ниже.

На мобильном viewer превращается в fixed bottom sheet высотой до 72% viewport.

Это ключевой функциональный элемент. Нельзя заменять его простым списком файлов или preview всего документа без позиционирования на доказательстве.

### 5.4. Fullscreen settings

Настройки заменяют весь основной workspace, а не открываются обычной модалкой.

Маршруты:

```text
/chat
/settings/sources
/settings/llm
/settings/indexes
/settings/general
/settings/audit
```

Header настроек содержит:

- Back;
- общую сводку индекса;
- refresh;
- Audit;
- Google Drive tender sync;
- Backend status/control;
- Reranker status/control;
- Qdrant status/control;
- глобальную кнопку остановки портала.

Сейчас эта шапка перегружена навигационными, диагностическими и опасными действиями.

### 5.5. Источники

Desktop — сложный трёхзонный экран:

1. Список RAG-папок:
   - договоры/тендеры;
   - counts;
   - выбор проекта;
   - inline rename;
   - multi-select;
   - bulk delete;
   - add shortcut.
2. Детали выбранного источника:
   - pipeline;
   - сводка;
   - качество распознавания;
   - OCR;
   - дополнительные папки;
   - связь tender → contract;
   - действия.
3. Indexed files tree:
   - иерархия папок;
   - files/chunks;
   - размер и дата;
   - recognition method;
   - quality badge;
   - source chip;
   - context menu;
   - открыть файл;
   - показать в Explorer.

Pipeline состоит из пяти этапов:

```text
Сканирование → Файлы/OCR → Фрагменты → Векторы → Qdrant
```

Add-source mode должен:

- скрыть детали предыдущего источника;
- скрыть indexed-files;
- снять active state;
- очистить форму;
- сфокусировать поле;
- корректно вернуться в обычный режим.

### 5.6. LLM

Раздел содержит:

- включение LLM;
- route `local`, `auto local-first`, `remote`;
- отдельное разрешение remote context;
- отдельное разрешение remote→local fallback;
- предупреждение о передаче фрагментов наружу;
- схему auto-route;
- локальную LM Studio;
- удалённую LM Studio/OpenAI-compatible endpoint;
- модели;
- embedding model;
- masked token field;
- connectivity/models/activity/last-response diagnostics.

Настройки после сохранения блокируются до нажатия «Редактировать».

### 5.7. Индексы

Содержит:

- vector store enable;
- provider;
- Qdrant URL;
- collection;
- distance;
- batch size;
- optional API key;
- reranker enable;
- endpoint/model/candidate count/max chars/timeout;
- Qdrant/reranker/PDF diagnostics.

### 5.8. Аудит

Показывает:

- общую индексацию;
- backend;
- agent;
- vectors;
- reranker;
- LLM route;
- активные движения файлов;
- последние статусы;
- тот же pipeline обработки.

### 5.9. Общие

Сейчас раздел содержит только путь хранилища. При `RAG_DATA_DIR` из environment поле заблокировано.

### 5.10. Модалки и вспомогательные сценарии

- пропущенные файлы и причины;
- принудительная переиндексация;
- folder picker;
- tender sync dry-run;
- ручной выбор contract для tender;
- apply sync;
- service actions;
- indexed-file context menu.

## 6. Важные состояния интерфейса

Claude должен составить отдельную state matrix минимум для следующих состояний.

### 6.1. Chat

- empty;
- project auto;
- explicit project;
- retrieval;
- LLM preparation;
- streaming;
- stopped;
- failed;
- no results;
- source not indexed;
- LLM disabled;
- LLM failure with retrieval fallback;
- ambiguous project;
- all-project search.

### 6.2. Индексация

- not indexed;
- queued;
- scan;
- convert;
- OCR;
- reindex;
- chunking;
- embeddings;
- vector store;
- completed;
- stale;
- interrupted;
- cancelled;
- failed;
- partially searchable.

### 6.3. Файлы

- loading;
- skeleton;
- folder;
- searchable;
- no chunks;
- warning;
- error;
- unsupported;
- excluded;
- temporary.

### 6.4. Preview

- loading;
- exact target;
- exact evidence highlighted;
- chunk found, evidence not highlighted;
- legacy fallback;
- inaccessible;
- Google iframe;
- external-open action.

### 6.5. Сервисы

- disabled;
- unmanaged;
- stopped;
- starting;
- running;
- busy;
- stopping;
- failed;
- configured but unreachable.

### 6.6. Privacy/LLM

- local;
- auto local-first;
- remote blocked;
- remote allowed;
- remote not configured;
- remote active;
- fallback used;
- remote model loading;
- reload for larger context;
- token exists but is masked.

## 7. Retrieval и LLM-политика

Retrieval:

1. BM25 lexical candidates.
2. Embeddings и Qdrant/JSON candidates.
3. RRF merge.
4. Optional reranker.
5. Bounded results.

Default budgets:

```text
vector candidates: 200
lexical candidates: 200
merged: 60
rerank: 30
```

Privacy policy:

- `local` — только локальная LM Studio;
- `auto` — всегда local-first;
- remote context по умолчанию запрещён;
- наличие remote URL/token само по себе ничего не разрешает;
- remote-to-local fallback разрешён только при `fallbackToLocalOnRemoteError=true`;
- UI/API могут показывать только `hasApiKey`, но не secret value.

Embeddings и reranker также потенциально получают текст документов. Новый UI должен визуально различать loopback endpoint и внешний endpoint.

Remote LM Studio:

- модель должна предварительно загружаться;
- целевой RAG context — `16384`;
- при недостаточном context модель выгружается и перезагружается;
- состояния: checking/loading/reloading/compacting/generating.

## 8. Основные API-группы

### 8.1. Sources/files

```text
GET /api/sources
GET /api/sources/match
POST /api/sources
PUT /api/sources/:id
DELETE /api/sources/:id
DELETE /api/sources
GET /api/sources/:id/indexed-files
GET /api/sources/:id/skipped
POST/DELETE /api/sources/:id/context-links
GET /api/files/preview
POST /api/files/system-open
```

### 8.2. Index/jobs/agent

```text
POST /api/sources/:id/index
POST /api/index/stop
GET /api/jobs/:id
GET /api/index/status
POST /api/index/refresh
GET /api/agent/runs
POST /api/agent/run
```

### 8.3. Chat/search

```text
GET /api/search
POST /api/chat
POST /api/chat/stream
POST /api/chat/title
```

### 8.4. LLM/integrations

```text
GET/PUT /api/settings
GET /api/llm/models
GET /api/llm/status
GET /api/llm/diagnostics
GET /api/llm/usage
GET /api/integrations/status
GET /api/vector-store/status
GET /api/dify/status
```

### 8.5. System

```text
GET /api/health
/api/system/backend/*
/api/system/qdrant/*
/api/system/reranker/*
POST /api/system/portal/stop
```

### 8.6. Tender

```text
POST /api/tenders/sync
POST /api/tenders/:id/price-audit
POST /api/tenders/audit/global
GET /api/tenders/audit/runs/:id
```

## 9. Текущий визуальный baseline

Тема:

- только dark;
- Segoe UI;
- фон `#0d1117`;
- синие primary actions;
- красно-розовые danger states;
- радиусы преимущественно 6–8 px;
- много цветов находится вне token layer.

Основной layout:

- sidebar — 360 px;
- evidence viewer — 330–420 px;
- settings viewer — 360–480 px;
- source list — 260–330 px;
- message max-width — 920 px.

Breakpoints:

- 1400;
- 1200;
- 920;
- 700;
- 340 px.

Отсутствуют:

- light theme;
- системная type scale;
- системная spacing scale;
- полноценные semantic status tokens;
- `prefers-reduced-motion`;
- visual-regression tests.

Переменная `--ok` используется, но не объявлена.

## 10. Фактически обнаруженные UX-проблемы

Визуальная проверка выполнена на безопасном demo-runtime.

### 10.1. Desktop

- чат функционален, но его toolbar перегружен административной индексацией;
- глобальная красная power-кнопка визуально доминирует;
- settings header содержит слишком много разнотипных действий;
- при ширине около 1280 px названия и подписи уже сокращаются;
- service statuses превращаются в малопонятные цветные индикаторы;
- Sources — слишком плотный трёхколоночный экран;
- много вложенных панелей одинаковой визуальной важности;
- диагностика конкурирует с основными пользовательскими действиями.

### 10.2. Mobile 390 px

- header actions пересекаются;
- длинная Google Drive sync-кнопка ломает компоновку;
- подписи обрезаются;
- service indicators теряют смысл;
- слишком много вложенных scroll containers;
- sidebar занимает значительную часть высоты;
- source pipeline, paths и summary визуально сталкиваются;
- indexed files появляется слишком далеко вниз;
- bottom-sheet preview перекрывает большую часть рабочего контекста.

### 10.3. Доступность

Положительное:

- есть `aria-live`;
- tab roles;
- `aria-selected`;
- keyboard context menu;
- Escape закрывает основные overlays;
- часть элементов имеет `focus-visible`.

Недостатки:

- нет полноценного focus trap в модалках;
- нет возврата фокуса;
- tabs не поддерживают arrow-key navigation;
- viewer/bottom sheet не имеет полноценной dialog-семантики;
- service menu плохо адаптирован для клавиатуры;
- много статусов передаётся только цветом;
- нет reduced-motion.

## 11. Критические рассинхронизации

### 11.1. Актуальный worktree нельзя заменять HEAD/MVP

Текущая ветка содержит большой незакоммиченный слой:

- 43 изменённых tracked-файла;
- около `+7938/-732`;
- новые Dify/index-status/chat-intent/reindex-модули;
- новая UI-функциональность.

В истории git только два коммита. Сброс на `HEAD` удалит значительную часть текущего продукта.

### 11.2. Google context links

Backend, JS-рендер и CSS для Google context существуют, но в текущем `index.html` отсутствуют:

```text
#context-links-panel
#context-link-list
#context-link-form
Google Auth controls
```

При этом Google context links являются обязательной функцией проекта. Claude должен вынести это в Phase 0: подтвердить и восстановить контракт либо предложить осознанное решение. Нельзя считать отсутствие панели намеренным удалением.

### 11.3. Устаревшая документация

Некоторые документы всё ещё описывают проект как MVP или называют реализованные функции будущими.

Старые test counts также неактуальны:

- раньше: 86 tests и 28 UI checks;
- сейчас: 259 tests и 52 UI checks.

### 11.4. API auth

Backend поддерживает Bearer auth, но frontend API client не умеет передавать `RAG_AUTH_TOKEN`. При включённой auth UI показывает 401, но не может продолжить работу. Нельзя использовать remote LLM token как API token и нельзя добавлять auth token в `localStorage` «заодно».

### 11.5. Опасные действия

Требуют явной UX-политики и confirmations:

- остановка портала;
- stop/restart сервисов;
- удаление source;
- bulk delete;
- force reindex;
- apply tender sync;
- remote context;
- destructive tender link changes.

Сейчас глобальная power-кнопка останавливает портал без отдельного confirm.

## 12. Неприкосновенные функциональные контракты

Нельзя удалить:

- fullscreen settings;
- левую историю чатов;
- auto project mode;
- разделение contract/tender;
- выбранный source detail;
- additional paths;
- Google context links;
- indexed files tree;
- правый file/evidence preview;
- inline clickable citations;
- source summary;
- recognition quality;
- index pipeline;
- audit;
- service diagnostics;
- local-first privacy.

Обязательные маркеры:

```text
#source-viewer-close
#indexed-files-panel
#indexed-files-tree
#source-add-shortcut
#new-source-panel
state.addingSource
focusNewSourceForm()
loadIndexedFiles()
renderIndexedFilesPanel()
buildIndexedFileTree()
.source-citation
renderMessageTextContent()
sourcesByCitationNumber()
/api/sources/match
/api/sources/:id/indexed-files
matchSourceForQuestion()
publicMatchedSource()
applyMatchedSource()
matchedSource
ensureRemoteModelLoaded
remoteRagContextLength = 16384
context_length
Авто: определить по вопросу
Авто по вопросу
Проект определится из вопроса
```

Если нужен рефакторинг IDs, он должен выполняться синхронно в HTML, JS, CSS, static gate и тестах, а не как чисто визуальная правка.

## 13. Границы редизайна

### 13.1. В scope

- IA;
- layout;
- component hierarchy;
- design tokens;
- typography;
- spacing;
- statuses;
- chat UX;
- sources UX;
- preview UX;
- settings UX;
- responsive;
- accessibility;
- safe confirmations;
- loading/empty/error states;
- visual regression strategy.

### 13.2. Не включать без отдельного решения

- замену RAG-algorithm;
- изменение API или data schemas;
- смену privacy policy;
- хранение secrets в UI;
- полный переход на React/Vue;
- массовое исправление кодировки;
- удаление Dify/MCP/Google/tender-модулей;
- изменение remote-routing semantics.

Framework migration нужно рассматривать отдельным ADR. Совмещать её с визуальным редизайном слишком рискованно.

## 14. Какой результат требуется от Claude

Подготовь не общий список идей, а исполнимый план со следующей структурой:

1. Краткая модель продукта и пользователей.
2. Диагностика текущей IA.
3. Приоритеты и принципы редизайна.
4. Рекомендуемая target IA.
5. Карта экранов и навигации.
6. Screen-by-screen redesign:
   - Chat;
   - History;
   - Evidence viewer;
   - Sources;
   - Indexed files;
   - Add source;
   - LLM;
   - Indexes;
   - Audit;
   - General;
   - Tender sync;
   - Modals.
7. Component map, например:
   - AppShell;
   - Sidebar;
   - ProjectPicker;
   - StatusPill;
   - JobProgress;
   - ChatMessage;
   - CitationChip;
   - EvidenceViewer;
   - SourceList;
   - SourceOverview;
   - PipelineStepper;
   - QualityCard;
   - IndexedFileTree;
   - IntegrationCard;
   - ServiceControl;
   - ConfirmationDialog.
8. Design-token plan:
   - colors;
   - typography;
   - spacing;
   - radius;
   - elevation;
   - focus;
   - semantic statuses.
9. Полная state matrix.
10. Responsive strategy для ≥1440, 1200, 920, 700, 390/340 px.
11. Accessibility plan.
12. Опасные действия и confirmation model.
13. Поэтапная migration strategy без big-bang замены.
14. Для каждой фазы:
   - какие файлы затрагиваются;
   - что сохраняется;
   - риски;
   - проверки;
   - rollback boundary.
15. Risk register.
16. Acceptance checklist.
17. Открытые продуктовые вопросы.
18. Отдельное решение по Google context panel.
19. Отдельное решение: сохранять vanilla architecture или позже мигрировать на framework.

Рекомендуемая последовательность реализации:

```text
Phase 0: functional inventory, screenshots, state matrix, восстановление контрактов
Phase 1: design tokens и базовые компоненты без изменения поведения
Phase 2: shell, sidebar, navigation и responsive foundation
Phase 3: chat, history, citations и evidence viewer
Phase 4: sources, indexed files, pipeline и quality
Phase 5: LLM, indexes, services и privacy warnings
Phase 6: audit, tender workflows и модалки
Phase 7: accessibility, mobile polish и visual regression
Phase 8: cleanup legacy CSS/JS только после стабилизации UI
```

## 15. Критерии приёмки

Редизайн считается принятым, если:

- сохранены все routes;
- back/forward navigation работает;
- история переживает reload;
- auto project mode работает;
- selected contract включает связанные tenders;
- streaming и stop работают;
- fallback без LLM понятен;
- `[n]` кликабельны;
- preview открывает exact evidence;
- Sources поддерживают add/edit/delete/multi-select;
- add mode не показывает старый source;
- indexed tree показывает loading/empty/running/error/ready;
- файлы без chunks различимы;
- качество OCR и warnings не скрыты;
- опасные действия подтверждаются;
- remote context требует явного согласия;
- secrets только masked;
- desktop/tablet/mobile проверены;
- keyboard/focus/dialog behavior проверены;
- обязательные markers сохранены.

После каждой фазы:

```powershell
npm run check
npm test
npm run check:ui
npm run eval:demo
npm run smoke:local
npm run smoke:api
```

Текущий baseline:

- `npm run check` — PASS;
- `npm test` — PASS, 259/259;
- `npm run check:ui` — PASS, 52/0/0;
- `npm run eval:demo` — PASS, 6/6, Recall@3/5/10 = 1.000, MRR = 1.000;
- `npm run smoke:local` — PASS;
- `npm run smoke:api` — FAIL два последовательных раза: indexing job остаётся `running` до timeout.

Последний пункт является существующим baseline blocker. Его нужно зафиксировать до редизайна и либо исправить отдельной задачей, либо оформить явный waiver. Нельзя приписывать этот сбой будущим изменениям дизайна.

## 16. Опорные файлы проекта

- `AGENTS.md`
- `README.md`
- `codex.md`
- `package.json`
- `apps/rag-ui/index.html`
- `apps/rag-ui/app.js`
- `apps/rag-ui/styles.css`
- `apps/rag-ui/modules/*.js`
- `apps/rag-api/src/server.js`
- `apps/rag-api/src/indexer.js`
- `apps/rag-api/src/search.js`
- `apps/rag-api/src/llm.js`
- `apps/rag-api/src/llm-routing.js`
- `apps/rag-api/src/store.js`
- `apps/rag-api/src/source-match.js`
- `apps/rag-api/src/source-summary.js`
- `apps/rag-api/src/preview-access.js`
- `docs/ui-acceptance-checklist.md`
- `docs/ui-acceptance-results.md`
- `docs/regression-matrix.md`
- `fixtures/demo-project/`

## 17. Ограничения безопасности для дальнейшей работы

- Не читать и не изменять `.env`.
- Не читать и не изменять live `config/settings.json` и `config/sources.yaml`.
- Не читать и не изменять пользовательские документы и `data/`.
- Не печатать tokens, API keys и private URLs.
- Реальные secrets должны задаваться только через environment.
- В UI допустим только masked state вроде `hasApiKey`.
- Массовое исправление mojibake не смешивать с редизайном; для этого нужен отдельный этап `encoding recovery`.
- Не сбрасывать текущий worktree на старый MVP.

---

Этот документ описывает текущее состояние worktree на дату аудита. Пользовательские документы, live-config, `.env` и секретные значения при подготовке анализа не использовались.

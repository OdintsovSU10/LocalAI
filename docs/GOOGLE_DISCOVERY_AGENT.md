# Google discovery agent

Агент открывает корпоративный Google Drive в браузере с сохранённым профилем, находит подпапки проектов, сопоставляет их с RAG-проектами по названию и добавляет Google Sheets / Docs / Drive-файлы как context links. После этого запускается обычная индексация через export с cookies браузерной сессии — без OAuth в LocalAI и без скачивания файлов в папки проектов.

## Подготовка

1. Скопируйте `config/google-discovery.example.yaml` в `config/google-discovery.yaml`.
2. Укажите `parentFolderUrl` — ссылку на родительскую папку Drive, внутри которой лежат отдельные папки проектов.
3. Установите Playwright один раз:

```powershell
npm install playwright
npx playwright install chromium
```

4. Убедитесь, что в LocalAI уже созданы проекты (sources) с названиями, похожими на папки в Drive.

## Первый запуск (логин в корп. Google)

```powershell
npm run agent:google-discover:dry-run
```

Откроется браузер. Войдите в корпоративный Google аккаунт. Профиль сохранится в `%LOCALAPPDATA%\LocalAI\google-browser`. Повторный вход обычно не нужен.

Dry-run покажет JSON-план: какая папка к какому проекту привязалась и какие ссылки будут добавлены. Ничего не сохраняет.

## Рабочий запуск

```powershell
npm run agent:google-discover
```

Агент:

1. Читает подпапки в `parentFolderUrl`.
2. Сопоставляет имя папки с проектом (`matchSourceForQuestion`).
3. Собирает таблицы/документы внутри папки.
4. Для Google Sheets читает вкладки (обычно одна) и создаёт context link на каждый лист.
5. Добавляет только новые ссылки (существующие не дублирует).
6. Запускает индексацию с cookies браузера для приватных корп. документов.

## Полезные флаги

```powershell
npm run agent:google-discover:dry-run
npm run agent:google-discover -- --no-index
npm run agent:google-discover -- --headless
npm run agent:google-discover -- --quiet
```

## Настройки `config/google-discovery.yaml`

| Поле | Описание |
|------|----------|
| `parentFolderUrl` | Родительская папка Drive с подпапками проектов |
| `browserProfileDir` | Профиль Chromium с Google-сессией |
| `minMatchScore` | Минимальный score сопоставления (по умолчанию 5) |
| `requireConfidentMatch` | Не привязывать папку при неоднозначном совпадении |
| `includeSheetTabs` | Индексировать все листы таблицы |
| `syncAfterDiscovery` | Запускать индексацию после добавления ссылок |
| `headless` | Без окна браузера (после первого логина) |
| `browserChannel` | `chrome` — использовать установленный Chrome |

## Сопоставление имён

Используется та же логика, что и «Авто: определить по вопросу» в чате: токены из названия папки сравниваются с `title` и `path` проекта. Например, папка `ЖК Солнечный — КП` может совпасть с проектом `Солнечный`.

Если папка не сопоставилась уверенно, она попадает в `unmatched` в отчёте — ссылка не добавляется.

## Планирование в Windows

Пример ежедневного запуска в 04:00 (после daily agent в 03:00):

```powershell
schtasks /Create /TN "LocalAI Google Discovery" /TR "powershell -NoProfile -ExecutionPolicy Bypass -Command \"cd C:\path\to\LocalAI; npm run agent:google-discover -- --headless --quiet\"" /SC DAILY /ST 04:00
```

## Ограничения

- Зависит от вёрстки Google Drive / Sheets (при смене UI может потребоваться обновление селекторов).
- Папки проектов должны быть **прямыми дочерними** элементами `parentFolderUrl`.
- OAuth в LocalAI не нужен; используется только браузерная сессия.
- Файлы не копируются на диск — только context links и markdown-cache при индексации.

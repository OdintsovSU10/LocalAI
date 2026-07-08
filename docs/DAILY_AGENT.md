# Ежедневный агент индексации

Агент проходит по всем папкам из `config/sources.yaml` и запускает существующий пайплайн:

- сканирование выбранной папки;
- распознавание и конвертация файлов в Markdown;
- разбиение на чанки и обновление индекса;
- векторизация чанков, если embeddings включены в `config/settings.json`;
- сохранение отчета запуска в `data/state/agent-runs.json` или в выбранном `dataDir`.

## Ручной запуск

```powershell
npm run agent:run
```

Проверить список источников без индексации:

```powershell
npm run agent:dry-run
```

Принудительно пересобрать распознавание, индекс и embeddings:

```powershell
npm run agent:force
```

## Установка ежедневной задачи Windows

По умолчанию задача запускается каждый день в `03:00`.

```powershell
.\scripts\install-daily-agent.ps1
```

Задать свое время:

```powershell
.\scripts\install-daily-agent.ps1 -At "02:30"
```

Ежедневно делать полный принудительный пересчет:

```powershell
.\scripts\install-daily-agent.ps1 -At "02:30" -ForceReindex
```

Удалить задачу:

```powershell
.\scripts\uninstall-daily-agent.ps1
```

## Статус

Когда сервер запущен, последние запуски доступны по API:

```text
GET http://127.0.0.1:8787/api/agent/runs
```

Агент использует lock-файл, поэтому второй ежедневный запуск не стартует поверх первого. Индексатор тоже использует общий lock-файл, чтобы ручная и плановая индексация не писали состояние одновременно.

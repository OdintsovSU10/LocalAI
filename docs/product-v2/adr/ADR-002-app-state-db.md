# ADR-002 — отдельная app-state SQLite

Статус: принято (Stage 00). Реализация: Stage 03.

## Контекст

Metadata storage (`storage.metadataProvider`) переключается между JSON и SQLite и хранит индекс. Диалоги, состояние уточнений, feedback и traces — это состояние приложения с другим жизненным циклом: их нельзя терять при переиндексации или смене provider.

## Решение

- Отдельный файл `stateDir()/app-state.sqlite` через `node:sqlite` (уже используется в `sqlite-metadata-store.js`), режим WAL.
- Не зависит от `storage.metadataProvider`.
- Миграции — пронумерованные SQL-файлы, применяются идемпотентно с таблицей `schema_migrations`.
- Секреты и абсолютные пути не хранятся; внешние user id — HMAC-хеш с локальной солью.

## Последствия

- Диалоги переживают рестарт и переиндексацию.
- Нужны backup/recovery (Stage 09).
- Минимальная версия Node — с `node:sqlite` (фактически v24).

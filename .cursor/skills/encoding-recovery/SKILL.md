---
name: encoding-recovery
description: >-
  Отдельный этап исправления русской mojibake/кодировки в LOCAL_RAG. Use only
  when the user explicitly asks for encoding recovery, mojibake fix, or UTF-8
  repair — never during unrelated feature work.
---

# encoding-recovery

## When to use

- Явный запрос: «encoding recovery», «исправить mojibake», «починить кодировку».
- Видимый mojibake в UI/docs после отдельного аудита.
- **Не использовать** во время обычных фич, рефакторинга или «заодно поправлю строки».

## Hard rules

- Отдельный этап, не смешивать с другими задачами.
- Не mass-fix по всему репозиторию.
- Не трогать `data/`, live config, `.env`.
- Не ломать UI/API маркеры (`npm run check:ui`).
- `encoding_noise` в `indexer.js` / `converters.js` — runtime warning о PDF/OCR, не повод править все файлы.

## Workflow

1. **Scope:** список конкретных файлов/экранов (например, только `apps/rag-ui/app.js` + затронутые labels).
2. **Источник истины:** восстановить из UTF-8 оригинала или проверенного текста, не «на глаз».
3. **Сохранить:** строки-маркеры из `AGENTS.md` (`Авто: определить по вопросу`, и т.д.).
4. **Проверить** командами ниже.
5. Для docs/product — mojibake scan (см. `docs/regression-matrix.md`, row Encoding).

## Проверка

```powershell
npm run check
npm test
npm run check:ui
```

Lexical anchor (не регрессить Russian search):

```powershell
node --test tests/search-bm25.test.mjs
```

Mojibake scan (пример; уточни паттерн по regression-matrix):

```powershell
rg -n "Ð|Ñ|Р°|РІ|Рѕ|Рє|Рј|Рї" apps/rag-ui docs --glob "!**/node_modules/**"
```

## Output

- Список исправленных файлов и что именно восстановлено.
- Подтверждение, что marker checks и BM25 test прошли.

## См. также

- `.cursor/rules/encoding-recovery.mdc`, `AGENTS.md`
- `tests/search-bm25.test.mjs` — «Russian query terms after encoding recovery»

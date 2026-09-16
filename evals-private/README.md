# evals-private — приватные Product V2 evals

Каталог в `.gitignore` (кроме этого README). Сюда владелец кладёт кейсы по реальным проектам. Агенты и скрипты этот каталог не заполняют.

## Контракт

- Формат кейсов тот же, что у `evals/product-v2/*.json`: `schemaVersion: "product-v2/1"`, 15 классов, `expected.status`, `expected.evidence[]` и т. д. Проверка — `scripts/product-eval/schema.mjs`.
- `corpus` указывает на локальную папку с `sources.json` и markdown-выгрузками документов (формат конвертеров: `## Лист: …` с номерами строк, `## OCR page N`). Исходные документы не копировать, только bounded-выгрузки.
- Набор должен покрывать все 15 классов, иначе runner завершится с ошибкой.

## Запуск

```powershell
node scripts/run-product-evals.mjs --dir evals-private --json .tmp/product-eval-private-report.json
```

Отчёт пишется только вне каталога с кейсами (иначе следующий запуск прочитает его как набор кейсов); `.tmp/` в `.gitignore`. Отчёт содержит пути и цитаты из документов — не коммитить и не пересылать.

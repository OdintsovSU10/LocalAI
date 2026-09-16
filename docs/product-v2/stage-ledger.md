# Product V2 — журнал этапов

Процесс и формат отчётов — `LocalAI_Opus5_Prompt_Pack.md` (MASTER PROMPT). Один этап за раз; после каждого — независимая проверка.

| Stage | Название | Статус | Отчёт |
|---|---|---|---|
| 00 | Baseline & architecture freeze | PASS (независимая проверка: PASS) | [stage-00-report.md](stage-00-report.md) |
| 01 | Product eval contract | PASS после revision 1 (ожидает повторной проверки) | [stage-01-report.md](stage-01-report.md) |
| 02 | Answer-core extraction | код готов, ожидает прогона и проверки | [stage-02-report.md](stage-02-report.md) |
| 03 | Server conversations | не начат | |
| 04 | Evidence + document graph | не начат | |
| 05 | Query planner & clarification | не начат | |
| 06 | Retrieval 2.0 | не начат | |
| 07 | Verified answering | не начат | |
| 08 | Telegram | не начат | |
| 09 | Security/observability/ops | не начат | |
| 10 | Real eval & feedback dataset | не начат | |
| 11 | Model bakeoff | не начат | |
| 12 | Unsloth training (условно) | не начат | |
| 13 | Codex/MCP QA lane | не начат | |
| 14 | Release hardening | не начат | |

## Baseline gates

```powershell
npm run check
npm test
npm run check:ui
npm run eval:demo
npm run mcp:check
npm run mcp:test
npm run smoke:api
npm run eval:product
```

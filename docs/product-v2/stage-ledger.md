# Product V2 — журнал этапов

Процесс и формат отчётов — `LocalAI_Opus5_Prompt_Pack.md` (MASTER PROMPT). Один этап за раз; после каждого — независимая проверка.

| Stage | Название | Статус | Отчёт |
|---|---|---|---|
| 00 | Baseline & architecture freeze | PASS (независимая проверка: PASS) | [stage-00-report.md](stage-00-report.md) |
| 01 | Product eval contract | PASS (независимая проверка после revision 1) | [stage-01-report.md](stage-01-report.md) |
| 02 | Answer-core extraction | PASS (независимая проверка после revision 2) | [stage-02-report.md](stage-02-report.md) |
| 03 | Server conversations | PASS (независимая проверка после revision 2) | [stage-03-report.md](stage-03-report.md) |
| 04 | Evidence + document graph | PASS (независимая проверка после revision 6) | [stage-04-report.md](stage-04-report.md) |
| 05 | Query planner & clarification | PASS (независимая проверка после revision 1) | [stage-05-report.md](stage-05-report.md) |
| 06 | Retrieval 2.0 | PASS (независимая проверка после revision 1) | [stage-06-report.md](stage-06-report.md) |
| 07 | Verified answering | реализован, ждёт независимой проверки | [stage-07-report.md](stage-07-report.md) |
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
npm run test:chat-contract
npm run test:conversation-contract
npm run test:evidence-contract
npm run test:verified-contract
```

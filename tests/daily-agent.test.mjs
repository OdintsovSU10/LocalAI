import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { publicDailyAgentRun } from "../apps/rag-api/src/daily-agent.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const dailyAgentJs = fs.readFileSync(path.resolve(__dirname, "../apps/rag-api/src/daily-agent.js"), "utf8");

test("publicDailyAgentRun keeps active running agent visible", () => {
  const run = {
    id: "run-1",
    status: "running",
    startedAt: "2026-07-08T10:00:00.000Z",
    sources: [
      { sourceId: "source-1", status: "running" },
      { sourceId: "source-2", status: "completed" }
    ]
  };

  assert.equal(publicDailyAgentRun(run, { lockStatus: { active: true } }).status, "running");
  assert.equal(publicDailyAgentRun(run, { active: true, lockStatus: { active: false } }).status, "running");
});

test("publicDailyAgentRun marks stale persisted running agent as interrupted", () => {
  const run = {
    id: "run-1",
    status: "running",
    startedAt: "2026-07-08T10:00:00.000Z",
    sources: [
      { sourceId: "source-1", status: "running" },
      { sourceId: "source-2", status: "completed" }
    ]
  };

  const normalized = publicDailyAgentRun(run, {
    lockStatus: {
      exists: true,
      active: false,
      stale: true,
      orphan: true
    }
  });

  assert.equal(normalized.status, "interrupted");
  assert.equal(normalized.phase, "interrupted");
  assert.match(normalized.message, /Индексация прервана/);
  assert.equal(normalized.sources[0].status, "interrupted");
  assert.equal(normalized.sources[1].status, "completed");
  assert.equal(run.status, "running");
});

test("daily agent persists OCR page progress for UI polling", () => {
  assert.match(dailyAgentJs, /ocrPage:\s*progress\.ocrPage/);
  assert.match(dailyAgentJs, /ocrPages:\s*progress\.ocrPages/);
  assert.match(dailyAgentJs, /ocrTotalPages:\s*progress\.ocrTotalPages/);
});

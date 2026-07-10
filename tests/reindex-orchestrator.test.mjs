import assert from "node:assert/strict";
import test from "node:test";

import {
  createReindexReport,
  createReindexStats,
  qualityReindexDecision,
  qualityReindexReasons,
  reindexOrchestratorSettings,
  updateReindexStats
} from "../apps/rag-api/src/reindex-orchestrator.js";

const settings = {
  enabled: true,
  maxAttempts: 1,
  minScore: 60
};

test("qualityReindexDecision queues retry for severe recognition warnings", () => {
  const decision = qualityReindexDecision({
    quality: { status: "error", score: 10, warnings: ["no_chunks", "too_few_words"], chunks: 0 },
    fromCache: false,
    settings
  });

  assert.equal(decision.queued, true);
  assert.ok(decision.reasons.includes("quality_error"));
  assert.ok(decision.reasons.includes("no_chunks"));
});

test("qualityReindexReasons does not retry OCR page limit by itself", () => {
  assert.deepEqual(
    qualityReindexReasons(
      { status: "warning", score: 85, warnings: ["ocr_limited"], chunks: 3 },
      { fromCache: true, settings }
    ),
    []
  );
});

test("reindex settings and max attempts can disable retries", () => {
  const disabled = reindexOrchestratorSettings({
    RAG_REINDEX_ORCHESTRATOR_DISABLED: "1",
    RAG_REINDEX_MAX_ATTEMPTS: "3"
  });

  assert.equal(disabled.enabled, false);
  assert.equal(disabled.maxAttempts, 3);
  assert.equal(qualityReindexDecision({
    quality: { status: "error", score: 0, warnings: ["no_chunks"] },
    settings: disabled
  }).queued, false);
  assert.equal(qualityReindexDecision({
    quality: { status: "error", score: 0, warnings: ["no_chunks"] },
    attempt: 1,
    settings
  }).queued, false);
});

test("createReindexReport and stats capture resolved and failed retries", () => {
  const stats = createReindexStats();
  const decision = qualityReindexDecision({
    quality: { status: "error", score: 0, warnings: ["no_chunks"] },
    settings
  });
  const report = createReindexReport({
    decision,
    initialQuality: { status: "error", score: 0, warnings: ["no_chunks"], chunks: 0 },
    finalQuality: { status: "ok", score: 100, warnings: [], chunks: 2 },
    settings
  });

  updateReindexStats(stats, report);
  assert.equal(report.status, "resolved");
  assert.equal(report.improved, true);
  assert.equal(stats.retried, 1);
  assert.equal(stats.resolved, 1);

  updateReindexStats(stats, createReindexReport({
    decision,
    initialQuality: { status: "error", score: 0, warnings: ["no_chunks"], chunks: 0 },
    finalQuality: { status: "error", score: 0, warnings: ["no_chunks"], chunks: 0 },
    error: "OCR failed",
    settings
  }));
  assert.equal(stats.failed, 1);
});

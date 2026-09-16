import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  METRIC_NOT_AVAILABLE,
  METRIC_OK,
  computeProductMetrics,
  evidenceMatches,
  missingRequiredMetrics,
  silentMetricFailures
} from "../scripts/product-eval/metrics.mjs";
import {
  CASE_CLASSES,
  missingCaseClasses,
  normalizeProductCase,
  validateProductCase
} from "../scripts/product-eval/schema.mjs";
import { runProductEvals } from "../scripts/run-product-evals.mjs";

function result(overrides = {}) {
  return {
    rank: 1,
    sourceId: "p1",
    path: "fixtures/p1/smeta.md",
    text: "| 7 | Монолитные работы | 98 500 000 |",
    citationTarget: { sheetName: "Сводная", rowStart: 5, rowEnd: 12 },
    ...overrides
  };
}

function evidence(overrides = {}) {
  return { sourceId: "p1", file: "smeta.md", includes: "98 500 000", section: "", sheet: "Сводная", page: null, row: 7, ...overrides };
}

test("evidenceMatches separates file hit, content hit and exact citation location", () => {
  const wrongSheet = result({ citationTarget: { sheetName: "Материалы", rowStart: 1, rowEnd: 12 } });
  assert.equal(evidenceMatches(wrongSheet, evidence(), "file"), true);
  assert.equal(evidenceMatches(wrongSheet, evidence(), "content"), true);
  assert.equal(evidenceMatches(wrongSheet, evidence(), "exact"), false);
  assert.equal(evidenceMatches(result(), evidence(), "exact"), true);
  assert.equal(evidenceMatches(result({ sourceId: "p2" }), evidence(), "file"), false);
  assert.equal(evidenceMatches(result({ text: "другой текст" }), evidence(), "content"), false);
});

test("evidenceMatches checks page ranges for OCR evidence", () => {
  const ocr = evidence({ file: "scan.md", includes: "с 01.07.2026", sheet: "", row: null, page: 2 });
  const page2 = result({ path: "fixtures/p1/scan.md", text: "приостановке работ с 01.07.2026", citationTarget: { pageStart: 2, pageEnd: 2 } });
  assert.equal(evidenceMatches(page2, ocr, "exact"), true);
  assert.equal(evidenceMatches({ ...page2, citationTarget: { pageStart: 1, pageEnd: 1 } }, ocr, "exact"), false);
});

test("validateProductCase rejects unknown classes, missing evidence and follow-up without history", () => {
  const bad = normalizeProductCase({ id: "x", class: "unknown", question: "?", expected: { status: "verified", sourceIds: ["p1"] } });
  const errors = validateProductCase(bad);
  assert.ok(errors.some((error) => error.includes("unknown class")));
  assert.ok(errors.some((error) => error.includes("expected.evidence must be an array")));

  const followUp = normalizeProductCase({
    id: "f",
    class: "follow_up",
    question: "А срок?",
    expected: { status: "verified", sourceIds: ["p1"], evidence: [evidence()] }
  });
  assert.ok(validateProductCase(followUp).some((error) => error.includes("needs history")));
  assert.equal(missingCaseClasses([followUp]).length, CASE_CLASSES.length - 1);
});

test("metrics are explicit: empty denominators become NOT_AVAILABLE with a reason", () => {
  const metrics = computeProductMetrics([]);
  assert.equal(metrics.retrieval.recallAt5.status, METRIC_NOT_AVAILABLE);
  assert.ok(metrics.retrieval.recallAt5.reason);
  assert.deepEqual(silentMetricFailures(metrics), []);
  assert.ok(missingRequiredMetrics(metrics).includes("retrieval.recallAt5"));
  assert.deepEqual(silentMetricFailures({ retrieval: { broken: { status: METRIC_OK, value: null } } }), ["retrieval.broken"]);
});

test("runProductEvals fails on an empty eval directory", async (t) => {
  const emptyDir = await fs.mkdtemp(path.join(os.tmpdir(), "localai-product-eval-empty-"));
  t.after(() => fs.rm(emptyDir, { recursive: true, force: true }));
  const { problems } = await runProductEvals({ evalsDir: emptyDir });
  assert.ok(problems.some((problem) => problem.includes("no product eval cases")));
});

test("committed product-v2 eval set covers all classes and computes required metrics", async () => {
  const { problems, rows, metrics } = await runProductEvals();
  assert.deepEqual(problems, []);
  assert.deepEqual(missingCaseClasses(rows.map((row) => row.testCase)), []);
  assert.deepEqual(missingRequiredMetrics(metrics), []);
  // The set must distinguish "right file" from "right evidence/citation".
  assert.ok(metrics.retrieval.fileRecallAt5.value >= metrics.retrieval.recallAt5.value);
});

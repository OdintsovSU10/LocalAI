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
  assert.ok(silentMetricFailures({ retrieval: { broken: { status: METRIC_OK, value: null } } }).includes("retrieval.broken"));
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

test("silentMetricFailures flags metrics and groups that disappeared from the report", async () => {
  const { metrics } = await runProductEvals();
  const withoutNumeric = structuredClone(metrics);
  delete withoutNumeric.answer.numericFidelity;
  assert.ok(silentMetricFailures(withoutNumeric).includes("answer.numericFidelity"));

  const withoutVerifier = structuredClone(metrics);
  delete withoutVerifier.verifier;
  const failures = silentMetricFailures(withoutVerifier);
  assert.ok(failures.includes("verifier.falsePassRate"));
  assert.ok(failures.includes("verifier.falseRejectRate"));
});

test("product eval --json report inside the eval directory is rejected, repeated runs stay green", async (t) => {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const run = promisify(execFile);
  const evalsDir = await fs.mkdtemp(path.join(os.tmpdir(), "localai-product-eval-rerun-"));
  t.after(() => fs.rm(evalsDir, { recursive: true, force: true }));
  await fs.copyFile(path.join("evals", "product-v2", "contracts-core.json"), path.join(evalsDir, "contracts-core.json"));
  const script = path.join("scripts", "run-product-evals.mjs");

  const inside = await run(process.execPath, [script, "--dir", evalsDir, "--json", path.join(evalsDir, "report.json")]).catch((error) => error);
  assert.equal(inside.code, 1);
  assert.match(String(inside.stderr), /outside the eval directory/);

  const reportPath = path.join(os.tmpdir(), `localai-product-eval-report-${process.pid}.json`);
  t.after(() => fs.rm(reportPath, { force: true }));
  for (let attempt = 0; attempt < 2; attempt += 1) {
    await run(process.execPath, [script, "--dir", evalsDir, "--json", reportPath]);
  }
  const report = JSON.parse(await fs.readFile(reportPath, "utf8"));
  assert.deepEqual(report.problems, []);
});

test("Retrieval 2.0 does not regress recall and fixes citation and current-version metrics", async () => {
  const v2 = (await runProductEvals({ retrievalMode: "v2" })).metrics.retrieval;
  const legacy = (await runProductEvals({ retrievalMode: "legacy" })).metrics.retrieval;
  assert.ok(v2.recallAt5.value >= legacy.recallAt5.value, `R@5 ${v2.recallAt5.value} < legacy ${legacy.recallAt5.value}`);
  assert.ok(v2.recallAt10.value >= legacy.recallAt10.value);
  assert.ok(v2.mrr.value >= legacy.mrr.value);
  assert.equal(v2.citationTargetAccuracy.value, 1);
  assert.equal(v2.currentVersionAccuracy.value, 1);
  assert.equal(v2.wrongProjectLeakRateAt5.value, 0);
});

test("the verifier gate rejects every deterministic adversarial claim and keeps every supported one", async () => {
  const { problems, metrics, verifierRows } = await runProductEvals();
  assert.deepEqual(problems, []);
  assert.equal(metrics.verifier.falseRejectRate.value, 0);
  assert.equal(metrics.verifier.falsePassRate.mode, "deterministic checks");
  for (const row of verifierRows.filter((entry) => ["numeric", "version", "scope", "citation"].includes(entry.testCase.category))) {
    assert.equal(row.passed, false, `${row.testCase.id} passed the deterministic checks`);
  }
  // Semantic errors (wrong party, invented condition) need the verifier model: counted, not hidden.
  const semantic = verifierRows.filter((entry) => entry.testCase.category === "semantic");
  assert.ok(semantic.length >= 3);
  assert.equal(metrics.verifier.falsePassRate.numerator, semantic.filter((entry) => entry.passed).length);
});

test("the verifier gate counts the verifier model when one is given", async () => {
  const chatCompletion = async ({ messages }) => {
    const claims = [...messages.at(-1).content.matchAll(/^\{"claim_id".*\}$/gm)].map((line) => JSON.parse(line[0]));
    // A strict fake verifier: rejects claims about who pays or terminates and invented conditions.
    const status = /Генподрядчик Заказчику|Генподрядчик вправе|страхования/.test(claims[0].text) ? "contradicted" : "supported";
    return { model: "judge", text: JSON.stringify({ overall: "pass", claims: [{ claim_id: "c1", status, supported_by: [], issues: [] }], missing_evidence_queries: [], conflicts: [] }) };
  };
  const { metrics } = await runProductEvals({ verifierLlm: { model: "judge" }, chatCompletion });
  assert.equal(metrics.verifier.falsePassRate.value, 0);
  assert.equal(metrics.verifier.falseRejectRate.value, 0);
  assert.equal(metrics.verifier.falsePassRate.mode, "deterministic checks + verifier model");
});

test("a deterministic gate regression makes the eval fail, a semantic miss does not", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "localai-verifier-eval-"));
  try {
    const cases = [
      // Labelled as a numeric negative, but the claim is true: the checks let it pass -> regression.
      { id: "regression-numeric", category: "numeric", sourceId: "pv2-stromynka", expected: "unsupported",
        claim: { text: "Гарантийное удержание составляет 3% от стоимости выполненных работ.", kind: "percentage", evidence: [{ file: "dogovor-15-p.md", includes: "5.1. Из каждого платежа" }] } },
      { id: "semantic-miss", category: "semantic", sourceId: "pv2-stromynka", expected: "unsupported",
        claim: { text: "Гарантийное удержание может быть заменено договором страхования.", kind: "condition", evidence: [{ file: "dogovor-15-p.md", includes: "5.3. По согласованию сторон" }] } },
      { id: "supported-ok", category: "supported", sourceId: "pv2-stromynka", expected: "supported",
        claim: { text: "Цена договора составляет 245 000 000 рублей.", kind: "amount", evidence: [{ file: "dogovor-15-p.md", includes: "2.1. Цена договора" }] } }
    ];
    await fs.writeFile(path.join(dir, "set.json"), JSON.stringify({ corpus: "fixtures/product-v2", cases }), "utf8");
    const { problems } = await runProductEvals({ verifierDir: dir });
    assert.deepEqual(problems, ["verifier gate: numeric claim regression-numeric passed the checks"]);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

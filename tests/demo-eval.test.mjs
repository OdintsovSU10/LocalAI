import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { formatCitationLabel } from "../apps/rag-api/src/citations.js";
import {
  buildDemoIndex,
  demoEvalFile,
  demoSettings,
  loadEvalCases,
  projectRoot,
  retrievalSearch
} from "../scripts/eval-utils.mjs";

test("demo eval parser loads meaningful cases", async () => {
  const cases = await loadEvalCases({ filePath: demoEvalFile });

  assert.equal(cases.length, 6);
  for (const testCase of cases) {
    assert.ok(testCase.id);
    assert.ok(testCase.question);
    assert.ok(testCase.expectedFileHint, `${testCase.id} should declare expectedFileHint`);
    assert.equal(testCase.mustCite, true, `${testCase.id} should require citations`);
    assert.ok(testCase.mustContain.length, `${testCase.id} should declare mustContain`);
  }
});

test("demo fixture builds deterministic source summary with neutral paths", async () => {
  const demo = await buildDemoIndex();

  assert.equal(demo.sourceSummary.fileCount, 5);
  assert.ok(demo.sourceSummary.chunkCount >= 5);
  assert.match(demo.sourceSummary.deterministicSummary, /5 files/);

  for (const chunk of demo.chunks) {
    assert.equal(path.isAbsolute(chunk.path), false);
    assert.equal(chunk.path.includes(projectRoot), false);
  }
});

test("demo markdown chunks produce citation labels with section names", async () => {
  const demo = await buildDemoIndex();
  const chunk = demo.chunks.find((item) => item.sectionTitle);

  assert.ok(chunk);
  assert.match(formatCitationLabel(chunk), /\.md/);
  assert.ok(formatCitationLabel(chunk).includes("\u0440\u0430\u0437\u0434\u0435\u043b"));
});

test("demo retrieval cases hit expected files in top five", async () => {
  const cases = await loadEvalCases({ filePath: demoEvalFile });
  const demo = await buildDemoIndex();

  for (const testCase of cases) {
    const retrieval = retrievalSearch({ testCase, chunks: demo.chunks, settings: demoSettings });
    assert.equal(retrieval.evaluated, true, testCase.id);
    assert.equal(retrieval.recallAt5, true, `${testCase.id} should hit ${testCase.expectedFileHint}`);
  }
});

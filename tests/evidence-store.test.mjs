import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createEvidenceStore } from "../apps/rag-api/src/evidence/evidence-store.js";
import { buildFixtureSourceEvidence } from "./helpers/evidence-fixtures.mjs";

// The store is closed before the temp dir is removed: an open SQLite file cannot be deleted on Windows.
async function openTempStore(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "localai-evidence-"));
  const databasePath = path.join(dir, "state", "evidence.sqlite");
  const store = await createEvidenceStore({ databasePath });
  t.after(async () => {
    store.close();
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  return { store, databasePath };
}

test("replaceSourceEvidence stores a build and is idempotent", async (t) => {
  const { store } = await openTempStore(t);
  const build = await buildFixtureSourceEvidence("pv2-stromynka");

  const first = store.replaceSourceEvidence(build);
  assert.equal(first.documentCount, build.documents.length);
  assert.equal(first.spanCount, build.spans.length);
  assert.equal(first.factCount, build.facts.length);
  const factIds = store.listFacts({ sourceId: "pv2-stromynka" }).map((fact) => fact.factId).sort();

  const second = store.replaceSourceEvidence(build);
  assert.equal(second.factCount, first.factCount);
  assert.deepEqual(store.listFacts({ sourceId: "pv2-stromynka" }).map((fact) => fact.factId).sort(), factIds);
  assert.equal(store.listDocuments("pv2-stromynka").length, 4);
  assert.equal(store.listRelations("pv2-stromynka")[0].relation, "amends");
  assert.equal(store.listConflicts("pv2-stromynka")[0].typeGroup, "total_cost");
});

test("sources are replaced independently", async (t) => {
  const { store } = await openTempStore(t);
  store.replaceSourceEvidence(await buildFixtureSourceEvidence("pv2-stromynka"));
  store.replaceSourceEvidence(await buildFixtureSourceEvidence("pv2-balchug"));
  store.replaceSourceEvidence(await buildFixtureSourceEvidence("pv2-balchug"));
  assert.equal(store.listDocuments("pv2-stromynka").length, 4);
  assert.equal(store.listDocuments("pv2-balchug").length, 1);
  assert.deepEqual(store.listFacts({ sourceId: "pv2-balchug", factType: "advance_percent" }).map((fact) => fact.normalized), [{ percent: 30 }]);
});

test("fact trace leads from a fact to its evidence span, preview target, document and amendment history", async (t) => {
  const { store } = await openTempStore(t);
  store.replaceSourceEvidence(await buildFixtureSourceEvidence("pv2-stromynka"));

  const [current] = store.listFacts({ sourceId: "pv2-stromynka", factType: "advance_percent", status: "active" });
  const trace = store.getFactTrace(current.factId);
  assert.deepEqual(trace.fact.normalized, { percent: 10 });
  assert.equal(trace.document.kind, "amendment");
  assert.equal(trace.document.fileLabel, "ds-01-k-dogovoru-15-p.md");
  assert.equal(trace.evidence.length, 1);
  assert.equal(trace.evidence[0].sectionTitle, "1. Изменение размера аванса");
  assert.ok(trace.evidence[0].text.includes("аванс в размере 10%"));
  assert.equal(trace.evidence[0].preview.sourceId, "pv2-stromynka");
  assert.ok(trace.evidence[0].preview.chunkId);
  assert.ok(trace.evidence[0].preview.focusText.includes("10%"));
  assert.deepEqual(trace.supersedes.normalized, { percent: 20 });
  assert.equal(trace.supersededBy, null);

  const oldTrace = store.getFactTrace(trace.supersedes.factId);
  assert.equal(oldTrace.fact.status, "superseded");
  assert.equal(oldTrace.fact.validTo, "2026-05-15");
  assert.equal(oldTrace.supersededBy.factId, current.factId);
  assert.equal(oldTrace.document.kind, "contract");

  const [total] = store.listFacts({ sourceId: "pv2-stromynka", factType: "estimate_total" });
  const totalTrace = store.getFactTrace(total.factId);
  assert.equal(totalTrace.evidence[0].sheetName, "Сводная");
  assert.equal(totalTrace.evidence[0].rowStart, 12);
  assert.equal(totalTrace.conflicts.length, 1);
  assert.equal(store.getFactTrace("fact_missing"), null);
});

test("stored evidence has no absolute paths and invalid builds leave the previous build intact", async (t) => {
  const { store, databasePath } = await openTempStore(t);
  const build = await buildFixtureSourceEvidence("pv2-balchug");
  const withPathLabel = {
    ...build,
    documents: build.documents.map((document) => ({ ...document, fileLabel: "D:\\\\private\\\\projects\\\\dogovor-b-44.md" }))
  };
  store.replaceSourceEvidence(withPathLabel);
  assert.equal(store.listDocuments("pv2-balchug")[0].fileLabel, "dogovor-b-44.md");

  const broken = { ...build, facts: [{ ...build.facts[0], evidenceIds: [] }] };
  assert.throws(() => store.replaceSourceEvidence(broken), /has no evidence/);
  assert.equal(store.listFacts({ sourceId: "pv2-balchug" }).length, build.facts.length);

  const dump = JSON.stringify({
    documents: store.listDocuments("pv2-balchug"),
    facts: store.listFacts({ sourceId: "pv2-balchug" }),
    traces: store.listFacts({ sourceId: "pv2-balchug" }).map((fact) => store.getFactTrace(fact.factId))
  });
  assert.ok(!dump.includes("private"));
  assert.ok(!dump.includes(path.dirname(databasePath)));
});

test("evidence migrations are idempotent across reopen", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "localai-evidence-reopen-"));
  const databasePath = path.join(dir, "evidence.sqlite");
  const first = await createEvidenceStore({ databasePath });
  first.replaceSourceEvidence(await buildFixtureSourceEvidence("pv2-balchug"));
  first.close();
  const second = await createEvidenceStore({ databasePath });
  t.after(async () => {
    second.close();
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  assert.equal(second.getSourceSummary("pv2-balchug").documentCount, 1);
});

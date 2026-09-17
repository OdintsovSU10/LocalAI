// Stage 04 contract: index a synthetic contract folder through the API, build evidence and follow
// fact -> evidence span -> exact preview fragment.
//
//   npm run test:evidence-contract
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import {
  addSource,
  createTempRuntime,
  indexSource,
  postJson,
  projectRoot,
  requestJson,
  startApi
} from "./helpers/chat-runtime.mjs";

const KEEP_TEMP = process.env.EVIDENCE_CONTRACT_KEEP_TEMP === "1";

async function waitForEvidenceBuild(baseUrl, sourceId, timeoutMs = 30000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const { payload } = await requestJson(baseUrl, `/api/evidence/sources/${encodeURIComponent(sourceId)}`);
    if (payload?.build) return payload;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`evidence build for ${sourceId} did not appear after indexing`);
}

function assertNoAbsolutePaths(value, root, label) {
  const text = JSON.stringify(value);
  for (const variant of [root, root.replaceAll("\\", "/"), root.replaceAll("\\", "\\\\")]) {
    assert.ok(!text.includes(variant), `${label} contains an absolute path`);
  }
}

test("evidence API: documents, amendment graph, fact trace and preview of the exact fragment", { timeout: 10 * 60 * 1000 }, async (t) => {
  const runDir = path.join(projectRoot, ".tmp", "evidence-contract", `run-${process.pid}-${Date.now()}`);
  let api = null;
  // Stop the API (it holds evidence.sqlite open) before removing the runtime: Windows cannot delete open files.
  t.after(async () => {
    if (api) await api.stop();
    if (!KEEP_TEMP) await fs.rm(runDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });
  const root = await createTempRuntime({ runDir, label: "head", extraFixtures: ["product-v2"] });
  api = await startApi({ root, llmEnabled: false });

  const stromynka = await addSource(api.baseUrl, { title: "ЖК Сокольники, Стромынка", folder: path.join(root, "fixtures", "product-v2", "stromynka") });
  await indexSource(api.baseUrl, stromynka.id);

  const rebuilt = await postJson(api.baseUrl, "/api/evidence/rebuild", { sourceId: stromynka.id });
  assert.equal(rebuilt.status, 200);
  assert.equal(rebuilt.payload.summary.documentCount, 4);
  assert.equal(rebuilt.payload.relations, 1);
  assert.equal(rebuilt.payload.conflicts, 1);

  const overview = await requestJson(api.baseUrl, `/api/evidence/sources/${encodeURIComponent(stromynka.id)}`);
  assert.deepEqual(overview.payload.documents.map((document) => document.kind).sort(), ["amendment", "contract", "estimate", "letter"]);
  assert.equal(overview.payload.relations[0].relation, "amends");
  assert.equal(overview.payload.conflicts[0].typeGroup, "total_cost");
  assertNoAbsolutePaths(overview.payload, root, "evidence overview");

  const advances = await requestJson(api.baseUrl, `/api/evidence/facts?sourceId=${encodeURIComponent(stromynka.id)}&type=advance_percent`);
  const active = advances.payload.facts.filter((fact) => fact.status === "active");
  const superseded = advances.payload.facts.filter((fact) => fact.status === "superseded");
  assert.deepEqual(active.map((fact) => fact.normalized.percent), [10]);
  assert.deepEqual(superseded.map((fact) => fact.normalized.percent), [20]);

  const trace = await requestJson(api.baseUrl, `/api/evidence/facts/${active[0].factId}/trace`);
  assert.equal(trace.status, 200);
  assert.equal(trace.payload.document.kind, "amendment");
  assert.equal(trace.payload.supersedes.factId, superseded[0].factId);
  const [evidence] = trace.payload.evidence;
  assert.ok(evidence.preview.chunkId, "evidence span has no chunk to preview");
  assertNoAbsolutePaths(trace.payload, root, "fact trace");

  // One click: the preview endpoint opens the exact fragment of the evidence span.
  const params = new URLSearchParams({
    sourceId: evidence.preview.sourceId,
    chunkId: evidence.preview.chunkId,
    focusText: evidence.preview.focusText
  });
  const preview = await requestJson(api.baseUrl, `/api/files/preview?${params}`);
  assert.equal(preview.status, 200);
  assert.equal(preview.payload.targetMatched, true);
  const previewText = [preview.payload.excerpt, preview.payload.text, preview.payload.markdown].filter(Boolean).join("\n");
  assert.ok(previewText.includes("10%"), "preview does not show the evidence fragment");

  const totals = await requestJson(api.baseUrl, `/api/evidence/facts?sourceId=${encodeURIComponent(stromynka.id)}&type=estimate_total`);
  const totalTrace = await requestJson(api.baseUrl, `/api/evidence/facts/${totals.payload.facts[0].factId}/trace`);
  assert.equal(totalTrace.payload.evidence[0].sheetName, "Сводная");
  assert.equal(totalTrace.payload.evidence[0].rowStart, 12);

  assert.equal((await postJson(api.baseUrl, "/api/evidence/rebuild", { sourceId: "missing-source" })).status, 404);
  assert.equal((await requestJson(api.baseUrl, "/api/evidence/facts")).status, 400);
  assert.equal((await requestJson(api.baseUrl, "/api/evidence/facts/fact_missing/trace")).status, 404);

  // Indexing through the API rebuilds evidence in the background without an explicit call.
  const balchug = await addSource(api.baseUrl, { title: "Балчуг, Садовническая", folder: path.join(root, "fixtures", "product-v2", "balchug") });
  await indexSource(api.baseUrl, balchug.id);
  const automatic = await waitForEvidenceBuild(api.baseUrl, balchug.id);
  assert.equal(automatic.documents.length, 1);
  assert.equal(automatic.documents[0].kind, "contract");
});

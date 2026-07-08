import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const envKeys = [
  "DOTENV_CONFIG_PATH",
  "RAG_DATA_DIR",
  "RAG_METADATA_PROVIDER",
  "RAG_METADATA_SQLITE_PATH",
  "RAG_EMBEDDINGS_ENABLED",
  "RAG_VECTOR_STORE_ENABLED",
  "RAG_RERANKER_ENABLED",
  "RAG_OCR_ENABLED"
];

function snapshotEnv() {
  return Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
}

function restoreEnv(snapshot) {
  for (const key of envKeys) {
    if (snapshot[key] === undefined) delete process.env[key];
    else process.env[key] = snapshot[key];
  }
}

async function withTempRuntime(t, provider = "json") {
  const previous = snapshotEnv();
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "localai-summary-storage-test-"));
  const dataDir = path.join(root, "data");
  process.env.DOTENV_CONFIG_PATH = path.join(root, ".env.disabled");
  process.env.RAG_DATA_DIR = dataDir;
  process.env.RAG_METADATA_PROVIDER = provider;
  process.env.RAG_METADATA_SQLITE_PATH = path.join(dataDir, "state", "metadata.sqlite");
  process.env.RAG_EMBEDDINGS_ENABLED = "false";
  process.env.RAG_VECTOR_STORE_ENABLED = "false";
  process.env.RAG_RERANKER_ENABLED = "false";
  process.env.RAG_OCR_ENABLED = "false";
  t.after(async () => {
    restoreEnv(previous);
    await fs.rm(root, { recursive: true, force: true });
  });
  return { root, dataDir };
}

function sampleSummary(sourceId, overrides = {}) {
  return {
    sourceId,
    sourceTitle: "Summary Storage Test",
    updatedAt: "2026-06-30T08:00:00.000Z",
    fileCount: 1,
    chunkCount: 2,
    topFileTypes: [{ extension: ".md", count: 1 }],
    qualityWarnings: {
      total: 0,
      byWarning: [],
      files: []
    },
    deterministicSummary: "1 file, 2 chunks, no quality warnings.",
    ...overrides
  };
}

function assertStableSummaryShape(summary, sourceId) {
  assert.equal(summary.sourceId, sourceId);
  assert.equal(typeof summary.updatedAt, "string");
  assert.equal(typeof summary.fileCount, "number");
  assert.equal(typeof summary.chunkCount, "number");
  assert.ok(Array.isArray(summary.topFileTypes));
  assert.equal(typeof summary.qualityWarnings, "object");
}

test("source summary JSON storage round-trips write, read, update, and missing summary", async (t) => {
  const { root } = await withTempRuntime(t, "json");
  const summaryPath = path.join(root, "state", "source-summaries.json");
  const {
    readSourceSummariesJson,
    readSourceSummaryJson,
    writeSourceSummaryJson
  } = await import("../apps/rag-api/src/store.js");

  assert.equal(await readSourceSummaryJson("missing-json-summary", summaryPath), null);

  const first = sampleSummary("json-summary-source");
  assert.deepEqual(await writeSourceSummaryJson(first, summaryPath), first);
  assert.deepEqual(await readSourceSummaryJson(first.sourceId, summaryPath), first);
  assertStableSummaryShape(await readSourceSummaryJson(first.sourceId, summaryPath), first.sourceId);

  const updated = sampleSummary(first.sourceId, {
    updatedAt: "2026-06-30T09:00:00.000Z",
    fileCount: 2,
    chunkCount: 5,
    topFileTypes: [{ extension: ".md", count: 2 }]
  });
  await writeSourceSummaryJson(updated, summaryPath);
  assert.deepEqual(await readSourceSummaryJson(first.sourceId, summaryPath), updated);

  const all = await readSourceSummariesJson(summaryPath);
  assert.deepEqual(Object.keys(all.summaries), [first.sourceId]);
});

test("source summary SQLite storage round-trips schema, write, read, update, and missing summary", async (t) => {
  const { dataDir } = await withTempRuntime(t, "sqlite");
  const storage = {
    sqlite: {
      databasePath: path.join(dataDir, "state", "metadata.sqlite")
    }
  };
  const {
    assertSqliteMetadataAvailable,
    readSourceSummaryFromSqlite,
    readSourceSummariesFromSqlite,
    writeSourceSummaryToSqlite
  } = await import("../apps/rag-api/src/sqlite-metadata-store.js");

  await assertSqliteMetadataAvailable(storage);
  assert.equal(await readSourceSummaryFromSqlite("missing-sqlite-summary", storage), null);

  const first = sampleSummary("sqlite-summary-source");
  assert.deepEqual(await writeSourceSummaryToSqlite(first, storage), first);
  assert.deepEqual(await readSourceSummaryFromSqlite(first.sourceId, storage), first);
  assertStableSummaryShape(await readSourceSummaryFromSqlite(first.sourceId, storage), first.sourceId);

  const updated = sampleSummary(first.sourceId, {
    updatedAt: "2026-06-30T09:30:00.000Z",
    fileCount: 3,
    chunkCount: 8,
    qualityWarnings: {
      total: 1,
      byWarning: [{ warning: "low_text", count: 1 }],
      files: [{ fileId: "demo", title: "demo.md", warnings: ["low_text"] }]
    },
    deterministicSummary: "3 files, 8 chunks, 1 quality warning."
  });
  await writeSourceSummaryToSqlite(updated, storage);
  assert.deepEqual(await readSourceSummaryFromSqlite(first.sourceId, storage), updated);

  const all = await readSourceSummariesFromSqlite(storage);
  assert.deepEqual(Object.keys(all.summaries), [first.sourceId]);
});

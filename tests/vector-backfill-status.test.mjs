import assert from "node:assert/strict";
import test from "node:test";

import {
  buildCompletedVectorBackfillJob,
  buildVectorBackfillRows
} from "../apps/rag-api/src/vector-backfill-status.js";

function chunks(sourceId, count) {
  return Array.from({ length: count }, (_, index) => ({
    id: `${sourceId}-chunk-${index}`,
    sourceId
  }));
}

function vectors(sourceId, count) {
  return {
    items: Object.fromEntries(
      Array.from({ length: count }, (_, index) => [
        `${sourceId}-chunk-${index}`,
        { sourceId }
      ])
    )
  };
}

function singleRow(options) {
  const rows = buildVectorBackfillRows({
    sources: [{ id: "source-a", title: "A" }],
    chunks: chunks("source-a", options.chunks),
    vectors: vectors("source-a", options.jsonVectors || 0),
    settings: {
      vectorStore: {
        enabled: true,
        provider: options.provider
      }
    },
    qdrantCounts: new Map([["source-a", options.qdrantVectors || 0]]),
    qdrantAvailable: Boolean(options.qdrantAvailable),
    qdrantError: options.qdrantError || "",
    qdrantWarning: options.qdrantWarning || ""
  });
  return rows[0];
}

test("buildVectorBackfillRows keeps vectors as jsonVectors for json provider", () => {
  const row = singleRow({
    provider: "json",
    chunks: 5,
    jsonVectors: 5,
    qdrantVectors: 0,
    qdrantAvailable: false
  });

  assert.equal(row.vectors, 5);
  assert.equal(row.jsonVectors, 5);
  assert.equal(row.qdrantVectors, 0);
  assert.equal(row.storedVectors, 5);
  assert.equal(row.vectorProviderUsed, "json");
  assert.equal(row.ready, true);
  assert.equal(row.missing, 0);
});

test("buildVectorBackfillRows uses qdrantVectors for qdrant provider", () => {
  const row = singleRow({
    provider: "qdrant",
    chunks: 62,
    jsonVectors: 0,
    qdrantVectors: 62,
    qdrantAvailable: true
  });

  assert.equal(row.vectors, 0);
  assert.equal(row.jsonVectors, 0);
  assert.equal(row.qdrantVectors, 62);
  assert.equal(row.storedVectors, 62);
  assert.equal(row.vectorProviderUsed, "qdrant");
  assert.equal(row.ready, true);
  assert.equal(row.missing, 0);
});

test("buildVectorBackfillRows falls back to json with warning in auto when qdrant is down", () => {
  const row = singleRow({
    provider: "auto",
    chunks: 5,
    jsonVectors: 4,
    qdrantVectors: 5,
    qdrantAvailable: false,
    qdrantError: "fetch failed"
  });

  assert.equal(row.vectorProviderUsed, "json");
  assert.equal(row.storedVectors, 4);
  assert.equal(row.ready, false);
  assert.equal(row.missing, 1);
  assert.match(row.warning, /fetch failed/);
});

test("buildVectorBackfillRows marks qdrant-only Zilart-sized source as ready", () => {
  const row = singleRow({
    provider: "qdrant",
    chunks: 62299,
    jsonVectors: 0,
    qdrantVectors: 62299,
    qdrantAvailable: true
  });

  assert.equal(row.vectors, 0);
  assert.equal(row.jsonVectors, 0);
  assert.equal(row.storedVectors, 62299);
  assert.equal(row.ready, true);
  assert.equal(row.missing, 0);
});

test("buildCompletedVectorBackfillJob returns completed job for ready source", () => {
  const row = singleRow({
    provider: "qdrant",
    chunks: 10,
    jsonVectors: 0,
    qdrantVectors: 10,
    qdrantAvailable: true
  });

  const job = buildCompletedVectorBackfillJob({
    row,
    id: "job-1",
    now: "2026-07-01T00:00:00.000Z"
  });

  assert.equal(job.status, "completed");
  assert.equal(job.phase, "done");
  assert.equal(job.vectorsProcessed, 10);
  assert.equal(job.vectorsCached, 10);
  assert.equal(job.vectorsEmbedded, 0);
  assert.equal(job.ready, true);
});

test("buildCompletedVectorBackfillJob rejects incomplete source", () => {
  const row = singleRow({
    provider: "qdrant",
    chunks: 10,
    jsonVectors: 0,
    qdrantVectors: 9,
    qdrantAvailable: true
  });

  assert.throws(
    () => buildCompletedVectorBackfillJob({ row, id: "job-2" }),
    /not ready/
  );
});

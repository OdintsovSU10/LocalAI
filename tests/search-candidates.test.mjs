import assert from "node:assert/strict";
import test from "node:test";

import {
  buildLexicalCandidates,
  buildVectorCandidates,
  filterChunksBySource,
  rrfMergeCandidates,
  scoreSearchChunks
} from "../apps/rag-api/src/search-pipeline.js";

test("RRF merge does not duplicate the same chunk", () => {
  const chunk = { id: "chunk-1", text: "alpha" };
  const merged = rrfMergeCandidates({
    vectorCandidates: [{ chunk, chunkId: chunk.id, score: 0.8 }],
    lexicalCandidates: [{ chunk, chunkId: chunk.id, score: 2.4 }]
  });

  assert.equal(merged.length, 1);
  assert.equal(merged[0].chunkId, "chunk-1");
  assert.equal(merged[0].vectorRank, 1);
  assert.equal(merged[0].lexicalRank, 1);
});

test("lexical-only fallback builds candidates from chunks", () => {
  const chunks = [
    { id: "miss", sourceId: "source-a", text: "beta gamma", terms: ["beta", "gamma"] },
    { id: "hit", sourceId: "source-a", text: "alpha alpha", terms: ["alpha", "alpha"] }
  ];
  const lexicalCandidates = buildLexicalCandidates({
    chunks,
    queryTerms: ["alpha"],
    lexicalMode: "simple",
    topK: 10
  });
  const merged = rrfMergeCandidates({ lexicalCandidates });
  const scored = scoreSearchChunks({
    chunks: merged.map((candidate) => candidate.chunk),
    queryTerms: ["alpha"],
    lexicalScoreById: new Map(lexicalCandidates.map((candidate) => [candidate.chunkId, candidate.score]))
  });

  assert.equal(lexicalCandidates[0].chunkId, "hit");
  assert.equal(scored[0].id, "hit");
  assert.equal(scored[0].searchMode, "keyword");
  assert.ok(scored[0].score > 0);
});

test("vector-only fallback can produce candidates from vectors.json scores", () => {
  const chunks = [
    { id: "vector-hit", sourceId: "source-a", text: "unrelated" },
    { id: "vector-miss", sourceId: "source-a", text: "unrelated" }
  ];
  const vectorCandidates = buildVectorCandidates({
    chunks,
    queryVector: [1, 0],
    embeddingModel: "model-a",
    vectorItems: {
      "vector-hit": { model: "model-a", vector: [0.9, 0] },
      "vector-miss": { model: "model-a", vector: [0.1, 0] }
    },
    topK: 1
  });
  const merged = rrfMergeCandidates({ vectorCandidates });
  const scored = scoreSearchChunks({
    chunks: merged.map((candidate) => candidate.chunk),
    queryTerms: ["absent"],
    lexicalScoreById: new Map(),
    queryVector: [1, 0],
    embeddingModel: "model-a",
    vectorItems: {
      "vector-hit": { model: "model-a", vector: [0.9, 0] }
    }
  });

  assert.equal(vectorCandidates.length, 1);
  assert.equal(vectorCandidates[0].chunkId, "vector-hit");
  assert.equal(scored[0].id, "vector-hit");
  assert.equal(scored[0].searchMode, "hybrid");
  assert.ok(scored[0].vectorScore > 0);
});

test("sourceId filtering is preserved before candidate generation", () => {
  const chunks = [
    { id: "a", sourceId: "source-a", text: "alpha", terms: ["alpha"] },
    { id: "b", sourceId: "source-b", text: "alpha", terms: ["alpha"] }
  ];
  const filtered = filterChunksBySource(chunks, "source-a");
  const lexicalCandidates = buildLexicalCandidates({
    chunks: filtered,
    queryTerms: ["alpha"],
    topK: 10
  });

  assert.deepEqual(filtered.map((chunk) => chunk.id), ["a"]);
  assert.deepEqual(lexicalCandidates.map((candidate) => candidate.chunkId), ["a"]);
});

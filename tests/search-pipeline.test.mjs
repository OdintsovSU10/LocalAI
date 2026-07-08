import assert from "node:assert/strict";
import test from "node:test";

import { prepareSearchQuery } from "../apps/rag-api/src/search-query.js";
import {
  HYBRID_LEXICAL_WEIGHT,
  HYBRID_VECTOR_WEIGHT,
  mergeVectorLexicalScore,
  scoreChunk
} from "../apps/rag-api/src/search-scoring.js";
import { filterChunksBySource, scoreSearchChunks, vectorScoreForChunk } from "../apps/rag-api/src/search-pipeline.js";

test("scoreChunk keeps current lexical frequency and phrase scoring", () => {
  const score = scoreChunk(
    { text: "alpha beta alpha", terms: ["alpha", "beta", "alpha"] },
    ["alpha", "beta"],
    "alpha beta"
  );

  assert.equal(score, 8 + (2 + Math.log(3)) + (2 + Math.log(2)));
});

test("mergeVectorLexicalScore keeps current vector and lexical weights", () => {
  const merged = mergeVectorLexicalScore({
    vectorScore: 0.75,
    lexicalScore: 4,
    maxLexicalScore: 8,
    hasQueryVector: true
  });

  assert.equal(HYBRID_VECTOR_WEIGHT, 0.82);
  assert.equal(HYBRID_LEXICAL_WEIGHT, 0.18);
  assert.equal(merged.lexicalNormalized, 0.5);
  assert.equal(merged.vectorNormalized, 0.75);
  assert.ok(Math.abs(merged.scoreBase - ((0.75 * 0.82) + (0.5 * 0.18))) < Number.EPSILON);
});

test("scoreSearchChunks applies phrase boost after base merge", () => {
  const query = prepareSearchQuery("\u0446\u0435\u043d\u0430 \u0434\u043e\u0433\u043e\u0432\u043e\u0440\u0430");
  const [chunk] = scoreSearchChunks({
    chunks: [{
      id: "chunk-1",
      sourceId: "source-a",
      text: "\u0426\u0435\u043d\u0430 \u0434\u043e\u0433\u043e\u0432\u043e\u0440\u0430 \u0441\u043e\u0441\u0442\u0430\u0432\u043b\u044f\u0435\u0442 1 234 567,89 \u0440\u0443\u0431\u043b\u0435\u0439",
      terms: ["\u0446\u0435\u043d\u0430", "\u0434\u043e\u0433\u043e\u0432\u043e\u0440\u0430", "\u0441\u043e\u0441\u0442\u0430\u0432\u043b\u044f\u0435\u0442"]
    }],
    ...query
  });

  assert.equal(chunk.rerankBoost, 0.12);
  assert.equal(chunk.score, chunk.lexicalNormalized + 0.12);
});

test("filterChunksBySource keeps only requested source chunks", () => {
  const chunks = [
    { id: "a", sourceId: "source-a" },
    { id: "b", sourceId: "source-b" }
  ];

  assert.deepEqual(filterChunksBySource(chunks, "source-a").map((chunk) => chunk.id), ["a"]);
  assert.deepEqual(filterChunksBySource(chunks, "").map((chunk) => chunk.id), ["a", "b"]);
});

test("scoreSearchChunks falls back to lexical keyword mode without query embedding", () => {
  const results = scoreSearchChunks({
    chunks: [
      { id: "a", sourceId: "source-a", text: "alpha alpha", terms: ["alpha", "alpha"] },
      { id: "b", sourceId: "source-b", text: "alpha beta", terms: ["alpha", "beta"] }
    ],
    sourceId: "source-a",
    originalTerms: ["alpha"],
    queryTerms: ["alpha"],
    phrase: "",
    queryVector: null
  });

  assert.equal(results.length, 1);
  assert.equal(results[0].id, "a");
  assert.equal(results[0].searchMode, "keyword");
  assert.equal(results[0].vectorScore, 0);
  assert.equal(results[0].score, results[0].lexicalNormalized);
});

test("vectorScoreForChunk supports json vectors and qdrant scores without IO", () => {
  assert.equal(
    vectorScoreForChunk(
      { id: "chunk-1" },
      {
        queryVector: [1, 0.5],
        embeddingModel: "model-a",
        vectorItems: { "chunk-1": { model: "model-a", vector: [0.5, 0.5] } }
      }
    ),
    0.75
  );

  assert.equal(
    vectorScoreForChunk(
      { id: "chunk-1" },
      {
        queryVector: [1],
        vectorSource: "qdrant",
        qdrantScores: new Map([["chunk-1", 0.42]])
      }
    ),
    0.42
  );
});

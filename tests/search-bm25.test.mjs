import assert from "node:assert/strict";
import test from "node:test";

import { buildBm25Index, searchBm25 } from "../apps/rag-api/src/search-bm25.js";
import { prepareSearchQuery } from "../apps/rag-api/src/search-query.js";
import { lexicalScoresForChunks, scoreSearchChunks } from "../apps/rag-api/src/search-pipeline.js";

test("BM25 ranks a rare query term above a frequent common term", () => {
  const chunks = [
    { id: "common-heavy", text: "common common common common" },
    { id: "rare-hit", text: "rare" },
    { id: "common-light", text: "common" }
  ];
  const results = searchBm25(buildBm25Index(chunks), ["common", "rare"], chunks.length);

  assert.equal(results[0].chunk.id, "rare-hit");
});

test("BM25 length normalization favors a short relevant chunk over long noise", () => {
  const longNoise = `needle ${Array.from({ length: 160 }, (_, index) => `noise${index}`).join(" ")}`;
  const chunks = [
    { id: "long-noise", text: longNoise },
    { id: "short-hit", text: "needle" }
  ];
  const results = searchBm25(buildBm25Index(chunks), ["needle"], chunks.length);

  assert.equal(results[0].chunk.id, "short-hit");
  assert.ok(results[0].score > results[1].score);
});

test("BM25 uses metadata field boosts when title, path, or source title are available", () => {
  const chunks = [
    { id: "text-hit", title: "", path: "", sourceTitle: "", text: "zoning" },
    { id: "title-hit", title: "zoning", path: "", sourceTitle: "", text: "unrelated" }
  ];
  const results = searchBm25(buildBm25Index(chunks), ["zoning"], chunks.length);

  assert.equal(results[0].chunk.id, "title-hit");
});

test("BM25 handles Russian query terms after encoding recovery", () => {
  const query = prepareSearchQuery("\u0446\u0435\u043d\u0430 \u0434\u043e\u0433\u043e\u0432\u043e\u0440\u0430");
  const chunks = [
    { id: "terms", text: "\u0421\u0440\u043e\u043a\u0438 \u043e\u043f\u043b\u0430\u0442\u044b \u0438 \u0433\u0440\u0430\u0444\u0438\u043a" },
    { id: "price", text: "\u0426\u0435\u043d\u0430 \u0434\u043e\u0433\u043e\u0432\u043e\u0440\u0430 \u0441\u043e\u0441\u0442\u0430\u0432\u043b\u044f\u0435\u0442 1 000 000,00" }
  ];
  const results = searchBm25(buildBm25Index(chunks), query.queryTerms, chunks.length);

  assert.equal(results[0].chunk.id, "price");
});

test("pipeline can switch between simple lexical scoring and BM25", () => {
  const chunks = [
    { id: "common-heavy", sourceId: "source-a", text: "common common common common" },
    { id: "rare-hit", sourceId: "source-a", text: "rare" },
    { id: "common-light", sourceId: "source-a", text: "common" }
  ];
  const simpleScores = lexicalScoresForChunks(chunks, ["common", "rare"], "", "simple");
  const bm25Scores = lexicalScoresForChunks(chunks, ["common", "rare"], "", "bm25");
  const results = scoreSearchChunks({
    chunks,
    queryTerms: ["common", "rare"],
    lexicalMode: "bm25"
  }).sort((left, right) => right.lexicalScore - left.lexicalScore);

  assert.ok(simpleScores[0] > simpleScores[1]);
  assert.ok(bm25Scores[1] > bm25Scores[0]);
  assert.equal(results[0].id, "rare-hit");
});

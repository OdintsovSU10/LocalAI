import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { parseSseEventBlock } from "../apps/rag-ui/modules/api-client.js";
import { citedSourceNumbers, citationEvidenceForNumber, compactSources, fileName, uniqueSources } from "../apps/rag-ui/modules/citation-helpers.js";
import { compactRagDebug, formatFileSize, formatMs, formatResponseMeta, formatRouteWait } from "../apps/rag-ui/modules/formatting-helpers.js";
import { modelOptionLabel, preferredEmbeddingModel, preferredLocalModel, preferredRemoteModel, sortLocalModels } from "../apps/rag-ui/modules/settings-helpers.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const appJs = fs.readFileSync(path.resolve(__dirname, "../apps/rag-ui/app.js"), "utf8");

test("parseSseEventBlock parses JSON data", () => {
  assert.deepEqual(
    parseSseEventBlock('event: token\ndata: {"text":"hello"}\n'),
    { event: "token", payload: { text: "hello" } }
  );
});

test("citation helpers extract numbers and compact sources", () => {
  assert.deepEqual(citedSourceNumbers("Ответ [2], [bad], [1]"), [2, 1]);
  assert.equal(fileName("C:\\docs\\Contract.pdf"), "Contract.pdf");
  assert.equal(compactSources([{ id: "a", text: "x".repeat(3000) }])[0].text.length, 2600);
  const compact = compactSources([{
    id: "legacy-id",
    chunkId: "chunk-1",
    fileId: "file-1",
    citationEvidence: "email@example.test",
    citationTarget: { chunkId: "chunk-1", fileId: "file-1" }
  }])[0];
  assert.equal(compact.chunkId, "chunk-1");
  assert.equal(compact.fileId, "file-1");
  assert.equal(compact.citationEvidence, "email@example.test");
  assert.equal(compact.citationTarget.chunkId, "chunk-1");
});

test("citationEvidenceForNumber extracts local evidence and skips sources-only lines", () => {
  const answer = [
    "Контакты:",
    "- info@example.test; team@example.test [1]",
    "- support@example.test [3]",
    "",
    "Источники: [1], [3]."
  ].join("\n");

  assert.equal(citationEvidenceForNumber(answer, 1), "info@example.test; team@example.test");
  assert.equal(citationEvidenceForNumber(answer, 3), "support@example.test");
  assert.equal(citationEvidenceForNumber("Источники: [2].", 2), "");
});

test("uniqueSources merges duplicate citation entries and keeps cited source first", () => {
  const result = uniqueSources([
    { id: "chunk-1", sourceId: "s", path: "a.md", sourceNumber: 2, score: 0.2 },
    { id: "chunk-1", sourceId: "s", path: "a.md", sourceNumber: 1, citedRank: 0, score: 0.1 },
    { id: "chunk-2", sourceId: "s", path: "b.md", sourceNumber: 3, score: 0.9 }
  ]);

  assert.equal(result[0].path, "a.md");
  assert.deepEqual(result[0].citationNumbers, [2, 1]);
  assert.equal(result[0].references, 2);
});

test("formatting helpers keep chat metadata readable", () => {
  assert.equal(formatFileSize(1536), "1.5 КБ");
  assert.equal(formatRouteWait(120), "2 мин");
  assert.equal(formatMs(1250), "1.3 s");
  assert.equal(
    formatResponseMeta({
      matchedSource: { title: "Проект", autoSelected: true },
      metadata: { selectedProvider: "local", selectedBaseUrlKind: "local" },
      model: "qwen"
    }),
    "Проект: Проект (авто) · Provider: local · qwen"
  );
});

test("compactRagDebug keeps safe structured metadata only", () => {
  const debug = compactRagDebug({
    provider: "local",
    providerLabel: "Local",
    model: "model-a",
    metadata: {
      selectedProvider: "local",
      selectedBaseUrlKind: "local",
      vectorCandidateCount: 3,
      timings: { retrievalMs: 12 }
    }
  });

  assert.equal(debug.selectedProvider, "local");
  assert.equal(debug.vectorCandidateCount, 3);
  assert.equal(debug.timings.retrievalMs, 12);
});

test("index summary keeps Qdrant count separate from vector totals", () => {
  assert.doesNotMatch(appJs, /qdrantPoints\s*\|\|\s*status\.vectorsTotal/);
  assert.match(appJs, /Qdrant: точек нет данных/);
});

test("settings helpers pick sensible model defaults", () => {
  assert.equal(preferredLocalModel(["embed-small", "chat-model"]), "chat-model");
  assert.equal(preferredLocalModel([
    "text-embedding-bge-m3",
    "qwen2.5-7b-instruct",
    "qwen3-4b-instruct-2507",
    "qwen/qwen3-8b"
  ], "qwen2.5-7b-instruct"), "qwen2.5-7b-instruct");
  assert.deepEqual(sortLocalModels([
    "qwen2.5-7b-instruct",
    "qwen3-4b-instruct-2507",
    "qwen/qwen3-8b",
    "text-embedding-bge-m3"
  ]).slice(0, 3), [
    "qwen/qwen3-8b",
    "qwen3-4b-instruct-2507",
    "qwen2.5-7b-instruct"
  ]);
  assert.equal(preferredEmbeddingModel(["chat-model", "text-embedding-bge-m3"]), "text-embedding-bge-m3");
  assert.equal(preferredRemoteModel([{ id: "qwen3-14b" }, { id: "ocr-model" }]), "qwen3-14b");
  assert.equal(preferredRemoteModel([
    { id: "qwen/qwen3.6-35b-a3b" },
    { id: "qwen3.6-27b-mtp@q4_k_s" },
    { id: "qwen3.6-27b-mtp@q6_k" }
  ], "qwen3.6-27b-mtp"), "qwen3.6-27b-mtp@q6_k");
  assert.equal(modelOptionLabel({ id: "qwen", loaded: true, loadedContextLength: 8192 }), "qwen · loaded · ctx 8192");
});

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { parseSseEventBlock } from "../apps/rag-ui/modules/api-client.js";
import { citedSourceNumbers, citationEvidenceForNumber, compactSources, displayedSourcesForAnswer, fileName, uniqueSources } from "../apps/rag-ui/modules/citation-helpers.js";
import { compactRagDebug, formatFileSize, formatMs, formatResponseMeta, formatRouteWait } from "../apps/rag-ui/modules/formatting-helpers.js";
import { modelOptionLabel, preferredEmbeddingModel, preferredLocalModel, preferredRemoteModel, sortLocalModels } from "../apps/rag-ui/modules/settings-helpers.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const appJs = fs.readFileSync(path.resolve(__dirname, "../apps/rag-ui/app.js"), "utf8");
const appCss = fs.readFileSync(path.resolve(__dirname, "../apps/rag-ui/styles.css"), "utf8");
const indexHtml = fs.readFileSync(path.resolve(__dirname, "../apps/rag-ui/index.html"), "utf8");

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

test("displayedSourcesForAnswer keeps cited sources instead of every retrieval hit", () => {
  const sources = [
    { path: "a.md", sourceNumber: 1, citationNumbers: [1] },
    { path: "b.md", sourceNumber: 2, citationNumbers: [2] },
    { path: "c.md", sourceNumber: 3, citationNumbers: [3] }
  ];

  assert.deepEqual(
    displayedSourcesForAnswer(sources, "Условие подтверждено [2].").map((source) => source.path),
    ["b.md"]
  );
  assert.deepEqual(
    displayedSourcesForAnswer(sources, "LLM выключен.", { maxUncited: 2 }).map((source) => source.path),
    ["a.md", "b.md"]
  );
});

test("chat request carries previous source context without clearing auto mode", () => {
  assert.match(appJs, /const contextSourceId = !sourceId && contractSourceById\(session\.sourceId\) \? session\.sourceId : ""/);
  assert.match(appJs, /if \(sourceId\) \{\s*session\.sourceId = sourceId;\s*touchActiveChat\(\);\s*\}/);
  assert.match(appJs, /JSON\.stringify\(\{ question, sourceId, contextSourceId \}\)/);
});

test("chat history uses LLM titles, monthly groups, and action menu", () => {
  assert.match(appJs, /api\("\/api\/chat\/title"/);
  assert.match(appJs, /generateChatTitleForSession\(sessionId, question, finalAnswer, payload\.matchedSource\)/);
  assert.match(appJs, /session\.titleSource = "fallback"/);
  assert.match(appJs, /session\.titleSource = payload\.fallbackUsed \? "fallback" : "llm"/);
  assert.match(appJs, /className = "chat-history-month"/);
  assert.match(appJs, /function\s+archiveChat\b/);
  assert.match(appJs, /chat-history-menu-button/);
  assert.match(appJs, /chat-history-archive/);
  assert.match(appJs, />В архив</);
  assert.match(appCss, /\.chat-history-actions:hover \.chat-history-menu/);
  assert.match(appCss, /\.chat-history-menu-button/);
  assert.doesNotMatch(appJs, /aria-label="Удалить чат"[\s\S]*×/);
});

test("chat messages expose full date only as hover title", () => {
  assert.match(appJs, /function\s+formatFullDateTime\b/);
  assert.match(appJs, /if \(timestamp\) message\.title = timestamp/);
  assert.doesNotMatch(appJs, /chat-history-meta"\)\.textContent = `\$\{sourceTitle\(session\.sourceId\)\} ·/);
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

test("agent polling surfaces running progress", () => {
  assert.match(appJs, /function\s+formatAgentRunStatus\b/);
  assert.match(appJs, /function\s+showAgentRunProgress\b/);
  assert.match(appJs, /currentSource\.phase === "ocr"/);
  assert.match(appJs, /ocrPage/);
  assert.match(appJs, /const status = formatAgentRunStatus\(run\);[\s\S]*setText\("#job-status", status\)/);
});

test("index progress health is visible in UI", () => {
  assert.match(appJs, /function\s+indexHealthStatus\b/);
  assert.match(appJs, /health === "stale"/);
  assert.match(appJs, /health === "interrupted"/);
  assert.match(appJs, /progress\.classList\.toggle\("is-stalled"/);
  assert.match(appCss, /\.source-index-dot\.is-stalled/);
  assert.match(appCss, /\.index-progress\.is-stalled \.index-progress-fill/);
});

test("agent toolbar has force reindex all action", () => {
  assert.match(indexHtml, /id=["']agent-run-button["'][^>]*>Обновить индекс/);
  assert.match(indexHtml, /id=["']agent-force-run-button["'][^>]*>Полная переиндексация/);
  assert.match(appJs, /agent-force-run-button/);
  assert.match(appJs, /runAgent\(\{ force: true \}\)/);
  assert.match(appJs, /body: JSON\.stringify\(\{ force \}\)/);
  assert.match(appJs, /button\.textContent = running \? "Идёт индексация" : "Обновить индекс"/);
  assert.match(appJs, /forceButton\.textContent = "Полная переиндексация"/);
  assert.doesNotMatch(appJs, /forceButton\.textContent = running \?/);
});

test("stale Qdrant fallback is shown as reindex warning", () => {
  assert.match(appJs, /function\s+sourceNeedsQdrantRefresh\b/);
  assert.match(appJs, /sourceNeedsQdrantReindex\(status\) \|\| sourceNeedsQdrantRefresh\(status\)/);
  assert.match(appJs, /локальные векторы, нужна переиндексация в Qdrant/);
  assert.match(appCss, /\.index-step\.is-warning/);
});

test("reranker header status honors disabled settings", () => {
  assert.match(appJs, /details\.enabled === false \? "disabled" : status/);
  assert.match(appJs, /setRerankerProcessStatus\("disabled", payload\)/);
  assert.match(appJs, /status === "disabled" && details\.running \? "is-warning"/);
  assert.match(appJs, /disabled: "is-offline"/);
  assert.doesNotMatch(appJs, /service === "reranker" && serviceState === "disabled"[\s\S]*return true/);
});

test("tender sync preview can exclude automatic links before apply", () => {
  assert.match(appJs, /selectedTenderLinks: new Map\(\)/);
  assert.match(appJs, /excludedAutoLinks: new Map\(\)/);
  assert.match(appJs, /function\s+tenderSyncSelectedLinksPayload\b/);
  assert.match(appJs, /function\s+tenderSyncDisplayedCandidates\b/);
  assert.match(appJs, /function\s+selectTenderSyncCandidate\b/);
  assert.match(appJs, /tender-sync-candidate-action/);
  assert.match(appJs, /function\s+removeTenderSyncAutoLink\b/);
  assert.match(appJs, /tender-sync-remove-auto-link/);
  assert.match(appJs, /JSON\.stringify\(\{ selectedTenderLinks, excludedAutoLinks \}\)/);
  assert.match(appCss, /\.tender-sync-candidate-action/);
  assert.match(appCss, /\.tender-sync-remove-auto-link/);
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

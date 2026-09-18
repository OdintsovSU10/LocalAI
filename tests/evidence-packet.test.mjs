import assert from "node:assert/strict";
import test from "node:test";

import { MAX_ITEM_CHARS, PACKET_VERSION, buildEvidencePacket, spanScore } from "../apps/rag-api/src/answer-core/evidence-packet.js";
import { createMemoryEvidenceProvider } from "../apps/rag-api/src/evidence/memory-evidence-provider.js";
import { buildProductCorpus } from "../scripts/product-eval/corpus.mjs";
import { projectRoot } from "./helpers/chat-runtime.mjs";

const STROMYNKA = "pv2-stromynka";

let corpusPromise = null;
function corpus() {
  corpusPromise ||= buildProductCorpus({ projectRoot, corpusDir: "fixtures/product-v2" });
  return corpusPromise;
}

async function packetFor({ plan, question, sourceId = STROMYNKA, chunkCount = 6, limit = 12, provider = null }) {
  const { sources, chunks, evidenceProvider } = await corpus();
  const chunkResults = chunks
    .filter((chunk) => !sourceId || chunk.sourceId === sourceId)
    .slice(0, chunkCount)
    .map((chunk) => ({ ...chunk, chunkId: chunk.id }));
  return buildEvidencePacket({
    plan,
    question,
    chunkResults,
    sourceIds: sourceId ? [sourceId] : null,
    provider: provider || evidenceProvider,
    limit,
    sources
  });
}

test("spanScore weighs shared word stems and exact numbers", () => {
  const profile = { terms: new Set(["аванс"]), numbers: new Set(["20"]) };
  assert.equal(spanScore({ text: "Аванс в размере 20% от цены" }, profile), 3);
  assert.equal(spanScore({ text: "Аванс в размере 10% от цены" }, profile), 1);
  assert.equal(spanScore({ text: "Цена договора" }, profile), 0);
});

test("current policy: the current fact comes first, the value it replaced follows as labelled history", async () => {
  const { results, diagnostics } = await packetFor({
    plan: { intent: "fact", entities: ["advance_percent"], versionPolicy: "current" },
    question: "Какой размер аванса?"
  });
  assert.equal(results[0].retrievalReason, "fact:advance_percent:active");
  assert.equal(results[0].title, "ds-01-k-dogovoru-15-p.md");
  assert.ok(results[0].text.includes("10%"));
  assert.equal(results[1].retrievalReason, "fact:advance_percent:superseded");
  assert.ok(results[1].text.includes("20%"));
  assert.equal(diagnostics.packetVersion, PACKET_VERSION);
  assert.equal(diagnostics.versionPolicy, "current");
  assert.equal(diagnostics.items[0].reason, "fact:advance_percent:active");
});

test("historical policy puts the replaced value first", async () => {
  const { results } = await packetFor({
    plan: { intent: "fact", entities: ["advance_percent"], versionPolicy: "historical" },
    question: "Какой аванс был до допсоглашения?"
  });
  assert.equal(results[0].retrievalReason, "fact:advance_percent:superseded");
  assert.equal(results[1].retrievalReason, "fact:advance_percent:active");
});

test("chunk spans that only evidence a superseded fact are demoted below current evidence", async () => {
  const { results, diagnostics } = await packetFor({
    plan: { intent: "fact", entities: [], versionPolicy: "current" },
    question: "аванс 20% от цены договора"
  });
  const staleIndex = results.findIndex((result) => result.text.includes("аванс в размере 20%"));
  const currentIndex = results.findIndex((result) => result.text.includes("Пункт 3.1 договора изложить в новой редакции"));
  assert.ok(staleIndex > currentIndex && currentIndex >= 0, "superseded clause is ranked above the amendment");
  assert.match(results[staleIndex].retrievalReason, /:superseded$/);
  assert.equal(diagnostics.demotedSuperseded, 1);
});

test("spreadsheet rows are cited by sheet and row, next to the fact row of the same chunk", async () => {
  const { results } = await packetFor({
    plan: { intent: "fact", entities: ["estimate_total"], versionPolicy: "current" },
    question: "Сколько стоит бетон B30 за м3 по смете?",
    chunkCount: 20
  });
  const total = results.find((result) => result.retrievalReason.startsWith("fact:estimate_total"));
  assert.equal(total.citationTarget.sheetName, "Сводная");
  assert.equal(total.citationTarget.rowStart, 12);
  const concrete = results.find((result) => result.text.includes("Бетон B30"));
  assert.ok(concrete, "the concrete row is missing from the packet");
  assert.equal(concrete.citationTarget.sheetName, "Материалы");
  assert.equal(concrete.citationTarget.rowStart, 4);
  assert.ok(concrete.citationEvidence.includes("Бетон B30"));
});

test("aggregate questions interleave sources instead of letting one project fill the packet", async () => {
  const { results } = await packetFor({
    plan: { intent: "aggregate", entities: ["advance_percent"], versionPolicy: "current" },
    question: "Какой аванс по всем проектам?",
    sourceId: null,
    chunkCount: 40
  });
  const firstThree = new Set(results.slice(0, 3).map((result) => result.sourceId));
  assert.equal(firstThree.size, 3);
});

test("the packet is bounded and holds no duplicate spans", async () => {
  const { results } = await packetFor({
    plan: { intent: "overview", entities: [], versionPolicy: "current" },
    question: "Какие основные условия договора?",
    chunkCount: 20,
    limit: 8
  });
  assert.equal(results.length, 8);
  const ids = results.map((result) => result.evidenceId);
  assert.equal(new Set(ids).size, ids.length);
  assert.ok(results.every((result) => result.text.length <= MAX_ITEM_CHARS));
  // The contract price conflicts with the estimate total, so it is kept (status conflict), not dropped.
  assert.match(results[0].retrievalReason, /^fact:contract_price:/);
});

test("without evidence the original chunk results are kept as they are", async () => {
  const { results, diagnostics } = await packetFor({
    plan: { intent: "fact", entities: ["advance_percent"], versionPolicy: "current" },
    question: "Какой размер аванса?",
    chunkCount: 3,
    provider: createMemoryEvidenceProvider([])
  });
  assert.equal(results.length, 3);
  assert.ok(results.every((result) => !result.evidenceId));
  assert.equal(diagnostics.fallbackChunks, 3);
  assert.equal(diagnostics.candidates.facts, 0);
});

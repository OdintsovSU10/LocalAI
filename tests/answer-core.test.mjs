import assert from "node:assert/strict";
import test from "node:test";

import { answerQuestion } from "../apps/rag-api/src/answer-core/answer-question.js";
import { createLlmUsageTracker } from "../apps/rag-api/src/answer-core/llm-usage-tracker.js";

const demoSource = { id: "demo", title: "Demo Project", path: "fixtures/demo-project", sourceType: "contract" };
const secondSource = { id: "second", title: "Second Object", path: "fixtures/second-object", sourceType: "contract" };

function settings(llm = {}) {
  return {
    llm: {
      enabled: true,
      provider: "local",
      baseUrl: "http://127.0.0.1:1234/v1",
      apiKey: "lm-studio",
      model: "local-model",
      timeoutSeconds: 30,
      remote: { enabled: false },
      ...llm
    }
  };
}

function result(index) {
  return {
    id: `chunk-${index}`,
    sourceId: "demo",
    sourceTitle: "Demo Project",
    title: "contract.md",
    path: "fixtures/demo-project/contract.md",
    text: `Сумма договора составляет 12 450 000 рублей. Фрагмент ${index}.`,
    citationLabel: `contract.md, фрагмент ${index}`
  };
}

function deps(overrides = {}) {
  const calls = { search: [], completions: [] };
  const base = {
    readSources: async () => [demoSource, secondSource],
    readSettings: async () => settings(),
    readManifest: async () => ({ files: { f1: { sourceId: "demo", quality: { chunks: 2 } } } }),
    readJobs: async () => ({}),
    searchChunksWithMetadata: async (args) => {
      calls.search.push(args);
      return { results: [result(1), result(2)], metadata: { searchMode: "hybrid", timings: { retrievalMs: 5 } } };
    },
    publicMatchedSource: (source, options) => ({ id: source.id, title: source.title, ...options }),
    latestJobForSource: () => null,
    publicJobStatus: () => ({ status: "not_indexed" }),
    allSourcesNoResultsAnswer: () => "По всем проектам ничего не найдено.",
    usageTracker: createLlmUsageTracker(),
    chatCompletion: async (args) => {
      calls.completions.push({ stream: false, args });
      return { model: "local-model", text: "Сумма договора 12 450 000 рублей [1]." };
    },
    chatCompletionStream: async (args) => {
      calls.completions.push({ stream: true, args });
      for (const token of ["Сумма договора ", "12 450 000 рублей [1]."]) args.onToken(token);
      return { model: "local-model", text: "Сумма договора 12 450 000 рублей [1]." };
    },
    now: () => 1000,
    ...overrides
  };
  return { deps: base, calls };
}

function collectEvents() {
  const events = [];
  return { events, onEvent: (event) => events.push(event) };
}

test("answerQuestion answers with sources and appends the fallback sources line", async () => {
  const { deps: answerDeps, calls } = deps();
  const { payload, answerStreamed } = await answerQuestion({ question: "Какая сумма договора?", requestedSourceId: "demo" }, answerDeps);

  assert.equal(payload.answer, "Сумма договора 12 450 000 рублей [1].\n\nИсточники: [1].");
  assert.equal(payload.sources.length, 2);
  assert.equal(payload.matchedSource.id, "demo");
  assert.equal(payload.provider, "local");
  assert.equal(payload.metadata.finalSourceCount, 2);
  assert.equal(answerStreamed, false);
  assert.equal(calls.search[0].sourceId, "demo");
  assert.equal(calls.search[0].limit, 12);
  assert.equal(calls.completions.length, 1);
  assert.equal(answerDeps.usageTracker.activeCount(), 0);
  assert.equal(answerDeps.usageTracker.lastActivity().status, "completed");
  assert.equal(answerDeps.usageTracker.lastGeneration("local").model, "local-model");
});

test("answerQuestion stream mode emits retrieval/llm phases, tokens and the missing sources suffix", async () => {
  const { deps: answerDeps } = deps();
  const { events, onEvent } = collectEvents();
  const { payload, answerStreamed } = await answerQuestion({
    question: "Какая сумма договора?",
    requestedSourceId: "demo",
    stream: true,
    onEvent
  }, answerDeps);

  assert.equal(answerStreamed, true);
  assert.deepEqual(events.map((event) => event.type === "status" ? event.payload.status : `token:${event.text}`), [
    "retrieval_started",
    "retrieval_done",
    "llm_started",
    "token:Сумма договора ",
    "token:12 450 000 рублей [1].",
    "token:\n\nИсточники: [1]."
  ]);
  assert.equal(events.map((event) => event.text || "").join(""), payload.answer);
  assert.equal(events[1].phase, "retrieval");
  assert.equal(events[2].phase, "llm");
});

test("answerQuestion returns project candidates without searching when the requested project is missing", async () => {
  const { deps: answerDeps, calls } = deps();
  const { events, onEvent } = collectEvents();
  const { payload, answerStreamed } = await answerQuestion({ question: "Какой аванс?", requestedSourceId: "missing", onEvent }, answerDeps);

  assert.match(payload.answer, /^Не понял, к какому проекту относится вопрос/);
  assert.deepEqual(payload.sources, []);
  assert.equal(payload.matchedSource, null);
  assert.ok(Array.isArray(payload.projectCandidates));
  assert.equal(answerStreamed, false);
  assert.equal(calls.search.length, 0);
  assert.deepEqual(events.map((event) => event.payload), [
    { status: "retrieval_started" },
    { status: "retrieval_done", matched: false }
  ]);
});

test("answerQuestion falls back to extractive excerpts when the LLM fails", async () => {
  const { deps: answerDeps } = deps({
    chatCompletion: async () => {
      throw new Error("fake model crashed");
    }
  });
  const { payload, answerStreamed } = await answerQuestion({ question: "Какая сумма договора?", requestedSourceId: "demo" }, answerDeps);

  assert.match(payload.answer, /^Модель временно не ответила \(fake model crashed\)/);
  assert.equal(payload.fallbackReason, "llm_failed");
  assert.equal(payload.sources.length, 2);
  assert.equal(answerStreamed, false);
  assert.equal(answerDeps.usageTracker.lastActivity().status, "failed");
});

test("answerQuestion retries with a tighter context profile on context-size errors", async () => {
  const profiles = [];
  const { deps: answerDeps } = deps({
    chatCompletion: async ({ messages }) => {
      profiles.push(messages[1].content.length);
      if (profiles.length === 1) throw new Error("context length exceeded (n_ctx 4096)");
      return { model: "local-model", text: "Ответ [1]." };
    }
  });
  const { payload } = await answerQuestion({ question: "Какая сумма договора?", requestedSourceId: "demo" }, answerDeps);

  assert.equal(profiles.length, 2);
  assert.equal(payload.answer, "Ответ [1].\n\nИсточники: [1].");
  assert.equal(payload.fallbackReason, "");
});

test("answerQuestion reports a missing index and an empty result without calling the LLM", async () => {
  const noResults = { searchChunksWithMetadata: async () => ({ results: [], metadata: {} }) };

  const { deps: noIndexDeps, calls: noIndexCalls } = deps({
    ...noResults,
    readManifest: async () => ({ files: {} }),
    publicJobStatus: () => ({ status: "running", processed: 3, total: 10 })
  });
  const noIndex = await answerQuestion({ question: "Какая сумма договора?", requestedSourceId: "demo" }, noIndexDeps);
  assert.equal(noIndex.payload.answer, "По проекту «Demo Project» пока нет готового индекса. Сейчас идет индексация: 3/10. Запустите агента или дождитесь завершения индексации, затем повторите вопрос.");
  assert.equal(noIndexCalls.completions.length, 0);

  const { deps: allDeps } = deps(noResults);
  const all = await answerQuestion({ question: "Какой аванс по всем проектам?" }, allDeps);
  assert.equal(all.payload.answer, "По всем проектам ничего не найдено.");
});

test("answerQuestion returns raw fragments when the LLM is disabled", async () => {
  const { deps: answerDeps, calls } = deps({ readSettings: async () => settings({ enabled: false }) });
  const { payload } = await answerQuestion({ question: "Какая сумма договора?", requestedSourceId: "demo" }, answerDeps);

  assert.equal(payload.answer, "LLM выключен в настройках. Ниже самые релевантные фрагменты.");
  assert.equal(payload.sources.length, 2);
  assert.equal(calls.completions.length, 0);
});

test("answerQuestion uses contextSourceId when the question names no project", async () => {
  const { deps: answerDeps, calls } = deps();
  const { payload } = await answerQuestion({ question: "А какой срок?", contextSourceId: "second" }, answerDeps);

  assert.equal(payload.matchedSource.id, "second");
  assert.equal(payload.matchedSource.autoSelected, true);
  assert.equal(calls.search[0].sourceId, "second");
});

test("answerQuestion without conversation context sends exactly system + user messages", async () => {
  const { deps: answerDeps, calls } = deps();
  await answerQuestion({ question: "Какая сумма договора?", requestedSourceId: "demo" }, answerDeps);
  const messages = calls.completions[0].args.messages;
  assert.deepEqual(messages.map((message) => message.role), ["system", "user"]);
  assert.ok(!messages[0].content.includes("Предыдущие реплики диалога"));
});

test("answerQuestion uses the conversation's pinned project and bounded history for a follow-up", async () => {
  const { deps: answerDeps, calls } = deps();
  const conversationContext = {
    conversationId: "conv-1",
    pinnedSourceId: "second",
    turns: [{ question: "Какой размер гарантийного удержания?", answer: "Удержание 3%.", sourceId: "second" }]
  };
  const { payload } = await answerQuestion({ question: "а какой срок выплаты?", conversationContext }, answerDeps);

  assert.equal(payload.matchedSource.id, "second");
  assert.equal(calls.search[0].sourceId, "second");
  assert.equal(calls.search[0].query, ["а какой срок выплаты?", "Какой размер гарантийного удержания?"].join("\n"));
  const messages = calls.completions[0].args.messages;
  assert.deepEqual(messages.map((message) => message.role), ["system", "user", "assistant", "user"]);
  assert.equal(messages[1].content, "Какой размер гарантийного удержания?");
  assert.equal(messages[2].content, "Удержание 3%.");
  assert.ok(messages[3].content.includes("Вопрос:\nа какой срок выплаты?"));
  assert.match(messages[0].content, /Предыдущие реплики диалога/);
});

test("an explicit project in the request wins over the conversation pin", async () => {
  const { deps: answerDeps, calls } = deps();
  const { payload } = await answerQuestion({
    question: "Какая сумма договора?",
    requestedSourceId: "demo",
    conversationContext: { pinnedSourceId: "second", turns: [] }
  }, answerDeps);
  assert.equal(payload.matchedSource.id, "demo");
  assert.equal(calls.search[0].sourceId, "demo");
});

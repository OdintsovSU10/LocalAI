// Stage 02 characterization contract: /api/chat, /api/chat/stream, /api/chat/title and LLM usage state
// must answer exactly like the pre-refactor server. Both runtimes are started from temp copies:
// the baseline from git (CHAT_CONTRACT_BASE_REV), the candidate from the working tree.
//
//   npm run test:chat-contract
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import {
  addSource,
  createTempRuntime,
  indexSource,
  normalizeForContract,
  postJson,
  postSse,
  projectRoot,
  startApi,
  startFakeLlm
} from "./helpers/chat-runtime.mjs";

// Last commit where the chat pipeline still lived inside server.js.
const BASE_REVISION = process.env.CHAT_CONTRACT_BASE_REV || "70552d6";
const KEEP_TEMP = process.env.CHAT_CONTRACT_KEEP_TEMP === "1";

function chatScenarios({ demo, second, empty }) {
  return {
    "found-requested-source": { question: "Какая сумма договора?", sourceId: demo.id },
    "auto-match-by-title": { question: "Какая сумма договора в Second Project?" },
    "context-source-follow-up": { question: "А какой гарантийный срок?", contextSourceId: second.id },
    "all-sources": { question: "Какой график оплаты по всем проектам?" },
    "broad-overview": { question: "Какие основные условия договора?", sourceId: demo.id },
    "llm-error": { question: "СБОЙ какая сумма договора?", sourceId: demo.id },
    "context-size-retry": { question: "КОНТЕКСТ какая сумма договора?", sourceId: demo.id },
    "missing-requested-source": { question: "Какой аванс?", sourceId: "missing-project" },
    "no-results": { question: "zzqxwv", sourceId: demo.id },
    "not-indexed-source": { question: "Какая сумма договора?", sourceId: empty.id },
    // "every folder" triggers the all-sources intent; none of these words occur in the demo corpus
    // (unlike "проект"), so the search really comes back empty.
    "all-sources-no-results": { question: "zzqxwv across every folder" }
  };
}

async function collectRuntime({ runDir, label, revision = "" }) {
  const root = await createTempRuntime({ runDir, label, revision });
  const llm = await startFakeLlm();
  const out = {};
  let api = await startApi({ root, llmBaseUrl: llm.baseUrl });
  try {
    const demo = await addSource(api.baseUrl, { title: "Demo Project", folder: path.join(root, "fixtures", "demo-project") });
    const second = await addSource(api.baseUrl, { title: "Second Project", folder: path.join(root, "fixtures", "second-project") });
    const empty = await addSource(api.baseUrl, { title: "Empty Project", folder: path.join(root, "fixtures", "empty-project") });
    await indexSource(api.baseUrl, demo.id);
    await indexSource(api.baseUrl, second.id);

    const aliases = { [demo.id]: "<SRC_DEMO>", [second.id]: "<SRC_SECOND>", [empty.id]: "<SRC_EMPTY>" };
    const normalize = (value) => normalizeForContract(value, { root, llmBaseUrl: llm.baseUrl, aliases });
    const scenarios = chatScenarios({ demo, second, empty });

    for (const [name, body] of Object.entries(scenarios)) {
      out[`${name} json`] = normalize(await postJson(api.baseUrl, "/api/chat", body));
      out[`${name} sse`] = normalize(await postSse(api.baseUrl, "/api/chat/stream", body));
    }
    out["title json"] = normalize(await postJson(api.baseUrl, "/api/chat/title", {
      question: "Какая сумма договора?",
      answer: "Сумма договора 12 450 000 рублей [1].",
      sourceTitle: "Demo Project"
    }));

    const usage = await (await fetch(`${api.baseUrl}/api/llm/usage`)).json();
    out["llm usage"] = normalize({
      activeRequests: usage.activeRequests,
      activeRequestsCount: usage.activeRequestsCount,
      busy: usage.busy,
      lastActivity: usage.lastActivity
    });
    const diagnostics = await (await fetch(`${api.baseUrl}/api/llm/diagnostics?provider=local`)).json();
    out["llm diagnostics lastGeneration"] = normalize({
      activeRequestsCount: diagnostics.activeRequestsCount,
      lastGeneration: diagnostics.lastGeneration
    });

    await api.stop();
    api = await startApi({ root, llmEnabled: false });
    for (const name of ["found-requested-source", "no-results", "missing-requested-source"]) {
      out[`${name} llm-disabled json`] = normalize(await postJson(api.baseUrl, "/api/chat", scenarios[name]));
      out[`${name} llm-disabled sse`] = normalize(await postSse(api.baseUrl, "/api/chat/stream", scenarios[name]));
    }
    out["title llm-disabled json"] = normalize(await postJson(api.baseUrl, "/api/chat/title", { question: "Какая сумма договора?" }));
  } finally {
    await api.stop();
    await llm.close();
  }
  return out;
}

function eventNames(result) {
  return result.events.map((event) => event.status ? event.event : `${event.event}${event.payload?.status ? `:${event.payload.status}` : ""}`);
}

// Guards against two equally broken runtimes "matching": each scenario must exercise the intended branch.
function assertScenarioBranches(results) {
  const answer = (name) => results[`${name} json`].payload?.answer || "";
  assert.equal(results["found-requested-source json"].status, 200);
  assert.match(answer("found-requested-source"), /^Ответ по документам: сумма договора 12 450 000 рублей \[1\]/);
  assert.ok(results["found-requested-source json"].payload.sources.length > 0);
  assert.match(answer("llm-error"), /^Модель временно не ответила/);
  assert.match(answer("context-size-retry"), /^Ответ по документам/);
  assert.match(answer("missing-requested-source"), /^Не понял, к какому проекту/);
  assert.equal(answer("no-results"), "По готовому индексу ничего не найдено. Попробуйте уточнить формулировку или выберите другой проект.");
  assert.match(answer("not-indexed-source"), /пока нет готового индекса/);
  assert.match(answer("all-sources-no-results"), /^По готовым индексам всех проектов ничего не найдено/);
  assert.deepEqual(results["all-sources-no-results json"].payload.sources, []);
  assert.deepEqual(results["no-results json"].payload.sources, []);
  assert.equal(results["found-requested-source llm-disabled json"].payload.answer, "LLM выключен в настройках. Ниже самые релевантные фрагменты.");

  const streamEvents = eventNames(results["found-requested-source sse"]);
  for (const expected of ["status:retrieval_started", "status:retrieval_done", "status:llm_started", "token", "sources", "meta", "done"]) {
    assert.ok(streamEvents.includes(expected), `stream is missing ${expected}: ${streamEvents.join(", ")}`);
  }
  assert.equal(results["title json"].payload.title, "Сумма договора");
  assert.equal(results["llm usage"].activeRequestsCount, 0);
  assert.equal(results["llm usage"].lastActivity?.status, "completed");
  assert.ok(results["llm diagnostics lastGeneration"].lastGeneration, "diagnostics lost lastGeneration");
}

test(`chat API matches pre-refactor baseline ${BASE_REVISION}`, { timeout: 15 * 60 * 1000 }, async (t) => {
  const runDir = path.join(projectRoot, ".tmp", "chat-contract", `run-${process.pid}-${Date.now()}`);
  t.after(async () => {
    if (!KEEP_TEMP) await fs.rm(runDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });

  // Absolute paths go into the LLM context, so promptChars depends on path length:
  // both runtime labels must be the same length for the comparison to be meaningful.
  const baseline = await collectRuntime({ runDir, label: "base", revision: BASE_REVISION });
  const current = await collectRuntime({ runDir, label: "head" });

  assertScenarioBranches(baseline);
  assert.deepEqual(Object.keys(current), Object.keys(baseline));
  for (const name of Object.keys(baseline)) {
    assert.deepStrictEqual(current[name], baseline[name], `response differs from baseline: ${name}`);
  }
});

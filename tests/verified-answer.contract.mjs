// Stage 07 contract: verified answering over the real HTTP API — synthetic contract folder, Retrieval 2.0
// evidence, fake local LLM for draft and verifier (same_model mode). JSON and SSE use one pipeline.
//
//   npm run test:verified-contract
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import {
  addSource,
  createTempRuntime,
  indexSource,
  postJson,
  postSse,
  projectRoot,
  requestJson,
  startApi,
  startFakeLlm
} from "./helpers/chat-runtime.mjs";

const KEEP_TEMP = process.env.VERIFIED_CONTRACT_KEEP_TEMP === "1";
const INSUFFICIENT = "Не удалось подтвердить ответ по имеющимся документам.";

const schemaNames = (requests) => requests.map((request) => (request.messages[0]?.content.startsWith("Ты независимый проверяющий") ? "verdict" : "draft"));

test("verified answering: claims, checks, verifier, repair and statuses over JSON and SSE", { timeout: 10 * 60 * 1000 }, async (t) => {
  const runDir = path.join(projectRoot, ".tmp", "verified-contract", `run-${process.pid}-${Date.now()}`);
  let llm = null;
  let api = null;
  t.after(async () => {
    if (api) await api.stop();
    if (llm) await llm.close();
    if (!KEEP_TEMP) await fs.rm(runDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });
  const root = await createTempRuntime({ runDir, label: "head", extraFixtures: ["product-v2"] });
  llm = await startFakeLlm();
  api = await startApi({ root, llmBaseUrl: llm.baseUrl, retrievalV2: true, verifiedAnswering: true, verifierMode: "same_model" });

  const stromynka = await addSource(api.baseUrl, { title: "ЖК Сокольники, Стромынка", folder: path.join(root, "fixtures", "product-v2", "stromynka") });
  await indexSource(api.baseUrl, stromynka.id);
  assert.equal((await postJson(api.baseUrl, "/api/evidence/rebuild", { sourceId: stromynka.id })).status, 200);

  // 1. A supported claim: draft -> checks -> verifier -> verified answer citing the current advance.
  let before = llm.chatRequests.length;
  const verified = await postJson(api.baseUrl, "/api/chat", { question: "Какой размер аванса по договору?", sourceId: stromynka.id });
  assert.equal(verified.status, 200);
  assert.equal(verified.payload.answerStatus, "verified");
  assert.equal(verified.payload.verification.level, "model");
  assert.equal(verified.payload.verification.verifier.mode, "same_model");
  assert.equal(verified.payload.verification.verifier.independent, false);
  assert.match(verified.payload.answer, /10%.*\[1\]$/s);
  assert.equal(verified.payload.sources.length, 1);
  assert.equal(verified.payload.sources[0].retrievalReason, "fact:advance_percent:active");
  assert.equal(typeof verified.payload.metadata.timings.verifyMs, "number");
  assert.deepEqual(schemaNames(llm.chatRequests.slice(before)), ["draft", "verdict"]);
  assert.ok(llm.chatRequests.slice(before).every((request) => request.stream === false), "drafts are never streamed");

  // 2. SSE: verification phases, then exactly one token with the final (verified) text.
  const streamed = await postSse(api.baseUrl, "/api/chat/stream", { question: "Какой размер аванса по договору?", sourceId: stromynka.id });
  const statuses = streamed.events.filter((event) => event.event === "status").map((event) => event.payload.status);
  for (const status of ["retrieval_started", "retrieval_done", "llm_started", "verifying_started", "finalizing"]) assert.ok(statuses.includes(status), status);
  const tokens = streamed.events.filter((event) => event.event === "token").map((event) => event.payload.text);
  const done = streamed.events.find((event) => event.event === "done").payload;
  assert.deepEqual(tokens, [done.answer]);
  assert.equal(done.answer, verified.payload.answer);
  assert.equal(done.answerStatus, "verified");
  assert.ok(!tokens.join("").includes("claim_id"), "no draft JSON reaches the client");

  // 3. A number that is not in the evidence: rejected by the checks, one bounded repair, honest answer.
  before = llm.chatRequests.length;
  const wrongNumber = await postJson(api.baseUrl, "/api/chat", { question: "ЛОЖЬ какой аванс по договору?", sourceId: stromynka.id });
  assert.equal(wrongNumber.payload.answerStatus, "insufficient_evidence");
  assert.equal(wrongNumber.payload.answer, INSUFFICIENT);
  assert.ok(!wrongNumber.payload.answer.includes("99%"));
  assert.deepEqual(wrongNumber.payload.verification.claims[0].issues, ["number_not_in_evidence"]);
  assert.equal(wrongNumber.payload.verification.repairs, 1);
  assert.deepEqual(schemaNames(llm.chatRequests.slice(before)), ["draft", "draft"], "checks reject before the verifier is asked");

  // 4. The verifier contradicts a claim the checks let through: not shown, same over SSE.
  const rejected = await postJson(api.baseUrl, "/api/chat", { question: "ОПРОВЕРГНИ какой аванс по договору?", sourceId: stromynka.id });
  assert.equal(rejected.payload.answerStatus, "insufficient_evidence");
  assert.equal(rejected.payload.verification.claims[0].status, "contradicted");
  const rejectedStream = await postSse(api.baseUrl, "/api/chat/stream", { question: "ОПРОВЕРГНИ какой аванс по договору?", sourceId: stromynka.id });
  assert.equal(rejectedStream.events.find((event) => event.event === "done").payload.answerStatus, "insufficient_evidence");

  // 5. The status and a text-free verification summary are stored with the conversation turn.
  const conversation = await requestJson(api.baseUrl, "/api/conversations", { method: "POST", body: {} });
  const turn = await postJson(api.baseUrl, "/api/chat", { question: "Какой размер аванса по договору?", sourceId: stromynka.id, conversationId: conversation.payload.id });
  assert.equal(turn.payload.answerStatus, "verified");
  const messages = await requestJson(api.baseUrl, `/api/conversations/${conversation.payload.id}/messages`);
  const assistant = messages.payload.messages.find((message) => message.role === "assistant");
  assert.equal(assistant.answerStatus, "verified");
  assert.equal(assistant.verifier.level, "model");
  assert.equal(assistant.verifier.claims[0].status, "supported");
});

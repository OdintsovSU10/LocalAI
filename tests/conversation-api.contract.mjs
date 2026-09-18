// Stage 03 contract: server-side conversations over the real HTTP API with a fake local LLM.
//
//   npm run test:conversation-contract
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

const KEEP_TEMP = process.env.CONVERSATION_CONTRACT_KEEP_TEMP === "1";

function lastChatRequest(llm) {
  return llm.chatRequests.at(-1);
}

function donePayload(sse) {
  return sse.events.find((event) => event.event === "done")?.payload;
}

test("server conversations: follow-up, isolation, persistence across restart", { timeout: 10 * 60 * 1000 }, async (t) => {
  const runDir = path.join(projectRoot, ".tmp", "conversation-contract", `run-${process.pid}-${Date.now()}`);
  let llm = null;
  let api = null;
  // One cleanup hook in a fixed order: the API process holds app-state.sqlite (and its WAL files)
  // open, and Windows cannot delete open files, so processes stop before the runtime is removed.
  t.after(async () => {
    if (api) await api.stop();
    if (llm) await llm.close();
    if (!KEEP_TEMP) await fs.rm(runDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });
  const root = await createTempRuntime({ runDir, label: "head" });
  llm = await startFakeLlm();
  api = await startApi({ root, llmBaseUrl: llm.baseUrl });

  const demo = await addSource(api.baseUrl, { title: "Demo Project", folder: path.join(root, "fixtures", "demo-project") });
  const second = await addSource(api.baseUrl, { title: "Second Project", folder: path.join(root, "fixtures", "second-project") });
  await indexSource(api.baseUrl, demo.id);
  await indexSource(api.baseUrl, second.id);

  // Backward compatibility: a request without conversationId gets no conversation fields.
  const single = await postJson(api.baseUrl, "/api/chat", { question: "Какая сумма договора?", sourceId: demo.id });
  assert.equal(single.status, 200);
  assert.equal("conversationId" in single.payload, false);
  assert.equal("turn" in single.payload, false);

  const created = await requestJson(api.baseUrl, "/api/conversations", { method: "POST", body: {} });
  assert.equal(created.status, 201);
  const conversationA = created.payload.id;

  // Turn 1 names the project explicitly.
  const first = await postJson(api.baseUrl, "/api/chat", { question: "Какая сумма договора?", sourceId: demo.id, conversationId: conversationA });
  assert.equal(first.status, 200);
  assert.equal(first.payload.conversationId, conversationA);
  assert.ok(first.payload.turn?.userMessageId && first.payload.turn?.assistantMessageId);
  assert.equal(first.payload.matchedSource.id, demo.id);

  // Turn 2 is a follow-up without any project: the conversation pin and history must carry it.
  const followUp = await postJson(api.baseUrl, "/api/chat", { question: "а какой срок выполнения работ?", conversationId: conversationA });
  assert.equal(followUp.status, 200);
  assert.equal(followUp.payload.matchedSource?.id, demo.id, "follow-up lost the conversation project");
  const followUpPrompt = lastChatRequest(llm).messages;
  assert.deepEqual(followUpPrompt.map((message) => message.role), ["system", "user", "assistant", "user"]);
  assert.equal(followUpPrompt[1].content, "Какая сумма договора?");
  assert.ok(!/\[\d+\]/.test(followUpPrompt[2].content), "history answer kept stale citation numbers");

  // Turn 3 over SSE continues the same conversation.
  const streamed = await postSse(api.baseUrl, "/api/chat/stream", { question: "а гарантийный срок?", conversationId: conversationA });
  assert.equal(streamed.status, 200);
  assert.equal(donePayload(streamed)?.conversationId, conversationA);
  assert.equal(donePayload(streamed)?.matchedSource?.id, demo.id);
  assert.equal(lastChatRequest(llm).messages.filter((message) => message.role === "user").length, 3);

  // Another conversation must not see conversation A in its prompt.
  const conversationB = (await requestJson(api.baseUrl, "/api/conversations", { method: "POST", body: { title: "B" } })).payload.id;
  const isolated = await postJson(api.baseUrl, "/api/chat", { question: "Какой график оплаты?", sourceId: second.id, conversationId: conversationB });
  assert.equal(isolated.status, 200);
  const isolatedPrompt = lastChatRequest(llm).messages;
  assert.deepEqual(isolatedPrompt.map((message) => message.role), ["system", "user"]);
  assert.ok(!JSON.stringify(isolatedPrompt).includes("а какой срок выполнения работ?"), "conversation history leaked between conversations");

  // Stored messages: ordered, statuses set, no absolute paths in citations.
  const stored = await requestJson(api.baseUrl, `/api/conversations/${conversationA}`);
  assert.equal(stored.status, 200);
  assert.equal(stored.payload.conversation.pinnedSourceId, demo.id);
  assert.deepEqual(stored.payload.messages.map((message) => message.role), ["user", "assistant", "user", "assistant", "user", "assistant"]);
  assert.ok(stored.payload.messages.filter((message) => message.role === "assistant").every((message) => message.answerStatus === "unverified"));
  const storedJson = JSON.stringify(stored.payload);
  assert.ok(!storedJson.includes(root) && !storedJson.includes(root.replaceAll("\\", "/")) && !storedJson.includes(root.replaceAll("\\", "\\\\")), "absolute path stored in conversation");

  // Unknown conversation: plain 404 for both chat endpoints.
  assert.equal((await postJson(api.baseUrl, "/api/chat", { question: "Вопрос", conversationId: "missing-conversation" })).status, 404);
  assert.equal((await postSse(api.baseUrl, "/api/chat/stream", { question: "Вопрос", conversationId: "missing-conversation" })).status, 404);

  // Legacy localStorage import is idempotent.
  const legacy = {
    id: "chat-legacy-1",
    title: "Старый чат",
    sourceId: second.id,
    createdAt: "2026-09-01T10:00:00.000Z",
    updatedAt: "2026-09-01T10:01:00.000Z",
    messages: [
      { role: "user", text: "Какой график оплаты?" },
      { role: "assistant", text: "30% аванс [1].", sources: [{ id: "x", sourceId: second.id, citationTarget: { fileLabel: "budget.md" } }] }
    ]
  };
  const importedOnce = await requestJson(api.baseUrl, "/api/conversations/import", { method: "POST", body: { sessions: [legacy] } });
  const importedTwice = await requestJson(api.baseUrl, "/api/conversations/import", { method: "POST", body: { sessions: [legacy] } });
  assert.equal(importedOnce.payload.results[0].created, true);
  assert.equal(importedTwice.payload.results[0].created, false);
  assert.equal(importedTwice.payload.results[0].conversationId, importedOnce.payload.results[0].conversationId);
  const importedId = importedOnce.payload.results[0].conversationId;
  assert.equal((await requestJson(api.baseUrl, `/api/conversations/${importedId}/messages`)).payload.messages.length, 2);

  // Restart: conversations and the pin survive; a follow-up still resolves the project.
  await api.stop();
  api = await startApi({ root, llmBaseUrl: llm.baseUrl });
  const afterRestart = await requestJson(api.baseUrl, `/api/conversations/${conversationA}`);
  assert.equal(afterRestart.status, 200);
  assert.equal(afterRestart.payload.messages.length, 6);
  const restartedFollowUp = await postJson(api.baseUrl, "/api/chat", { question: "а кто ответственный контакт?", conversationId: conversationA });
  assert.equal(restartedFollowUp.payload.matchedSource?.id, demo.id);

  // Stage 05: an ambiguous project is clarified once; the reply resumes the original question.
  const conversationC = (await requestJson(api.baseUrl, "/api/conversations", { method: "POST", body: {} })).payload.id;
  const ambiguous = await postJson(api.baseUrl, "/api/chat", { question: "Какая сумма договора в Project?", conversationId: conversationC });
  assert.equal(ambiguous.status, 200);
  assert.equal(ambiguous.payload.clarification?.kind, "project");
  assert.deepEqual(ambiguous.payload.clarification.options.map((option) => option.sourceId).sort(), [demo.id, second.id].sort());
  assert.deepEqual(ambiguous.payload.sources, []);
  const requestsBeforeReply = llm.chatRequests.length;

  const reply = await postJson(api.baseUrl, "/api/chat", { question: "Second Project", conversationId: conversationC });
  assert.equal(reply.status, 200);
  assert.equal(reply.payload.clarification, undefined);
  assert.equal(reply.payload.matchedSource?.id, second.id);
  assert.match(reply.payload.answer, /^Ответ по документам/);
  assert.equal(llm.chatRequests.length, requestsBeforeReply + 1, "the clarification itself must not call the LLM");
  assert.ok(lastChatRequest(llm).messages.at(-1).content.includes("Вопрос:\nКакая сумма договора в Project?"), "the original question was not resumed");

  const clarified = await requestJson(api.baseUrl, `/api/conversations/${conversationC}`);
  assert.deepEqual(
    clarified.payload.messages.filter((message) => message.role === "assistant").map((message) => message.answerStatus),
    ["clarification_required", "unverified"]
  );
  assert.equal(clarified.payload.conversation.pinnedSourceId, second.id);

  // The clarification is resolved: a later "1" is an ordinary question, not a second resume.
  const later = await postJson(api.baseUrl, "/api/chat", { question: "1", conversationId: conversationC });
  assert.equal(later.payload.clarification, undefined);
  assert.ok(!lastChatRequest(llm).messages.at(-1).content.includes("Вопрос:\nКакая сумма договора в Project?"));

  // Same flow over SSE; the clarification is carried in the done payload.
  const conversationD = (await requestJson(api.baseUrl, "/api/conversations", { method: "POST", body: {} })).payload.id;
  const ambiguousSse = await postSse(api.baseUrl, "/api/chat/stream", { question: "Какая сумма договора в Project?", conversationId: conversationD });
  assert.equal(donePayload(ambiguousSse)?.clarification?.kind, "project");
  const replySse = await postSse(api.baseUrl, "/api/chat/stream", { question: "2", conversationId: conversationD });
  const chosen = donePayload(ambiguousSse).clarification.options.find((option) => option.index === 2).sourceId;
  assert.equal(donePayload(replySse)?.matchedSource?.id, chosen);

  // Without a conversation the clarification is still returned (a stateless client answers with sourceId).
  const stateless = await postJson(api.baseUrl, "/api/chat", { question: "Какая сумма договора в Project?" });
  assert.equal(stateless.payload.clarification?.kind, "project");
  assert.equal("conversationId" in stateless.payload, false);

  // Archive and delete.
  const archived = await requestJson(api.baseUrl, `/api/conversations/${conversationB}`, { method: "PATCH", body: { archived: true } });
  assert.equal(archived.payload.archived, true);
  const list = await requestJson(api.baseUrl, "/api/conversations");
  assert.ok(!list.payload.conversations.some((conversation) => conversation.id === conversationB));
  assert.equal((await requestJson(api.baseUrl, `/api/conversations/${conversationB}`, { method: "DELETE" })).status, 204);
  assert.equal((await requestJson(api.baseUrl, `/api/conversations/${conversationB}`)).status, 404);
});

// Stage 08 contract: the acceptance flow over the real portal API with a fake local LLM.
// The bot talks to /api/chat like the web UI; only Telegram itself is faked.
//
//   npm run tg:contract
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import {
  addSource,
  createTempRuntime,
  indexSource,
  postJson,
  projectRoot,
  startApi,
  startFakeLlm
} from "../../../tests/helpers/chat-runtime.mjs";
import { handleUpdate } from "../src/handlers.js";
import { createLocalApi } from "../src/local-api.js";
import { createRateLimiter, createSessions } from "../src/sessions.js";

const KEEP_TEMP = process.env.TELEGRAM_CONTRACT_KEEP_TEMP === "1";
const ALLOWED = 42;
const STRANGER = 7;
const CHAT = 500;

function fakeTelegram() {
  const sent = [];
  return {
    sent,
    lastText: () => sent.at(-1)?.text || "",
    lastKeyboard: () => sent.at(-1)?.options?.reply_markup?.inline_keyboard || [],
    safeMessage: (value) => String(value),
    sendMessage: async (chatId, text, options = {}) => {
      sent.push({ chatId, text, options });
      return { message_id: sent.length };
    },
    sendChatAction: async () => null,
    answerCallbackQuery: async () => null,
    editMessageText: async () => null,
    deleteMessage: async () => null
  };
}

const message = (text, from = ALLOWED) => ({ message: { text, from: { id: from }, chat: { id: CHAT } } });
const callback = (data, from = ALLOWED) => ({ callback_query: { id: "cb", data, from: { id: from }, message: { chat: { id: CHAT } } } });

test("telegram flow: clarification, resume, follow-up, /new and an unauthorized user", { timeout: 10 * 60 * 1000 }, async (t) => {
  const runDir = path.join(projectRoot, ".tmp", "telegram-contract", `run-${process.pid}-${Date.now()}`);
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

  for (const [title, folder] of [
    ["ЖК Сокольники, Стромынка", "stromynka"],
    ["Сокольники Парк, Русаковская", "rusakovskaya"]
  ]) {
    const source = await addSource(api.baseUrl, { title, folder: path.join(root, "fixtures", "product-v2", folder) });
    await indexSource(api.baseUrl, source.id);
    assert.equal((await postJson(api.baseUrl, "/api/evidence/rebuild", { sourceId: source.id })).status, 200);
  }

  const ctx = {
    config: { allowedUserIds: [String(ALLOWED)] },
    telegram: fakeTelegram(),
    api: createLocalApi({ baseUrl: api.baseUrl, timeoutSeconds: 120 }),
    sessions: createSessions(),
    rateLimiter: createRateLimiter({ perMinute: 30 })
  };

  // 0. Commands read the real portal: the project list and the status must not be empty.
  await handleUpdate(ctx, message("/sources"));
  const sourcesText = ctx.telegram.lastText();
  assert.match(sourcesText, /Проекты \(2\)/);
  assert.match(sourcesText, /ЖК Сокольники, Стромынка/);
  assert.match(sourcesText, /Сокольники Парк, Русаковская/);
  assert.equal(sourcesText.includes(root), false, "no local path in the project list");
  assert.equal(sourcesText.includes("\\"), false);

  await handleUpdate(ctx, message("/status"));
  assert.match(ctx.telegram.lastText(), /Портал: доступен/);
  assert.match(ctx.telegram.lastText(), /Проектов: 2/);

  // The whitelist itself is asserted against the live portal: a source object must never pass through whole.
  const liveSources = await ctx.api.sources();
  assert.equal(liveSources.length, 2);
  for (const source of liveSources) {
    assert.deepEqual(Object.keys(source).sort(), ["id", "indexStatus", "indexedFiles", "sourceType", "title"]);
  }
  const serializedSources = JSON.stringify(liveSources);
  assert.equal(serializedSources.includes(root), false);
  assert.equal(serializedSources.includes("path"), false);

  await handleUpdate(ctx, message("/project"));
  assert.equal(ctx.telegram.lastKeyboard().length, 2, "the project keyboard is built from the real list");

  // 1-2. Two projects match "Сокольники": the bot asks instead of guessing.
  await handleUpdate(ctx, message("Какой размер аванса по Сокольникам?"));
  const options = ctx.telegram.lastKeyboard().map((row) => row[0]);
  assert.deepEqual(options.map((option) => option.callback_data), ["c:0", "c:1"]);
  assert.ok(options.some((option) => option.text === "ЖК Сокольники, Стромынка"));

  // 3-5. The choice resumes the original question and the answer arrives verified, with citations.
  await handleUpdate(ctx, callback("c:0"));
  const answer = ctx.telegram.lastText();
  assert.match(answer, /10%/, "the current advance from the amendment");
  assert.match(answer, /\[1\]/);
  assert.match(answer, /Источники\n\[1\] /);
  assert.match(answer, /^✓ Проверено по документам/, "the status comes first");
  assert.equal(answer.includes(root), false, "no local paths reach Telegram");
  assert.equal(answer.includes("\\"), false);

  // The fragment button shows a bounded excerpt of the cited evidence, not the document.
  await handleUpdate(ctx, callback("f:0"));
  assert.match(ctx.telegram.lastText(), /^\[1\] /);
  assert.ok(ctx.telegram.lastText().length < 1200);

  // 6. A follow-up stays in the same conversation (the server keeps the history).
  const conversationId = ctx.sessions.get(CHAT).conversationId;
  assert.ok(conversationId);
  await handleUpdate(ctx, message("А какой срок выплаты аванса?"));
  assert.equal(ctx.sessions.get(CHAT).conversationId, conversationId);
  const history = llm.chatRequests.at(-1).messages.map((item) => item.role);
  assert.ok(history.filter((role) => role === "user").length >= 1);

  // 7. /new drops the conversation and the pinned project.
  await handleUpdate(ctx, message("/new"));
  assert.notEqual(ctx.sessions.get(CHAT).conversationId, conversationId);
  assert.equal(ctx.sessions.get(CHAT).pinnedSourceId, "");
  await handleUpdate(ctx, message("Какой размер аванса по Сокольникам?"));
  assert.deepEqual(ctx.telegram.lastKeyboard().map((row) => row[0].callback_data), ["c:0", "c:1"], "the scope is reset, so the project is asked again");

  // 8. An unauthorized user gets a neutral refusal and learns nothing about the projects.
  const before = ctx.telegram.sent.length;
  await handleUpdate(ctx, message("Какой размер аванса по Сокольникам?", STRANGER));
  await handleUpdate(ctx, message("/sources", STRANGER));
  const strangerReplies = ctx.telegram.sent.slice(before).map((item) => item.text);
  assert.deepEqual(strangerReplies, ["Доступ не настроен.", "Доступ не настроен."]);
});

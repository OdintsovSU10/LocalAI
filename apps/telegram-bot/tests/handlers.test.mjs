import assert from "node:assert/strict";
import test from "node:test";

import { handleUpdate, isAllowed } from "../src/handlers.js";
import { createRateLimiter, createSessions } from "../src/sessions.js";

const ALLOWED = 42;
const STRANGER = 7;

function fakeTelegram() {
  const sent = [];
  const answered = [];
  return {
    sent,
    answered,
    lastText: () => sent.at(-1)?.text || "",
    safeMessage: (value) => String(value),
    sendMessage: async (chatId, text, options = {}) => {
      sent.push({ chatId, text, options });
      return { message_id: sent.length };
    },
    sendChatAction: async () => null,
    answerCallbackQuery: async (id, text = "") => answered.push({ id, text }),
    editMessageText: async () => null,
    deleteMessage: async () => null
  };
}

function fakeApi(overrides = {}) {
  const calls = { ask: [], archived: [], conversations: 0 };
  return {
    calls,
    sources: async () => [
      { id: "s1", title: "ЖК Сокольники, Стромынка", indexStatus: "completed", indexedFiles: 4 },
      { id: "s2", title: "Балчуг, Садовническая", indexStatus: "running", indexedFiles: 1 }
    ],
    status: async () => ({ ok: true, projects: 2, verified: true, verifier: "отдельная модель judge", model: "answer-model" }),
    conversationForChat: async () => {
      calls.conversations += 1;
      return "conv-1";
    },
    newConversation: async () => "conv-2",
    archiveConversation: async (id) => calls.archived.push(id),
    ask: async (request) => {
      calls.ask.push(request);
      return { answer: "Аванс 10%. [1]", sources: [{ citationLabel: "ds-01.md, п. 1", citationEvidence: "аванс в размере 10%" }], answerStatus: "verified", verification: { level: "model" } };
    },
    ...overrides
  };
}

function context(api = fakeApi(), { perMinute = 10 } = {}) {
  return {
    config: { allowedUserIds: [String(ALLOWED)] },
    telegram: fakeTelegram(),
    api,
    sessions: createSessions(),
    rateLimiter: createRateLimiter({ perMinute })
  };
}

const message = (text, from = ALLOWED, chat = 100) => ({ message: { text, from: { id: from }, chat: { id: chat } } });
const callback = (data, from = ALLOWED, chat = 100) => ({ callback_query: { id: "cb", data, from: { id: from }, message: { chat: { id: chat } } } });

test("a stranger learns nothing: no projects, no portal details", async () => {
  const api = fakeApi();
  const ctx = context(api);
  await handleUpdate(ctx, message("Какой аванс по Балчугу?", STRANGER));
  await handleUpdate(ctx, callback("p:0", STRANGER));
  assert.deepEqual(ctx.telegram.sent.map((item) => item.text), ["Доступ не настроен."]);
  assert.deepEqual(ctx.telegram.answered, [{ id: "cb", text: "Доступ не настроен." }]);
  assert.equal(api.calls.ask.length, 0);
  assert.equal(isAllowed(ctx.config, ALLOWED), true);
});

test("a question goes to the portal with the chat conversation and comes back with citations", async () => {
  const api = fakeApi();
  const ctx = context(api);
  await handleUpdate(ctx, message("Какой аванс?"));
  await handleUpdate(ctx, message("А срок выплаты?"));

  assert.deepEqual(api.calls.ask.map((request) => request.question), ["Какой аванс?", "А срок выплаты?"]);
  assert.equal(api.calls.ask[1].conversationId, "conv-1", "the follow-up stays in the same conversation");
  assert.equal(api.calls.conversations, 1, "the conversation is resolved once per chat");
  assert.match(ctx.telegram.lastText(), /\[1\] ds-01\.md, п\. 1/);
  assert.match(ctx.telegram.lastText(), /Проверено по документам/);
  assert.deepEqual(ctx.telegram.sent.at(-1).options.reply_markup.inline_keyboard[0][0], { text: "Фрагмент 1", callback_data: "f:0" });
});

test("an ambiguous project is answered with buttons, and the choice resumes the question", async () => {
  const api = fakeApi({
    ask: async function ask(request) {
      this.calls.ask.push(request);
      return this.calls.ask.length === 1
        ? { answer: "Уточните проект.", sources: [], projectCandidates: [{ id: "s1", title: "ЖК Сокольники, Стромынка" }, { id: "s2", title: "Балчуг, Садовническая" }], answerStatus: "clarification_required" }
        : { answer: "Аванс 30%. [1]", sources: [{ citationLabel: "dogovor-b-44.md, п. 3.1" }], answerStatus: "verified", verification: { level: "model" } };
    }
  });
  const ctx = context(api);
  await handleUpdate(ctx, message("Какой аванс по Сокольникам?"));
  const keyboard = ctx.telegram.sent.at(-1).options.reply_markup.inline_keyboard;
  assert.deepEqual(keyboard.map((row) => row[0].callback_data), ["c:0", "c:1"]);

  await handleUpdate(ctx, callback("c:1"));
  assert.equal(api.calls.ask.at(-1).question, "Балчуг, Садовническая");
  assert.match(ctx.telegram.lastText(), /Аванс 30%/);
});

test("a fragment button shows a bounded excerpt of the cited evidence", async () => {
  const ctx = context();
  await handleUpdate(ctx, message("Какой аванс?"));
  await handleUpdate(ctx, callback("f:0"));
  assert.match(ctx.telegram.lastText(), /^\[1\] ds-01\.md, п\. 1/);
  assert.match(ctx.telegram.lastText(), /аванс в размере 10%/);

  await handleUpdate(ctx, callback("f:5"));
  assert.match(ctx.telegram.lastText(), /уже недоступен/);
});

test("/new starts a fresh conversation and clears the pinned project", async () => {
  const api = fakeApi();
  const ctx = context(api);
  await handleUpdate(ctx, message("Какой аванс?"));
  await handleUpdate(ctx, message("/project"));
  await handleUpdate(ctx, callback("p:1"));
  assert.equal(ctx.sessions.get(100).pinnedSourceId, "s2");
  assert.match(ctx.telegram.lastText(), /Проект: Балчуг, Садовническая/);

  await handleUpdate(ctx, message("/new"));
  assert.deepEqual(api.calls.archived, ["conv-1"]);
  assert.equal(ctx.sessions.get(100).pinnedSourceId, "");
  assert.equal(ctx.sessions.get(100).conversationId, "conv-2");
  assert.match(ctx.telegram.lastText(), /новый разговор/i);

  await handleUpdate(ctx, message("Какой аванс?"));
  assert.equal(api.calls.ask.at(-1).conversationId, "conv-2");
  assert.equal(api.calls.ask.at(-1).sourceId, "");
});

test("commands report projects and portal state without local paths", async () => {
  const ctx = context();
  await handleUpdate(ctx, message("/sources"));
  assert.match(ctx.telegram.lastText(), /ЖК Сокольники, Стромынка — файлов в индексе: 4/);
  assert.match(ctx.telegram.lastText(), /индексация: running/);

  await handleUpdate(ctx, message("/status"));
  assert.match(ctx.telegram.lastText(), /Портал: доступен/);
  assert.match(ctx.telegram.lastText(), /Проверяющий: отдельная модель judge/);

  await handleUpdate(ctx, message("/project"));
  assert.deepEqual(ctx.telegram.sent.at(-1).options.reply_markup.inline_keyboard.map((row) => row[0].text), ["ЖК Сокольники, Стромынка", "Балчуг, Садовническая"]);

  await handleUpdate(ctx, message("/project авто"));
  assert.match(ctx.telegram.lastText(), /определяется по вопросу/);
  await handleUpdate(ctx, message("/unknown"));
  assert.match(ctx.telegram.lastText(), /Не знаю такую команду/);
});

test("a flood gets a neutral refusal, and /cancel stops a running request", async () => {
  const ctx = context(fakeApi(), { perMinute: 1 });
  await handleUpdate(ctx, message("Первый вопрос"));
  await handleUpdate(ctx, message("Второй вопрос"));
  assert.match(ctx.telegram.lastText(), /Слишком много запросов/);

  const slow = fakeApi({
    ask: (request) => new Promise((resolve, reject) => {
      request.signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
    })
  });
  const cancelCtx = context(slow);
  const pending = handleUpdate(cancelCtx, message("Долгий вопрос"));
  await new Promise((resolve) => setImmediate(resolve));
  await handleUpdate(cancelCtx, message("/cancel"));
  await pending;
  assert.match(cancelCtx.telegram.lastText(), /Запрос остановлен/);
  assert.equal(cancelCtx.telegram.sent.some((item) => /недоступен/.test(item.text)), false, "a cancelled request reports no error");
});

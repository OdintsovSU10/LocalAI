import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { openAppStateDatabase } from "../apps/rag-api/src/conversation/app-state-db.js";
import { createConversationStore, safeCitations } from "../apps/rag-api/src/conversation/conversation-store.js";

// Stores are closed before the temp dir is removed: an open SQLite file cannot be deleted on Windows.
async function tempDatabase(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "localai-conversations-"));
  const openStores = [];
  t.after(async () => {
    for (const store of openStores) store.close();
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  const databasePath = path.join(dir, "state", "app-state.sqlite");
  return {
    databasePath,
    open: async () => {
      const store = await createConversationStore({ databasePath });
      openStores.push(store);
      return store;
    }
  };
}

test("migrations are idempotent and recorded once", async (t) => {
  const { databasePath } = await tempDatabase(t);
  const first = await openAppStateDatabase(databasePath);
  first.close();
  const second = await openAppStateDatabase(databasePath);
  const rows = second.prepare("SELECT version, name FROM schema_migrations ORDER BY version").all();
  second.close();
  assert.deepEqual(rows.map((row) => row.name), ["001_conversations.sql"]);
});

test("conversation lifecycle: create, list, archive, restore, delete", async (t) => {
  const store = await (await tempDatabase(t)).open();

  const conversation = store.createConversation({ title: "  Договор   Стромынка ", pinnedSourceId: "pv2-stromynka" });
  assert.equal(conversation.channel, "web");
  assert.equal(conversation.title, "Договор Стромынка");
  assert.equal(conversation.pinnedSourceId, "pv2-stromynka");
  assert.equal(store.listConversations().length, 1);

  assert.equal(store.updateConversation(conversation.id, { archived: true }).archived, true);
  assert.equal(store.listConversations().length, 0);
  assert.equal(store.listConversations({ includeArchived: true }).length, 1);
  assert.equal(store.updateConversation(conversation.id, { archived: false }).archived, false);

  store.appendMessage(conversation.id, { role: "user", text: "Вопрос" });
  assert.equal(store.deleteConversation(conversation.id), true);
  assert.equal(store.getConversation(conversation.id), null);
  assert.deepEqual(store.listMessages(conversation.id), []);
  assert.equal(store.deleteConversation(conversation.id), false);
});

test("channels are isolated", async (t) => {
  const store = await (await tempDatabase(t)).open();
  const telegram = store.createConversation({ channel: "telegram", title: "TG" });
  store.createConversation({ channel: "web", title: "Web" });

  assert.deepEqual(store.listConversations({ channel: "web" }).map((item) => item.title), ["Web"]);
  assert.equal(store.getConversation(telegram.id, { channel: "web" }), null);
  assert.equal(store.updateConversation(telegram.id, { title: "x" }, { channel: "web" }), null);
  assert.equal(store.deleteConversation(telegram.id, { channel: "web" }), false);
  assert.throws(() => store.createConversation({ channel: "email" }), /unknown conversation channel/);
});

test("appendTurn stores an ordered pair, pins the matched project and keeps other conversations separate", async (t) => {
  const store = await (await tempDatabase(t)).open();
  const first = store.createConversation({});
  const second = store.createConversation({});

  store.appendTurn(first.id, {
    question: "Какой размер гарантийного удержания по Стромынке?",
    answer: "3% [1].",
    assistant: { pinnedSourceId: "pv2-stromynka", answerStatus: "unverified", scope: { matchedSourceId: "pv2-stromynka" }, traceId: "trace-1" }
  });
  store.appendTurn(first.id, { question: "А какой срок выплаты?", answer: "30 дней [1].", assistant: {} });

  const messages = store.listMessages(first.id);
  assert.deepEqual(messages.map((message) => [message.seq, message.role]), [[1, "user"], [2, "assistant"], [3, "user"], [4, "assistant"]]);
  assert.equal(messages[1].answerStatus, "unverified");
  assert.equal(messages[1].traceId, "trace-1");

  const updated = store.getConversation(first.id);
  assert.equal(updated.pinnedSourceId, "pv2-stromynka", "a turn without a matched project keeps the pin");
  assert.equal(updated.title, "Какой размер гарантийного удержания по Стромынке?");
  assert.equal(updated.messageCount, 4);
  assert.deepEqual(store.listMessages(second.id), []);
  assert.deepEqual(store.listMessages(first.id, { limit: 2 }).map((message) => message.seq), [3, 4]);
  assert.throws(() => store.appendTurn("missing", { question: "q", answer: "a" }), /conversation not found/);
  assert.throws(() => store.appendMessage(first.id, { role: "system", text: "x" }), /unknown message role/);
});

test("conversations survive closing and reopening the database", async (t) => {
  const { databasePath, open } = await tempDatabase(t);
  const store = await createConversationStore({ databasePath });
  const conversation = store.createConversation({ title: "Перезапуск" });
  store.appendTurn(conversation.id, { question: "Вопрос", answer: "Ответ", assistant: {} });
  store.close();

  const reopened = await open();
  assert.equal(reopened.getConversation(conversation.id).title, "Перезапуск");
  assert.equal(reopened.listMessages(conversation.id).length, 2);
});

test("importLegacySession is idempotent and keeps only user/assistant messages", async (t) => {
  const store = await (await tempDatabase(t)).open();
  const session = {
    id: "chat-1700000000000-abc",
    title: "Новый чат",
    sourceId: "pv2-balchug",
    createdAt: "2026-09-01T10:00:00.000Z",
    updatedAt: "2026-09-01T10:05:00.000Z",
    archivedAt: "2026-09-02T00:00:00.000Z",
    messages: [
      { role: "user", text: "Какая цена договора?", createdAt: "2026-09-01T10:00:00.000Z" },
      { role: "assistant", text: "180 000 000 рублей [1].", sources: [{ id: "c1", sourceId: "pv2-balchug", path: "D:\\\\private\\\\dogovor.md", text: "полный текст", citationTarget: { fileLabel: "dogovor.md", pageStart: 2 } }] },
      { role: "system", text: "служебное" },
      { role: "assistant", text: "   " }
    ]
  };

  const first = store.importLegacySession(session);
  const second = store.importLegacySession(session);
  assert.equal(first.created, true);
  assert.equal(second.created, false);
  assert.equal(second.conversation.id, first.conversation.id);
  assert.equal(store.listConversations({ includeArchived: true }).length, 1);

  const conversation = first.conversation;
  assert.equal(conversation.title, "");
  assert.equal(conversation.pinnedSourceId, "pv2-balchug");
  assert.equal(conversation.archived, true);
  const messages = store.listMessages(conversation.id);
  assert.deepEqual(messages.map((message) => message.role), ["user", "assistant"]);
  assert.equal(messages[1].answerStatus, "imported");
  const stored = JSON.stringify(messages);
  assert.ok(!stored.includes("private"), "absolute paths must not be stored");
  assert.ok(!stored.includes("полный текст"), "document text must not be stored with citations");
  assert.equal(messages[1].citations[0].pageStart, 2);
  assert.throws(() => store.importLegacySession({ title: "no id" }), /legacy session id is required/);
});

test("safeCitations keeps ids and locations only", () => {
  const [citation] = safeCitations([{
    id: "chunk-7",
    sourceId: "p1",
    fileId: "f1",
    path: "C:/secret/file.md",
    text: "secret text",
    snippet: "secret snippet",
    citationLabel: "file.md, стр. 3",
    citationTarget: { fileLabel: "file.md", pageStart: 3, pageEnd: 3, sheetName: "", rowStart: null }
  }]);
  assert.deepEqual(JSON.parse(JSON.stringify(citation)), {
    citationId: 1,
    sourceId: "p1",
    fileId: "f1",
    chunkId: "chunk-7",
    label: "file.md, стр. 3",
    fileLabel: "file.md",
    pageStart: 3,
    pageEnd: 3
  });
});

test("pending clarification is stored per conversation and can be cleared", async (t) => {
  const store = await (await tempDatabase(t)).open();
  const first = store.createConversation({});
  const second = store.createConversation({});
  const clarification = { kind: "project", originalQuestion: "Какой аванс по Сокольникам?", options: [{ index: 1, sourceId: "a", title: "A" }] };

  assert.equal(store.getPendingClarification(first.id), null);
  store.setPendingClarification(first.id, clarification);
  assert.deepEqual(store.getPendingClarification(first.id), clarification);
  assert.equal(store.getPendingClarification(second.id), null);
  store.setPendingClarification(first.id, null);
  assert.equal(store.getPendingClarification(first.id), null);
  assert.throws(() => store.setPendingClarification("missing", clarification), /conversation not found/);

  store.setPendingClarification(first.id, clarification);
  store.deleteConversation(first.id);
  assert.equal(store.getPendingClarification(first.id), null);
});

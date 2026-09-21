import assert from "node:assert/strict";
import test from "node:test";

import { parseAllowlist, readBotConfig, resolveLocalApiUrl } from "../src/config.js";
import {
  HELP_TEXT,
  MAX_EXCERPT_CHARS,
  answerKeyboard,
  answerMessage,
  excerptMessage,
  projectKeyboard,
  sourceLabel,
  splitMessage,
  statusLine
} from "../src/format.js";
import { MAX_MESSAGE_CHARS } from "../src/telegram-api.js";
import { createRateLimiter } from "../src/sessions.js";

const env = (overrides = {}) => ({
  TELEGRAM_BOT_TOKEN: "123:abc",
  TELEGRAM_ALLOWED_USER_IDS: "42",
  ...overrides
});

test("the bot refuses to start without a token or an allowlist", () => {
  assert.deepEqual(readBotConfig(env({ TELEGRAM_BOT_TOKEN: "" })).config, null);
  assert.match(readBotConfig(env({ TELEGRAM_BOT_TOKEN: "" })).problems.join(" "), /TELEGRAM_BOT_TOKEN/);
  assert.deepEqual(readBotConfig(env({ TELEGRAM_ALLOWED_USER_IDS: "" })).config, null);
  assert.match(readBotConfig(env({ TELEGRAM_ALLOWED_USER_IDS: " " })).problems.join(" "), /answer anyone/);
  // A username in the allowlist is a configuration mistake, and the message says which value is needed.
  assert.match(readBotConfig(env({ TELEGRAM_ALLOWED_USER_IDS: "@baldmaxim" })).problems.join(" "), /numeric id/);
  assert.match(readBotConfig(env({ TELEGRAM_ALLOWED_USER_IDS: "@baldmaxim" })).problems.join(" "), /@userinfobot/);

  const { config } = readBotConfig(env({ TELEGRAM_ALLOWED_USER_IDS: "42, 7;-100500 42 x" }));
  assert.deepEqual(config.allowedUserIds, ["42", "7", "-100500"]);
  assert.equal(config.apiBaseUrl, "http://127.0.0.1:8787");
  assert.equal(config.rateLimitPerMinute, 10);
});

test("the portal address must stay on loopback", () => {
  assert.equal(resolveLocalApiUrl("http://localhost:8787/"), "http://localhost:8787");
  assert.throws(() => resolveLocalApiUrl("http://192.168.1.10:8787"), /loopback/);
  assert.throws(() => resolveLocalApiUrl("https://example.com"), /loopback/);
  assert.throws(() => resolveLocalApiUrl("not a url"), /valid HTTP/);
  assert.deepEqual(parseAllowlist("1,2,2"), ["1", "2"]);
});

test("the status line states what the verification actually did", () => {
  assert.equal(statusLine({ answerStatus: "verified", verification: { level: "model" } }), "Проверено по документам");
  assert.equal(statusLine({ answerStatus: "verified", verification: { level: "hard_checks" } }), "Числа и ссылки сверены с документами");
  assert.equal(statusLine({ answerStatus: "verified", verification: { level: "model", droppedClaims: 2 } }), "Проверено по документам · скрыто неподтверждённых: 2");
  assert.equal(statusLine({ answerStatus: "insufficient_evidence" }), "Не подтверждено документами");
  assert.equal(statusLine({}), "");
});

test("a message never carries a local path: only citation labels", () => {
  const sources = [
    { citationLabel: "dogovor-15-p.md, п. 3.1", path: "D:\\LOCAL_RAG\\data\\dogovor.md", text: "3.1 …" },
    { title: "smeta.xlsx", path: "/home/user/smeta.xlsx" }
  ];
  const message = answerMessage({ answer: "Аванс 10%. [1]", sources, answerStatus: "verified", verification: { level: "model" } });
  assert.match(message, /Аванс 10%\. \[1\]/);
  assert.match(message, /\[1\] dogovor-15-p\.md, п\. 3\.1/);
  assert.match(message, /\[2\] smeta\.xlsx/);
  assert.equal(message.includes("LOCAL_RAG"), false);
  assert.equal(message.includes("/home/user"), false);
  assert.equal(sourceLabel({}), "документ");
});

test("an excerpt is bounded and marked with its citation number", () => {
  const source = { citationLabel: "dogovor.md, п. 5.2", citationEvidence: "я".repeat(2000) };
  const excerpt = excerptMessage(source, 1);
  assert.match(excerpt, /^\[2\] dogovor\.md, п\. 5\.2/);
  assert.ok(excerpt.length < MAX_EXCERPT_CHARS + 60);
  assert.ok(excerpt.endsWith("…"));
  assert.match(excerptMessage({ citationLabel: "x" }, 0), /Фрагмент недоступен/);
});

test("long answers are split on boundaries; a wall of text is cut only as a last resort", () => {
  const paragraphs = Array.from({ length: 300 }, (_, index) => `Условие ${index + 1}: значение ${index + 1} рублей.`).join("\n\n");
  const parts = splitMessage(paragraphs);
  assert.ok(parts.length >= 3);
  assert.ok(parts.every((part) => part.length <= MAX_MESSAGE_CHARS));
  assert.ok(parts.every((part) => part.endsWith("рублей.")), "parts end on a paragraph, not mid-word");
  assert.equal(parts.join("\n\n"), paragraphs);

  const wall = splitMessage("д".repeat(9000));
  assert.deepEqual(wall.map((part) => part.length), [MAX_MESSAGE_CHARS, MAX_MESSAGE_CHARS, 9000 - 2 * MAX_MESSAGE_CHARS]);
  assert.deepEqual(splitMessage("короткий"), ["короткий"]);
  assert.deepEqual(splitMessage("   "), []);
});

test("keyboards are built for clarification options and cited fragments", () => {
  assert.deepEqual(projectKeyboard([{ id: "a", title: "Балчуг" }], "c").inline_keyboard, [[{ text: "Балчуг", callback_data: "c:0" }]]);
  assert.deepEqual(answerKeyboard([{}, {}]).inline_keyboard, [[
    { text: "Фрагмент 1", callback_data: "f:0" },
    { text: "Фрагмент 2", callback_data: "f:1" }
  ]]);
  assert.equal(answerKeyboard([]), undefined);
  assert.equal(answerKeyboard(Array.from({ length: 9 }, () => ({}))).inline_keyboard[0].length, 5);
});

test("help states the privacy trade-off of Telegram", () => {
  assert.match(HELP_TEXT, /документы и индекс остаются на вашем компьютере/i);
  assert.match(HELP_TEXT, /проходят через серверы Telegram/i);
  for (const command of ["/new", "/project", "/sources", "/status", "/cancel", "/help"]) assert.ok(HELP_TEXT.includes(command), command);
});

test("the rate limiter counts a minute per user", () => {
  let now = 1_000_000;
  const limiter = createRateLimiter({ perMinute: 2, now: () => now });
  assert.equal(limiter.allow("1"), true);
  assert.equal(limiter.allow("1"), true);
  assert.equal(limiter.allow("1"), false);
  assert.equal(limiter.allow("2"), true, "another user is not affected");
  now += 61_000;
  assert.equal(limiter.allow("1"), true);
});

import assert from "node:assert/strict";
import test from "node:test";

import { createLocalApi } from "../src/local-api.js";
import { createTelegramApi } from "../src/telegram-api.js";

const TOKEN = "123456:SECRET-TOKEN-XYZ";

function jsonResponse(payload, { ok = true, status = 200 } = {}) {
  return {
    ok,
    status,
    text: async () => JSON.stringify(payload),
    json: async () => payload
  };
}

test("the portal client never passes a local path or a key to the bot", async () => {
  const calls = [];
  const api = createLocalApi({
    baseUrl: "http://127.0.0.1:8787",
    authToken: "portal-token",
    fetchImpl: async (url, options) => {
      calls.push({ url, headers: options.headers });
      if (url.endsWith("/api/sources")) {
        return jsonResponse({
          sources: [{
            id: "s1",
            title: "ЖК Сокольники, Стромынка",
            path: "D:\\LOCAL_RAG\\projects\\stromynka",
            additionalPaths: ["C:\\Users\\odintsov.a.a\\Documents"],
            indexStatus: { status: "completed", indexedFiles: 4 }
          }]
        });
      }
      if (url.endsWith("/api/settings")) {
        return jsonResponse({
          llm: { model: "answer-model", apiKey: "lm-studio-secret", baseUrl: "http://127.0.0.1:1234/v1" },
          answering: { verified: true },
          verifier: { mode: "separate_model", model: "judge" },
          dataDir: "D:\\LOCAL_RAG"
        });
      }
      return jsonResponse({ ok: true });
    }
  });

  const sources = await api.sources();
  const serialized = JSON.stringify(sources);
  assert.deepEqual(Object.keys(sources[0]).sort(), ["id", "indexStatus", "indexedFiles", "sourceType", "title"]);
  for (const secret of ["LOCAL_RAG", "odintsov", "\\\\", "Documents"]) {
    assert.equal(serialized.includes(secret), false, secret);
  }

  const status = await api.status();
  const statusText = JSON.stringify(status);
  assert.deepEqual(status, { ok: true, projects: 1, verified: true, verifier: "отдельная модель judge", model: "answer-model" });
  assert.equal(statusText.includes("lm-studio-secret"), false);
  assert.equal(statusText.includes("LOCAL_RAG"), false);
  assert.equal(calls[0].headers.Authorization, "Bearer portal-token");
});

test("the status line names the verification mode without inventing one", async () => {
  const withSettings = (verifier) => createLocalApi({
    baseUrl: "http://127.0.0.1:8787",
    fetchImpl: async (url) => (url.endsWith("/api/settings")
      ? jsonResponse({ verifier, answering: { verified: true }, llm: { model: "m" } })
      : jsonResponse(url.endsWith("/api/sources") ? { sources: [] } : { ok: true }))
  });
  assert.match((await withSettings({ mode: "separate_model", model: "" }).status()).verifier, /только автоматические проверки/);
  assert.match((await withSettings({ mode: "same_model" }).status()).verifier, /та же модель/);
  assert.match((await withSettings({ mode: "off" }).status()).verifier, /выключен/);
});

test("the bot token never appears in an error the bot may log or show", async () => {
  const telegram = createTelegramApi({
    token: TOKEN,
    baseUrl: "https://api.telegram.test",
    // Telegram echoes the request URL (with the token) in some error descriptions.
    fetchImpl: async (url) => jsonResponse({ ok: false, description: `Unauthorized: ${url}` }, { ok: false, status: 401 })
  });

  await assert.rejects(() => telegram.sendMessage(1, "текст"), (error) => {
    assert.equal(error.message.includes(TOKEN), false, error.message);
    assert.match(error.message, /<token>/);
    return true;
  });
  assert.equal(telegram.safeMessage(`boom ${TOKEN} boom`), "boom <token> boom");

  const thrown = createTelegramApi({
    token: TOKEN,
    baseUrl: "https://api.telegram.test",
    fetchImpl: async () => {
      throw new Error(`connect failed for https://api.telegram.test/bot${TOKEN}/sendMessage`);
    }
  });
  await assert.rejects(() => thrown.sendMessage(1, "текст"), (error) => {
    assert.equal(error.message.includes(TOKEN), false);
    return true;
  });
});

test("optional Telegram calls never break an answer", async () => {
  const telegram = createTelegramApi({
    token: TOKEN,
    baseUrl: "https://api.telegram.test",
    fetchImpl: async () => jsonResponse({ ok: false, description: "chat not found" }, { ok: false, status: 400 })
  });
  assert.equal(await telegram.sendChatAction(1), null);
  assert.equal(await telegram.answerCallbackQuery("cb"), null);
  assert.equal(await telegram.editMessageText(1, 2, "текст"), null);
  await assert.rejects(() => telegram.sendMessage(1, "текст"), /chat not found/);
});

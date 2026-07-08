import assert from "node:assert/strict";
import test from "node:test";

import { resolveApiBaseUrl } from "../src/config.js";
import { ApiClientError, createApiClient } from "../src/client/api-client.js";

test("resolveApiBaseUrl accepts loopback hosts", () => {
  assert.equal(resolveApiBaseUrl({ RAG_API_URL: "http://127.0.0.1:8787" }), "http://127.0.0.1:8787");
  assert.equal(resolveApiBaseUrl({ RAG_API_URL: "http://localhost:8787/" }), "http://localhost:8787");
  assert.equal(resolveApiBaseUrl({ RAG_API_URL: "http://[::1]:8787" }), "http://[::1]:8787");
});

test("resolveApiBaseUrl rejects non-loopback hosts", () => {
  assert.throws(
    () => resolveApiBaseUrl({ RAG_API_URL: "http://192.168.1.10:8787" }),
    /loopback/i
  );
});

test("createApiClient rejects non-loopback request URLs", async () => {
  const client = createApiClient({
    apiBaseUrl: "http://127.0.0.1:8787",
    authToken: "test-token",
    requestTimeoutMs: 1000
  });

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    assert.match(String(url), /127\.0\.0\.1/);
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ ok: true })
    };
  };

  try {
    const payload = await client.get("/api/health");
    assert.deepEqual(payload, { ok: true });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("createApiClient redacts bearer tokens from API errors", async () => {
  const client = createApiClient({
    apiBaseUrl: "http://127.0.0.1:8787",
    authToken: "local-secret",
    requestTimeoutMs: 1000
  });

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: false,
    status: 401,
    text: async () => JSON.stringify({ error: "Unauthorized Bearer leaked-secret" })
  });

  try {
    await assert.rejects(
      () => client.get("/api/sources"),
      (error) => {
        assert.ok(error instanceof ApiClientError);
        assert.match(error.message, /Bearer \[redacted\]/);
        assert.doesNotMatch(error.message, /leaked-secret/);
        return true;
      }
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("createApiClient never exposes auth token in error messages", async () => {
  const secret = "rag-auth-token-value";
  const client = createApiClient({
    apiBaseUrl: "http://127.0.0.1:8787",
    authToken: secret,
    requestTimeoutMs: 1000
  });

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, options = {}) => {
    assert.equal(options.headers?.Authorization, `Bearer ${secret}`);
    throw new Error(`network failure with token ${secret}`);
  };

  try {
    await assert.rejects(
      () => client.get("/api/sources"),
      (error) => {
        assert.ok(error instanceof ApiClientError);
        assert.doesNotMatch(error.message, new RegExp(secret));
        return true;
      }
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

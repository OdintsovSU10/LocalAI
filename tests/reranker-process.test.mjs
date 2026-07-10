import test from "node:test";
import assert from "node:assert/strict";
import { defaultManagedRerankerBaseUrl, defaultManagedRerankerModel, managedRerankerSettings, managedRerankerStatus } from "../apps/rag-api/src/reranker-process.js";

test("managedRerankerSettings uses local BGE reranker defaults when settings are empty", () => {
  const settings = managedRerankerSettings({});

  assert.equal(settings.baseUrl, defaultManagedRerankerBaseUrl);
  assert.equal(settings.healthBaseUrl, defaultManagedRerankerBaseUrl);
  assert.equal(settings.healthUrl, `${defaultManagedRerankerBaseUrl}/health`);
  assert.equal(settings.endpoint, `${defaultManagedRerankerBaseUrl}/rerank`);
  assert.equal(settings.model, defaultManagedRerankerModel);
  assert.equal(settings.port, 8080);
  assert.equal(settings.local, true);
});

test("managedRerankerSettings checks health at the service root for rerank URLs", () => {
  const settings = managedRerankerSettings({
    enabled: true,
    baseUrl: "http://127.0.0.1:8080/rerank",
    model: "custom-reranker"
  });

  assert.equal(settings.healthBaseUrl, "http://127.0.0.1:8080");
  assert.equal(settings.healthUrl, "http://127.0.0.1:8080/health");
  assert.equal(settings.endpoint, "http://127.0.0.1:8080/rerank");
  assert.equal(settings.model, "custom-reranker");
});

test("managedRerankerSettings marks remote rerankers as unmanaged", () => {
  const settings = managedRerankerSettings({
    enabled: true,
    baseUrl: "https://reranker.example.test/rerank",
    model: "remote-model"
  });

  assert.equal(settings.local, false);
  assert.equal(settings.manageable, false);
  assert.equal(settings.healthBaseUrl, "https://reranker.example.test");
});

test("managedRerankerStatus keeps disabled settings separate from a running process", async (t) => {
  const previousFetch = globalThis.fetch;
  const previousEnabled = process.env.RAG_RERANKER_ENABLED;
  delete process.env.RAG_RERANKER_ENABLED;

  t.after(() => {
    globalThis.fetch = previousFetch;
    if (previousEnabled === undefined) delete process.env.RAG_RERANKER_ENABLED;
    else process.env.RAG_RERANKER_ENABLED = previousEnabled;
  });

  globalThis.fetch = async () => new Response(JSON.stringify({ ok: true, model: "health-model" }), {
    status: 200,
    headers: { "Content-Type": "application/json" }
  });

  const status = await managedRerankerStatus({
    enabled: false,
    baseUrl: "http://127.0.0.1:8080",
    model: "configured-model"
  });

  assert.equal(status.enabled, false);
  assert.equal(status.running, true);
  assert.equal(status.state, "disabled");
  assert.equal(status.model, "health-model");
});

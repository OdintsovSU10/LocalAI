import assert from "node:assert/strict";
import test from "node:test";

import { chatCompletionBody, listLlmModels, matchConfiguredModel, mergeModelRows, modelRowsFromPayload } from "../apps/rag-api/src/llm.js";

test("matchConfiguredModel keeps exact configured model ids", () => {
  assert.equal(
    matchConfiguredModel("qwen3.6-27b-mtp@q4_k_s", [
      "qwen3.6-27b-mtp@q6_k",
      "qwen3.6-27b-mtp@q4_k_s"
    ]),
    "qwen3.6-27b-mtp@q4_k_s"
  );
});

test("matchConfiguredModel resolves base model to available quantized variant", () => {
  assert.equal(
    matchConfiguredModel("qwen3.6-27b-mtp", [
      "minimax/minimax-m2.7",
      "qwen3.6-27b-mtp@q4_k_s",
      "qwen3.6-27b-mtp@q6_k"
    ]),
    "qwen3.6-27b-mtp@q6_k"
  );
});

test("modelRowsFromPayload reads LM Studio v1 loaded instances", () => {
  const rows = modelRowsFromPayload({
    models: [
      {
        type: "llm",
        key: "qwen/qwen3-8b",
        architecture: "qwen3",
        quantization: { name: "Q4_K_M" },
        loaded_instances: [
          {
            id: "qwen/qwen3-8b",
            config: { context_length: 8192 }
          }
        ],
        max_context_length: 32768
      }
    ]
  });

  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, "qwen/qwen3-8b");
  assert.equal(rows[0].loaded, true);
  assert.equal(rows[0].instanceId, "qwen/qwen3-8b");
  assert.equal(rows[0].loadedContextLength, 8192);
  assert.equal(rows[0].maxContextLength, 32768);
  assert.equal(rows[0].quantization, "Q4_K_M");
  assert.equal(rows[0].arch, "qwen3");
});

test("mergeModelRows keeps native catalog entries and loaded OpenAI metadata", () => {
  const rows = mergeModelRows(
    [
      { id: "qwen/qwen3-8b", type: "llm" },
      { id: "text-embedding-bge-m3", type: "embeddings" }
    ],
    [
      {
        id: "qwen/qwen3-8b",
        loaded: true,
        loadedContextLength: 8192,
        loadedInstances: ["qwen/qwen3-8b"]
      },
      { id: "qwen2.5-7b-instruct", type: "llm" }
    ]
  );

  assert.deepEqual(rows.map((row) => row.id), [
    "qwen/qwen3-8b",
    "text-embedding-bge-m3",
    "qwen2.5-7b-instruct"
  ]);
  assert.equal(rows[0].loaded, true);
  assert.equal(rows[0].loadedContextLength, 8192);
  assert.deepEqual(rows[0].loadedInstances, ["qwen/qwen3-8b"]);
});

test("listLlmModels uses LM Studio native catalog for local provider", async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url) => {
    const target = String(url);
    calls.push(target);
    const payloadByUrl = {
      "http://lm.local/v1/models": {
        data: [{ id: "loaded-chat", object: "model" }]
      },
      "http://lm.local/api/v1/models": {
        models: [
          { key: "catalog-a", type: "llm" },
          {
            key: "loaded-chat",
            type: "llm",
            loaded_instances: [{ id: "loaded-chat", config: { context_length: 4096 } }]
          }
        ]
      },
      "http://lm.local/api/v0/models": {
        data: [{ id: "catalog-b", object: "model" }]
      }
    };

    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify(payloadByUrl[target] || { data: [] })
    };
  };

  try {
    const models = await listLlmModels({
      provider: "local",
      baseUrl: "http://lm.local/v1",
      apiKey: "lm-studio",
      timeoutSeconds: 2
    });

    assert.deepEqual(models, ["catalog-a", "loaded-chat", "catalog-b"]);
    assert.deepEqual(calls, [
      "http://lm.local/v1/models",
      "http://lm.local/api/v1/models",
      "http://lm.local/api/v0/models"
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("chatCompletionBody disables thinking for local Qwen3 models only", () => {
  const qwen3Body = JSON.parse(chatCompletionBody({
    provider: "local",
    model: "qwen3-8b",
    temperature: 0.1,
    maxTokens: 700
  }, "qwen3-8b", [{ role: "user", content: "test" }]));

  assert.equal(qwen3Body.enable_thinking, false);
  assert.deepEqual(qwen3Body.chat_template_kwargs, { enable_thinking: false });
  assert.equal(Object.hasOwn(qwen3Body, "reasoning_effort"), false);

  const qwen25Body = JSON.parse(chatCompletionBody({
    provider: "local",
    model: "qwen2.5-7b-instruct",
    temperature: 0.1,
    maxTokens: 700
  }, "qwen2.5-7b-instruct", [{ role: "user", content: "test" }]));

  assert.equal(Object.hasOwn(qwen25Body, "enable_thinking"), false);
});

test("chatCompletionBody keeps generic remote payload OpenAI-compatible", () => {
  const mistralBody = JSON.parse(chatCompletionBody({
    provider: "remote",
    runtime: "openai-compatible",
    model: "mistral-small-24b",
    temperature: 0.1,
    maxTokens: 700
  }, "mistral-small-24b", [{ role: "user", content: "test" }]));

  assert.equal(Object.hasOwn(mistralBody, "ttl"), false);
  assert.equal(Object.hasOwn(mistralBody, "enable_thinking"), false);
  assert.equal(Object.hasOwn(mistralBody, "reasoning_effort"), false);

  const qwenBody = JSON.parse(chatCompletionBody({
    provider: "remote",
    runtime: "openai-compatible",
    model: "qwen3-30b-a3b-instruct",
    temperature: 0.1,
    maxTokens: 700
  }, "qwen3-30b-a3b-instruct", [{ role: "user", content: "test" }]));

  assert.equal(qwenBody.enable_thinking, false);
  assert.equal(Object.hasOwn(qwenBody, "ttl"), false);
});

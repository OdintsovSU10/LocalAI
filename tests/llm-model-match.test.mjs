import assert from "node:assert/strict";
import test from "node:test";

import { chatCompletionBody, matchConfiguredModel, modelRowsFromPayload } from "../apps/rag-api/src/llm.js";

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

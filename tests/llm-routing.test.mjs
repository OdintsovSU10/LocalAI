import assert from "node:assert/strict";
import test from "node:test";

import { chatLlmCandidates, llmRouteMetadata } from "../apps/rag-api/src/llm-routing.js";

function settings(llm = {}) {
  return {
    llm: {
      enabled: true,
      provider: "local",
      baseUrl: "http://127.0.0.1:1234/v1",
      apiKey: "lm-studio",
      model: "local-model",
      timeoutSeconds: 120,
      remote: {
        enabled: false,
        baseUrl: "https://remote.example/v1",
        apiKey: "secret",
        model: "remote-model",
        runtime: "lmstudio",
        timeoutSeconds: 300
      },
      ...llm,
      remote: {
        enabled: false,
        baseUrl: "https://remote.example/v1",
        apiKey: "secret",
        model: "remote-model",
        runtime: "lmstudio",
        timeoutSeconds: 300,
        ...(llm.remote || {})
      }
    }
  };
}

test("chatLlmCandidates defaults to local only", () => {
  const candidates = chatLlmCandidates(settings());

  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].provider, "local");
  assert.equal(candidates[0].selectedBaseUrlKind, "local");
  assert.equal(candidates[0].remoteContextAllowed, false);
});

test("chatLlmCandidates blocks remote when remote context is not enabled", () => {
  const candidates = chatLlmCandidates(settings({ provider: "remote" }));

  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].provider, "remote");
  assert.equal(candidates[0].missingRemoteContext, true);
  assert.equal(candidates[0].remoteContextAllowed, false);
});

test("chatLlmCandidates uses remote only for provider remote when context is enabled", () => {
  const candidates = chatLlmCandidates(settings({
    provider: "remote",
    remote: { enabled: true }
  }));

  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].provider, "remote");
  assert.equal(candidates[0].baseUrl, "https://remote.example/v1");
  assert.equal(candidates[0].missingRemoteContext, false);
});

test("chatLlmCandidates auto is local-first and only adds remote when allowed", () => {
  const candidates = chatLlmCandidates(settings({
    provider: "auto",
    remote: { enabled: true }
  }));

  assert.deepEqual(candidates.map((candidate) => candidate.provider), ["local", "remote"]);
  assert.equal(candidates[0].allowAutoFallback, true);
  assert.equal(candidates[1].selectedBy, "auto");
});

test("chatLlmCandidates can explicitly fallback to local after remote error", () => {
  const candidates = chatLlmCandidates(settings({
    provider: "remote",
    fallbackToLocalOnRemoteError: true,
    remote: { enabled: true }
  }));

  assert.deepEqual(candidates.map((candidate) => candidate.provider), ["remote", "local"]);
  assert.equal(candidates[0].allowAutoFallback, true);
  assert.equal(candidates[1].autoFallbackReason, "remote_failed");
});

test("llmRouteMetadata exposes non-secret routing metadata", () => {
  const [candidate] = chatLlmCandidates(settings({
    provider: "remote",
    remote: { enabled: true }
  }));

  assert.deepEqual(llmRouteMetadata(candidate, { fallbackUsed: true }), {
    selectedProvider: "remote",
    selectedBaseUrlKind: "remote",
    fallbackUsed: true,
    remoteContextAllowed: true,
    remoteRuntime: "lmstudio"
  });
});

test("chatLlmCandidates carries openai-compatible remote runtime", () => {
  const candidates = chatLlmCandidates(settings({
    provider: "remote",
    remote: {
      enabled: true,
      runtime: "vllm"
    }
  }));

  assert.equal(candidates[0].runtime, "openai-compatible");
  assert.equal(llmRouteMetadata(candidates[0]).remoteRuntime, "openai-compatible");
});

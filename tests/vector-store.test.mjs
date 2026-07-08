import assert from "node:assert/strict";
import test from "node:test";

import { vectorProviderDecision } from "../apps/rag-api/src/vector-store.js";

test("vectorProviderDecision uses qdrant when provider is qdrant", () => {
  assert.deepEqual(
    vectorProviderDecision({ vectorStore: { enabled: true, provider: "qdrant" } }),
    {
      configuredProvider: "qdrant",
      vectorProviderUsed: "qdrant",
      useQdrant: true,
      writeJson: false,
      qdrantRequired: true,
      warning: ""
    }
  );
});

test("vectorProviderDecision keeps json provider as explicit fallback/debug store", () => {
  assert.deepEqual(
    vectorProviderDecision({ vectorStore: { enabled: true, provider: "json" } }),
    {
      configuredProvider: "json",
      vectorProviderUsed: "json",
      useQdrant: false,
      writeJson: true,
      qdrantRequired: false,
      warning: ""
    }
  );
});

test("vectorProviderDecision uses qdrant first in auto when fake status is available", () => {
  const decision = vectorProviderDecision({
    vectorStore: { enabled: true, provider: "auto" },
    qdrantAvailable: true
  });

  assert.equal(decision.configuredProvider, "auto");
  assert.equal(decision.vectorProviderUsed, "qdrant");
  assert.equal(decision.useQdrant, true);
  assert.equal(decision.writeJson, false);
});

test("vectorProviderDecision falls back to json with warning in auto when fake qdrant status fails", () => {
  const decision = vectorProviderDecision({
    vectorStore: { enabled: true, provider: "auto" },
    qdrantAvailable: false,
    qdrantError: "connection refused"
  });

  assert.equal(decision.configuredProvider, "auto");
  assert.equal(decision.vectorProviderUsed, "json");
  assert.equal(decision.useQdrant, false);
  assert.equal(decision.writeJson, true);
  assert.match(decision.warning, /connection refused/);
});

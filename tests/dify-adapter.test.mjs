import assert from "node:assert/strict";
import test from "node:test";

import {
  authorizeDifyAdapterRequest,
  normalizeDifyRetrievalRequest,
  resolveDifySource,
  runDifyRetrieval
} from "../apps/rag-api/src/dify-adapter.js";

const sources = [
  {
    id: "source-alpha",
    title: "Alpha Tower",
    path: "C:\\private\\Alpha Tower",
    sourceType: "contract"
  },
  {
    id: "tender-alpha",
    title: "Alpha Tender",
    path: "C:\\private\\Alpha Tender",
    sourceType: "tender",
    linkedContractId: "source-alpha"
  },
  {
    id: "source-beta",
    title: "Beta Plaza",
    path: "C:\\private\\Beta Plaza",
    sourceType: "contract"
  }
];

test("authorizeDifyAdapterRequest requires the dedicated adapter token", () => {
  assert.deepEqual(
    authorizeDifyAdapterRequest("", {}),
    { ok: false, status: 503, error: "Dify adapter token is not configured" }
  );

  const missing = authorizeDifyAdapterRequest("", { LOCALAI_DIFY_ADAPTER_TOKEN: "adapter-token" });
  const wrong = authorizeDifyAdapterRequest("Bearer wrong", { LOCALAI_DIFY_ADAPTER_TOKEN: "adapter-token" });
  const ok = authorizeDifyAdapterRequest("Bearer adapter-token", { LOCALAI_DIFY_ADAPTER_TOKEN: "adapter-token" });

  assert.equal(missing.status, 401);
  assert.equal(wrong.status, 401);
  assert.equal(ok.ok, true);
});

test("normalizeDifyRetrievalRequest clamps limits and keeps privacy opt-in explicit", () => {
  const request = normalizeDifyRetrievalRequest({
    question: "payment terms",
    knowledge_id: "Alpha Tower",
    top_k: 1000,
    score_threshold: -2,
    hints: { project: "Alpha", needFreshIndex: "true" },
    privacy: { allowRemoteContext: "true", requestedBy: "dify-chatflow" }
  });

  assert.equal(request.query, "payment terms");
  assert.equal(request.knowledgeId, "Alpha Tower");
  assert.equal(request.topK, 30);
  assert.equal(request.scoreThreshold, 0);
  assert.equal(request.hints.needFreshIndex, true);
  assert.equal(request.privacy.allowRemoteContext, true);
});

test("normalizeDifyRetrievalRequest accepts Dify External Knowledge retrieval_setting", () => {
  const request = normalizeDifyRetrievalRequest({
    query: "payment terms",
    knowledge_id: "Alpha Tower",
    retrieval_setting: {
      top_k: 4,
      score_threshold: 0.32
    },
    metadata_condition: {
      logical_operator: "and",
      conditions: []
    }
  });

  assert.equal(request.topK, 4);
  assert.equal(request.scoreThreshold, 0.32);
  assert.deepEqual(request.metadataCondition, {
    logical_operator: "and",
    conditions: []
  });
});

test("resolveDifySource supports source aliases without requiring direct file paths", () => {
  const match = resolveDifySource(
    normalizeDifyRetrievalRequest({ query: "payment terms", knowledge_id: "Alpha Tower" }),
    sources
  );

  assert.equal(match.source.id, "source-alpha");
  assert.equal(match.matchedAutomatically, false);
  assert.equal(match.explicitSourceMissing, false);
});

test("runDifyRetrieval searches the scoped LOCAL_RAG index and returns Dify records", async () => {
  let searchArgs = null;
  const result = await runDifyRetrieval({
    body: {
      query: "Alpha Tower payment terms",
      sourceId: "source-alpha",
      top_k: 2,
      score_threshold: 0.15,
      privacy: { allowRemoteContext: true }
    },
    sources,
    settings: { llm: { allowRemoteContext: false } },
    searchChunks: async (args) => {
      searchArgs = args;
      return {
        results: [
          {
            id: "chunk-a",
            chunkId: "chunk-a",
            fileId: "file-a",
            sourceId: "source-alpha",
            score: 0.42,
            title: "Contract.pdf",
            path: "C:\\private\\Alpha Tower\\Contract.pdf",
            relativePath: "docs/Contract.pdf",
            citationLabel: "Contract.pdf, page 4",
            pageStart: 4,
            pageEnd: 4,
            snippet: "Payment is due within 30 days."
          },
          {
            id: "chunk-low",
            sourceId: "source-alpha",
            score: 0.04,
            title: "Low.pdf",
            snippet: "Below threshold."
          }
        ],
        metadata: {}
      };
    }
  });

  assert.equal(result.status, 200);
  assert.deepEqual(searchArgs, {
    query: "Alpha Tower payment terms",
    sourceId: "source-alpha",
    sourceIds: ["source-alpha", "tender-alpha"],
    limit: 2
  });
  assert.deepEqual(result.payload.source, {
    sourceId: "source-alpha",
    title: "Alpha Tower",
    matchedAutomatically: false,
    score: 100
  });
  assert.equal(result.payload.records.length, 1);
  assert.equal(result.payload.records[0].content, "Payment is due within 30 days.");
  assert.equal(result.payload.records[0].metadata.citationLabel, "[1]");
  assert.equal(result.payload.records[0].metadata.documentLabel, "Contract.pdf, page 4");
  assert.equal(result.payload.records[0].metadata.path, "docs/Contract.pdf");
  assert.equal(result.payload.privacy.remoteContextAllowed, false);
  assert.ok(result.payload.warnings.includes("remote context was denied by LOCAL_RAG privacy policy"));
});

test("runDifyRetrieval supports External Knowledge style request body", async () => {
  let searchArgs = null;
  const result = await runDifyRetrieval({
    body: {
      query: "Alpha Tower payment terms",
      knowledge_id: "Alpha Tower",
      retrieval_setting: {
        top_k: 1,
        score_threshold: 0.2
      },
      metadata_condition: { conditions: [{ name: "project", comparison_operator: "contains", value: "Alpha" }] }
    },
    sources,
    settings: {},
    searchChunks: async (args) => {
      searchArgs = args;
      return {
        results: [
          {
            id: "chunk-a",
            sourceId: "source-alpha",
            score: 0.5,
            title: "Contract.pdf",
            relativePath: "docs/Contract.pdf",
            snippet: "Payment is due within 30 days."
          },
          {
            id: "chunk-low",
            sourceId: "source-alpha",
            score: 0.1,
            title: "Low.pdf",
            snippet: "Below threshold."
          }
        ],
        metadata: {}
      };
    }
  });

  assert.equal(result.status, 200);
  assert.equal(searchArgs.limit, 1);
  assert.equal(result.payload.records.length, 1);
  assert.equal(result.payload.records[0].metadata.path, "docs/Contract.pdf");
  assert.ok(result.payload.warnings.some((warning) => warning.includes("metadata_condition was received")));
});

test("runDifyRetrieval strips private paths and URLs from Dify labels", async () => {
  const result = await runDifyRetrieval({
    body: {
      query: "Alpha Tower payment terms",
      top_k: 2,
      score_threshold: 0
    },
    sources,
    settings: {},
    searchChunks: async () => ({
      results: [
        {
          id: "chunk-secret",
          sourceId: "source-alpha",
          score: 0.9,
          title: "C:\\private\\Alpha Tower\\Contract.pdf",
          fileLabel: "C:\\private\\Alpha Tower\\Contract.pdf",
          path: "C:\\private\\Alpha Tower\\Contract.pdf",
          citationLabel: "C:\\private\\Alpha Tower\\Contract.pdf, page 4",
          snippet: "Payment is due within 30 days."
        },
        {
          id: "chunk-url",
          sourceId: "source-alpha",
          score: 0.8,
          title: "https://private.example.local/docs/Budget.pdf?download=1",
          path: "https://private.example.local/docs/Budget.pdf?download=1",
          citationLabel: "https://private.example.local/docs/Budget.pdf?download=1",
          snippet: "The budget is capped."
        }
      ],
      metadata: {}
    })
  });

  const [pathRecord, urlRecord] = result.payload.records;
  assert.equal(pathRecord.title, "Contract.pdf");
  assert.equal(pathRecord.metadata.path, "Contract.pdf");
  assert.equal(pathRecord.metadata.documentLabel, "Contract.pdf, page 4");
  assert.equal(urlRecord.title, "Budget.pdf");
  assert.equal(urlRecord.metadata.path, "Budget.pdf");
  assert.equal(urlRecord.metadata.documentLabel, "Budget.pdf");
  const serialized = JSON.stringify(result.payload);
  assert.ok(!serialized.includes("C:\\private"));
  assert.ok(!serialized.includes("private.example.local"));
  assert.ok(!serialized.includes("download=1"));
});

test("runDifyRetrieval falls back to all indexed sources when auto-match is not confident", async () => {
  let searchArgs = null;
  const result = await runDifyRetrieval({
    body: { query: "find warranty language", top_k: 3 },
    sources,
    settings: { llm: { allowRemoteContext: true } },
    searchChunks: async (args) => {
      searchArgs = args;
      return { results: [], metadata: {} };
    }
  });

  assert.equal(result.status, 200);
  assert.equal(searchArgs.sourceId, "");
  assert.equal(searchArgs.sourceIds, null);
  assert.equal(result.payload.source, null);
  assert.ok(result.payload.warnings.includes("source auto-match was not confident; searched all indexed sources"));
  assert.ok(result.payload.warnings.includes("no records above score threshold"));
});

test("runDifyRetrieval expands scoped search with stale manifest source ids", async () => {
  let searchArgs = null;
  await runDifyRetrieval({
    body: { query: "Alpha Tower payment terms", sourceId: "source-alpha" },
    sources,
    settings: {},
    manifest: {
      files: {
        stale: {
          fileId: "stale",
          sourceId: "source-alpha-old",
          path: "C:\\private\\Alpha Tower\\Contract.pdf",
          quality: { chunks: 1 }
        }
      }
    },
    searchChunks: async (args) => {
      searchArgs = args;
      return { results: [], metadata: {} };
    }
  });

  assert.deepEqual(searchArgs.sourceIds, ["source-alpha", "tender-alpha", "source-alpha-old"]);
});

test("runDifyRetrieval rejects empty queries and missing explicit sources", async () => {
  const empty = await runDifyRetrieval({
    body: { query: "" },
    sources,
    settings: {},
    searchChunks: async () => ({ results: [], metadata: {} })
  });
  const missing = await runDifyRetrieval({
    body: { query: "payment", sourceId: "missing" },
    sources,
    settings: {},
    searchChunks: async () => ({ results: [], metadata: {} })
  });

  assert.equal(empty.status, 400);
  assert.equal(missing.status, 404);
});

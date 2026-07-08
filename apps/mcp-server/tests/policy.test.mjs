import assert from "node:assert/strict";
import test from "node:test";

import { getIndexedFiles } from "../src/tools/get-indexed-files.js";
import { search } from "../src/tools/search.js";
import { previewCitation } from "../src/tools/preview-citation.js";

function mockApiClient(handlers = {}) {
  return {
    baseUrl: "http://127.0.0.1:8787",
    async get(path, query = {}) {
      if (handlers.get) return handlers.get(path, query);
      throw new Error(`unexpected GET ${path}`);
    }
  };
}

test("getIndexedFiles returns maskedRoot and relative paths only", async () => {
  const client = mockApiClient({
    async get(path) {
      assert.match(path, /\/api\/sources\/demo\/indexed-files$/);
      return {
        sourceId: "demo",
        sourceTitle: "Demo",
        root: "C:\\Users\\alice\\Projects\\demo",
        quality: { ok: 1, warning: 0, error: 0, unchecked: 0 },
        files: [
          {
            fileId: "f1",
            path: "C:\\Users\\alice\\Projects\\demo\\contracts\\a.pdf",
            relativePath: "contracts/a.pdf",
            title: "a.pdf",
            extension: ".pdf",
            chunks: 2,
            indexedAt: "2026-01-01T00:00:00.000Z",
            quality: { status: "ok" },
            recognition: null
          }
        ]
      };
    }
  });

  const result = await getIndexedFiles(client, { sourceId: "demo" });

  assert.equal("root" in result, false);
  assert.match(result.maskedRoot, /^demo#/);
  assert.equal(result.files.length, 1);
  assert.equal(result.files[0].relativePath, "contracts/a.pdf");
  assert.equal("path" in result.files[0], false);
});

test("search blocks includeFullText=true in Phase 1", async () => {
  const client = mockApiClient({
    async get() {
      throw new Error("API should not be called when includeFullText is blocked");
    }
  });

  await assert.rejects(
    () => search(client, { query: "договор", includeFullText: true }),
    /includeFullText=true is disabled in Phase 1/i
  );
});

test("search returns snippets without full text fields", async () => {
  const client = mockApiClient({
    async get(path, query) {
      assert.equal(query.q, "оплата");
      return {
        query: "оплата",
        results: [
          {
            id: "chunk-1",
            chunkId: "chunk-1",
            text: "Полный текст чанка, который не должен утечь целиком в Phase 1.",
            snippet: "…оплата…",
            citationLabel: "a.pdf, стр. 1",
            score: 0.91,
            sourceId: "demo",
            sourceTitle: "Demo"
          }
        ],
        metadata: { mode: "hybrid" }
      };
    }
  });

  const result = await search(client, { query: "оплата" });
  assert.equal(result.results.length, 1);
  assert.equal("text" in result.results[0], false);
  assert.ok(result.results[0].snippet);
});

test("previewCitation caps maxChars at 20000 in Phase 1", async () => {
  const longMarkdown = "x".repeat(30_000);
  const client = mockApiClient({
    async get() {
      return {
        targetMatched: true,
        sourceId: "demo",
        chunkId: "chunk-1",
        label: "a.pdf, стр. 1",
        title: "a.pdf",
        markdown: longMarkdown,
        excerpt: longMarkdown,
        focus: { found: false },
        truncated: false,
        truncatedBefore: false,
        truncatedAfter: false,
        evidenceMatched: false
      };
    }
  });

  const result = await previewCitation(client, {
    sourceId: "demo",
    chunkId: "chunk-1",
    maxChars: 50_000
  });

  assert.ok(result.markdown.length <= 20_001);
  assert.ok(result.excerpt.length <= 20_001);
  assert.equal(result.truncated, true);
});

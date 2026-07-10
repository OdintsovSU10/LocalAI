import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  findKnownSource,
  findPreviewManifestEntry,
  resolvePreviewTarget,
  resolveMarkdownCachePath,
  resolveSourceCacheDir
} from "../apps/rag-api/src/preview-access.js";

const cacheRoot = path.join(os.tmpdir(), "localai-md-cache");
const sourceId = "source-a";
const safeCacheFile = path.join(cacheRoot, sourceId, "file-a.md");
const manifest = {
  files: {
    "file-a": {
      sourceId,
      fileId: "file-a",
      path: path.join("docs", "report.pdf"),
      cacheFile: safeCacheFile
    }
  }
};

test("findKnownSource only accepts configured source ids", () => {
  const sources = [{ id: sourceId, path: "C:\\docs" }];

  assert.equal(findKnownSource(sources, sourceId)?.id, sourceId);
  assert.equal(findKnownSource(sources, "missing"), null);
});

test("findPreviewManifestEntry resolves previews through manifest metadata", () => {
  const byPath = findPreviewManifestEntry({
    manifest,
    sourceId,
    filePath: path.join("docs", "report.pdf")
  });
  const byFileId = findPreviewManifestEntry({ manifest, sourceId, fileId: "file-a" });

  assert.equal(byPath?.fileId, "file-a");
  assert.equal(byFileId?.path, path.join("docs", "report.pdf"));
});

test("findPreviewManifestEntry recovers entries with stale source ids by source path", () => {
  const staleManifest = {
    files: {
      stale: {
        sourceId: "source-old",
        fileId: "stale",
        path: "C:\\docs\\report.pdf"
      }
    }
  };
  const entry = findPreviewManifestEntry({
    manifest: staleManifest,
    source: { id: sourceId, path: "C:\\docs" },
    fileId: "stale",
    currentSourceIds: new Set([sourceId])
  });

  assert.equal(entry?.fileId, "stale");
});

test("chunk metadata wins over unsafe query path when selecting preview entry", () => {
  const entry = findPreviewManifestEntry({
    manifest,
    sourceId,
    filePath: "../secret.pdf",
    chunk: { path: path.join("docs", "report.pdf") }
  });

  assert.equal(entry?.fileId, "file-a");
});

test("path traversal and absolute query paths do not match manifest entries", () => {
  assert.equal(findPreviewManifestEntry({ manifest, sourceId, filePath: "../secret.pdf" }), null);
  assert.equal(findPreviewManifestEntry({ manifest, sourceId, filePath: "C:\\Windows\\win.ini" }), null);
  assert.equal(findPreviewManifestEntry({ manifest, sourceId, filePath: "%2e%2e%2fsecret.pdf" }), null);
  assert.equal(findPreviewManifestEntry({ manifest, sourceId, fileId: "../file-a" }), null);
});

test("resolvePreviewTarget returns exact chunk by sourceId and chunkId", async () => {
  const chunk = {
    id: "chunk-a",
    sourceId,
    fileId: "file-a",
    path: path.join("docs", "report.pdf"),
    text: "exact evidence"
  };

  const result = await resolvePreviewTarget({
    source: { id: sourceId },
    manifest,
    chunkId: chunk.id,
    findChunkById: async (id, knownSourceId) => (
      id === chunk.id && knownSourceId === sourceId ? chunk : null
    )
  });

  assert.equal(result.status, 200);
  assert.equal(result.targetMatched, true);
  assert.equal(result.chunk?.id, "chunk-a");
  assert.equal(result.entry?.fileId, "file-a");
});

test("resolvePreviewTarget reports wrong chunkId and supports legacy fallback", async () => {
  const missing = await resolvePreviewTarget({
    source: { id: sourceId },
    manifest,
    chunkId: "missing",
    findChunkById: async () => null
  });
  assert.equal(missing.status, 404);
  assert.equal(missing.error, "chunk not found");
  assert.equal(missing.targetMatched, false);

  const legacy = await resolvePreviewTarget({
    source: { id: sourceId },
    manifest,
    filePath: path.join("docs", "report.pdf")
  });
  assert.equal(legacy.status, 200);
  assert.equal(legacy.targetMatched, false);
  assert.equal(legacy.fallbackReason, "legacy file preview");
});

test("resolveSourceCacheDir rejects traversal source ids", () => {
  assert.equal(resolveSourceCacheDir(cacheRoot, sourceId), path.resolve(cacheRoot, sourceId));

  assert.throws(() => resolveSourceCacheDir(cacheRoot, "../source-a"), /Unsafe source cache id/);
  assert.throws(() => resolveSourceCacheDir(cacheRoot, "source-a/../source-b"), /Unsafe source cache id/);
  assert.throws(() => resolveSourceCacheDir(cacheRoot, "%2e%2e%2fsource-a"), /Unsafe source cache id/);
});

test("resolveMarkdownCachePath accepts only files inside the source markdown cache", () => {
  assert.equal(resolveMarkdownCachePath(cacheRoot, sourceId, safeCacheFile), path.resolve(safeCacheFile));
  assert.equal(resolveMarkdownCachePath(cacheRoot, sourceId, "file-a.md"), path.resolve(cacheRoot, sourceId, "file-a.md"));

  assert.throws(() => resolveMarkdownCachePath(cacheRoot, sourceId, "../secret.md"), /Unsafe markdown cache path/);
  assert.throws(
    () => resolveMarkdownCachePath(cacheRoot, sourceId, path.resolve(cacheRoot, "other-source", "file-a.md")),
    /Unsafe markdown cache path/
  );
  assert.throws(() => resolveMarkdownCachePath(cacheRoot, sourceId, "%2e%2e%2fsecret.md"), /Unsafe markdown cache path/);
});

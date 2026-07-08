import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const envKeys = [
  "RAG_DATA_DIR",
  "RAG_METADATA_PROVIDER",
  "RAG_METADATA_SQLITE_PATH",
  "RAG_METADATA_SQLITE_FALLBACK_JSON",
  "RAG_EMBEDDINGS_ENABLED",
  "RAG_VECTOR_STORE_ENABLED",
  "RAG_RERANKER_ENABLED"
];

function snapshotEnv() {
  return Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
}

function restoreEnv(snapshot) {
  for (const key of envKeys) {
    if (snapshot[key] === undefined) delete process.env[key];
    else process.env[key] = snapshot[key];
  }
}

async function withTempStorage(t, provider = "sqlite") {
  const previous = snapshotEnv();
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "localai-rag-test-"));
  const dataDir = path.join(root, "data");
  process.env.RAG_DATA_DIR = dataDir;
  process.env.RAG_METADATA_PROVIDER = provider;
  process.env.RAG_METADATA_SQLITE_PATH = path.join(dataDir, "state", "metadata.sqlite");
  process.env.RAG_METADATA_SQLITE_FALLBACK_JSON = "false";
  process.env.RAG_EMBEDDINGS_ENABLED = "false";
  process.env.RAG_VECTOR_STORE_ENABLED = "false";
  process.env.RAG_RERANKER_ENABLED = "false";
  t.after(async () => {
    restoreEnv(previous);
    await fs.rm(root, { recursive: true, force: true });
  });
  return { root, dataDir };
}

test("index synthetic markdown file writes files and chunks to sqlite", async (t) => {
  const { root, dataDir } = await withTempStorage(t, "sqlite");
  const sourceDir = path.join(root, "source");
  await fs.mkdir(sourceDir, { recursive: true });
  await fs.writeFile(
    path.join(sourceDir, "contract.md"),
    [
      "# Договор поставки",
      "",
      "Цена договора составляет 123 456 рублей.",
      "Срок оплаты составляет 30 дней после подписания акта.",
      "Гарантийное удержание не применяется."
    ].join("\n"),
    "utf8"
  );

  const [{ indexSource }, { readChunks, readManifest }] = await Promise.all([
    import("../apps/rag-api/src/indexer.js"),
    import("../apps/rag-api/src/store.js")
  ]);

  const result = await indexSource({
    id: "source-sqlite-index",
    title: "SQLite Test Source",
    path: sourceDir,
    include: ["**/*.md"],
    exclude: []
  });

  const [manifest, chunks] = await Promise.all([readManifest(), readChunks()]);
  assert.equal(result.indexedFiles, 1);
  assert.ok(Object.keys(manifest.files).some((fileId) => fileId && manifest.files[fileId].path.endsWith("contract.md")));
  assert.ok(chunks.some((chunk) => chunk.sourceId === "source-sqlite-index" && chunk.path.endsWith("contract.md")));
  await fs.access(path.join(dataDir, "state", "metadata.sqlite"));
});

test("indexSource writes public Google Sheet context as virtual chunks", async (t) => {
  const { root } = await withTempStorage(t, "json");
  const sourceDir = path.join(root, "source-google");
  await fs.mkdir(sourceDir, { recursive: true });

  const [{ indexSource }, { readChunks, readManifest }] = await Promise.all([
    import("../apps/rag-api/src/indexer.js"),
    import("../apps/rag-api/src/store.js")
  ]);

  const csv = "Вопрос,Ответ\nЦена договора,12345 рублей\nСрок оплаты,10 дней";
  const result = await indexSource({
    id: "source-google-context",
    title: "Google Context Source",
    path: sourceDir,
    include: ["**/*.md"],
    exclude: [],
    contextLinks: [{
      id: "ctx-sheet",
      title: "Форма Вопрос-ответ",
      url: "https://docs.google.com/spreadsheets/d/sheet-id/edit?gid=42#gid=42",
      kind: "sheet"
    }]
  }, () => {}, {
    googleContextFetch: async () => {
      const buffer = new TextEncoder().encode(csv).buffer;
      return {
        ok: true,
        status: 200,
        headers: {
          get(name) {
            const key = String(name || "").toLowerCase();
            if (key === "content-type") return "text/csv; charset=utf-8";
            if (key === "content-length") return String(buffer.byteLength);
            return "";
          }
        },
        arrayBuffer: async () => buffer
      };
    }
  });

  const [manifest, chunks] = await Promise.all([readManifest(), readChunks()]);
  const googleEntries = Object.values(manifest.files || {}).filter((entry) => entry.origin === "google-context");
  const googleChunks = chunks.filter((chunk) => chunk.sourceId === "source-google-context" && chunk.origin === "google-context");

  assert.equal(result.googleContextLinks, 1);
  assert.equal(result.indexedFiles, 1);
  assert.equal(googleEntries.length, 1);
  assert.equal(googleEntries[0].title, "Форма Вопрос-ответ");
  assert.match(googleEntries[0].relativePath, /^Google context\//);
  assert.doesNotMatch(googleEntries[0].path, /docs\.google\.com/);
  assert.equal(googleChunks.length > 0, true);
  assert.match(googleChunks[0].text, /Цена договора/);
  assert.equal(googleChunks[0].contextLinkId, "ctx-sheet");
});

test("indexSource writes public Google Drive text file as virtual chunks", async (t) => {
  const { root } = await withTempStorage(t, "json");
  const sourceDir = path.join(root, "source-drive");
  await fs.mkdir(sourceDir, { recursive: true });

  const [{ indexSource }, { readChunks, readManifest }] = await Promise.all([
    import("../apps/rag-api/src/indexer.js"),
    import("../apps/rag-api/src/store.js")
  ]);

  const text = "Drive note says project budget is approved and payment deadline is 10 days.";
  await indexSource({
    id: "source-google-drive-context",
    title: "Google Drive Source",
    path: sourceDir,
    include: ["**/*.md"],
    exclude: [],
    contextLinks: [{
      id: "ctx-drive",
      title: "Drive notes",
      url: "https://drive.google.com/file/d/file-id/view",
      kind: "link"
    }]
  }, () => {}, {
    googleContextFetch: async () => {
      const buffer = new TextEncoder().encode(text).buffer;
      return {
        ok: true,
        status: 200,
        headers: {
          get(name) {
            const key = String(name || "").toLowerCase();
            if (key === "content-type") return "text/plain; charset=utf-8";
            if (key === "content-length") return String(buffer.byteLength);
            if (key === "content-disposition") return "attachment; filename=\"drive-notes.txt\"";
            return "";
          }
        },
        arrayBuffer: async () => buffer
      };
    }
  });

  const [manifest, chunks] = await Promise.all([readManifest(), readChunks()]);
  const googleEntries = Object.values(manifest.files || {}).filter((entry) => entry.sourceId === "source-google-drive-context");
  const googleChunks = chunks.filter((chunk) => chunk.sourceId === "source-google-drive-context");

  assert.equal(googleEntries.length, 1);
  assert.equal(googleEntries[0].origin, "google-context");
  assert.equal(googleEntries[0].extension, ".txt");
  assert.match(googleEntries[0].recognition.method, /^google-drive-/);
  assert.equal(googleChunks.length > 0, true);
  assert.match(googleChunks[0].text, /payment deadline/);
  assert.equal(googleChunks[0].contextLinkId, "ctx-drive");
});

test("search reads sqlite chunks when sqlite metadata provider is enabled", async (t) => {
  await withTempStorage(t, "sqlite");
  const [{ writeChunks }, { searchChunksWithMetadata }] = await Promise.all([
    import("../apps/rag-api/src/store.js"),
    import("../apps/rag-api/src/search.js")
  ]);

  await writeChunks([
    {
      id: "sqlite-chunk-1",
      fileId: "sqlite-file-1",
      sourceId: "source-sqlite-search",
      sourceTitle: "SQLite Search",
      title: "sqlite-contract.md",
      path: "sqlite-contract.md",
      chunkIndex: 0,
      text: "Оплата по договору производится в течение 45 дней.",
      terms: ["оплата", "договору", "производится", "течение", "45", "дней"],
      metadata: { documentType: "md", sectionTitle: "Оплата" }
    },
    {
      id: "sqlite-chunk-2",
      fileId: "sqlite-file-2",
      sourceId: "source-sqlite-search",
      sourceTitle: "SQLite Search",
      title: "other.md",
      path: "other.md",
      chunkIndex: 0,
      text: "Общее описание проекта без условий оплаты.",
      terms: ["общее", "описание", "проекта", "условий", "оплаты"],
      metadata: { documentType: "md" }
    }
  ]);

  const { results } = await searchChunksWithMetadata({
    query: "срок оплаты 45 дней",
    sourceId: "source-sqlite-search",
    limit: 5
  });

  assert.equal(results[0]?.id, "sqlite-chunk-1");
  assert.equal(results[0]?.chunkId, "sqlite-chunk-1");
  assert.equal(results[0]?.fileId, "sqlite-file-1");
  assert.equal(results[0]?.citationTarget?.chunkId, "sqlite-chunk-1");
  assert.equal(results[0]?.citationTarget?.fileId, "sqlite-file-1");
  assert.match(results[0]?.citationTarget?.label || "", /sqlite-contract\.md/);
});

test("json metadata provider still writes and searches chunks json", async (t) => {
  await withTempStorage(t, "json");
  const [{ chunksPath }, { writeChunks }, { searchChunksWithMetadata }] = await Promise.all([
    import("../apps/rag-api/src/paths.js"),
    import("../apps/rag-api/src/store.js"),
    import("../apps/rag-api/src/search.js")
  ]);

  await writeChunks([
    {
      id: "json-chunk-1",
      fileId: "json-file-1",
      sourceId: "source-json-search",
      sourceTitle: "JSON Search",
      title: "json-contract.md",
      path: "json-contract.md",
      chunkIndex: 0,
      text: "Цена договора составляет 987 654 рубля.",
      terms: ["цена", "договора", "составляет", "987", "654", "рубля"],
      metadata: { documentType: "md" }
    }
  ]);

  await fs.access(chunksPath());
  const { results } = await searchChunksWithMetadata({
    query: "цена договора 987",
    sourceId: "source-json-search",
    limit: 5
  });

  assert.equal(results[0]?.id, "json-chunk-1");
  assert.equal(results[0]?.chunkId, "json-chunk-1");
  assert.equal(results[0]?.fileId, "json-file-1");
  assert.equal(results[0]?.citationTarget?.chunkId, "json-chunk-1");
  assert.equal(results[0]?.citationTarget?.fileId, "json-file-1");
});

test("search without sourceId covers chunks from all sources", async (t) => {
  await withTempStorage(t, "json");
  const [{ writeChunks }, { searchChunksWithMetadata }] = await Promise.all([
    import("../apps/rag-api/src/store.js"),
    import("../apps/rag-api/src/search.js")
  ]);

  await writeChunks([
    {
      id: "all-source-chunk-a",
      fileId: "all-file-a",
      sourceId: "source-a",
      sourceTitle: "Source A",
      title: "contract-a.md",
      path: "contract-a.md",
      chunkIndex: 0,
      text: "Contract email alpha@example.test is listed for notices.",
      terms: ["contract", "email", "alpha", "example", "test", "listed", "notices"],
      metadata: { documentType: "md" }
    },
    {
      id: "all-source-chunk-b",
      fileId: "all-file-b",
      sourceId: "source-b",
      sourceTitle: "Source B",
      title: "contract-b.md",
      path: "contract-b.md",
      chunkIndex: 0,
      text: "Contract email beta@example.test is listed for notices.",
      terms: ["contract", "email", "beta", "example", "test", "listed", "notices"],
      metadata: { documentType: "md" }
    }
  ]);

  const { results, metadata } = await searchChunksWithMetadata({
    query: "contract email",
    limit: 5
  });

  assert.deepEqual(new Set(results.map((result) => result.sourceId)), new Set(["source-a", "source-b"]));
  assert.equal(metadata.lexicalCandidateCount, 2);
});

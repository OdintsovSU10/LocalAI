import fs from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";
import "dotenv/config";
import {
  agentRunsPath,
  chunksPath,
  configPath,
  dataDir,
  defaultDataDir,
  jobsPath,
  manifestPath,
  markdownCacheDir,
  metadataSqlitePath,
  settingsPath,
  sourceSummariesPath,
  stateDir,
  vectorsPath
} from "./paths.js";

const writeQueues = new Map();

export const defaultLlmSettings = {
  enabled: true,
  provider: "local",
  baseUrl: "http://127.0.0.1:1234/v1",
  apiKey: "lm-studio",
  model: "qwen2.5-7b-instruct",
  temperature: 0.1,
  maxTokens: 700,
  timeoutSeconds: 120,
  fallbackToLocalOnRemoteError: false,
  remote: {
    enabled: false,
    runtime: "lmstudio",
    baseUrl: "https://example-lm-studio/v1",
    apiKey: "",
    model: "qwen3.6-27b-mtp",
    timeoutSeconds: 300
  }
};

export const defaultEmbeddingSettings = {
  enabled: true,
  baseUrl: "http://127.0.0.1:1234/v1",
  apiKey: "lm-studio",
  model: "text-embedding-bge-m3",
  batchSize: 16,
  timeoutSeconds: 120
};

export const defaultVectorStoreSettings = {
  enabled: true,
  provider: "auto",
  qdrant: {
    url: "http://127.0.0.1:6333",
    apiKey: "",
    collection: "localai_chunks",
    distance: "Cosine",
    timeoutSeconds: 10,
    batchSize: 128
  }
};

export const defaultRerankerSettings = {
  enabled: false,
  baseUrl: "",
  apiKey: "",
  model: "jina-reranker-v2-base-multilingual",
  candidateCount: 30,
  maxChars: 4000,
  timeoutSeconds: 30
};

export const defaultSearchSettings = {
  lexicalMode: "bm25",
  vectorCandidates: 200,
  lexicalCandidates: 200,
  finalCandidates: 60,
  rerankCandidates: 30
};

export const defaultStorageSettings = {
  metadataProvider: "json",
  sqlite: {
    databasePath: "",
    fallbackToJson: false
  }
};

export async function ensureStorage() {
  await fs.mkdir(path.dirname(configPath), { recursive: true });
  await ensureJson(settingsPath, {
    dataDir: defaultDataDir(),
    llm: defaultLlmSettings,
    embeddings: defaultEmbeddingSettings,
    vectorStore: defaultVectorStoreSettings,
    reranker: defaultRerankerSettings,
    storage: defaultStorageSettings,
    search: defaultSearchSettings
  });
  await fs.mkdir(stateDir(), { recursive: true });
  await fs.mkdir(markdownCacheDir(), { recursive: true });
  await ensureJson(manifestPath(), { files: {} });
  await ensureJson(chunksPath(), []);
  await ensureJson(sourceSummariesPath(), { summaries: {} });
  await ensureJson(vectorsPath(), { version: 1, items: {} });
  await ensureJson(jobsPath(), {});
  await ensureJson(agentRunsPath(), {});
  try {
    await fs.access(configPath);
  } catch {
    await fs.writeFile(configPath, "sources: []\n", "utf8");
  }
}

async function ensureJson(filePath, fallback) {
  try {
    await fs.access(filePath);
  } catch {
    await fs.writeFile(filePath, JSON.stringify(fallback, null, 2), "utf8");
  }
}

export async function readJson(filePath, fallback) {
  try {
    const text = await fs.readFile(filePath, "utf8");
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

async function metadataStorageSettings() {
  const settings = await readSettings();
  return settings.storage || defaultStorageSettings;
}

async function withMetadataProvider(operation, jsonOperation) {
  const storage = await metadataStorageSettings();
  if (storage.metadataProvider !== "sqlite") return jsonOperation();

  try {
    const sqlite = await import("./sqlite-metadata-store.js");
    return await operation(sqlite, storage);
  } catch (error) {
    if (storage.sqlite?.fallbackToJson) return jsonOperation();
    throw new Error(`SQLite metadata provider is unavailable: ${error.message}`);
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableFsError(error) {
  return ["EACCES", "EBUSY", "EPERM"].includes(error?.code);
}

async function replaceFileWithRetry(tmp, filePath) {
  let lastError;
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      await fs.rename(tmp, filePath);
      return;
    } catch (error) {
      lastError = error;
      if (!isRetryableFsError(error)) throw error;
      await sleep(40 * (attempt + 1));
    }
  }

  // Windows can briefly lock the destination. The fallback is not fully atomic,
  // but it is safer for app state than failing the whole indexing job.
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      await fs.copyFile(tmp, filePath);
      await fs.rm(tmp, { force: true });
      return;
    } catch (error) {
      lastError = error;
      if (!isRetryableFsError(error)) throw error;
      await sleep(80 * (attempt + 1));
    }
  }

  throw lastError;
}

async function writeJsonAtomicNow(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
  try {
    await fs.writeFile(tmp, JSON.stringify(value, null, 2), "utf8");
    await replaceFileWithRetry(tmp, filePath);
  } catch (error) {
    await fs.rm(tmp, { force: true }).catch(() => {});
    throw error;
  }
}

async function writeJsonArrayAtomicNow(filePath, values = []) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
  let handle = null;

  try {
    handle = await fs.open(tmp, "w");
    await handle.writeFile("[\n", "utf8");

    for (let index = 0; index < values.length; index += 1) {
      if (index > 0) await handle.writeFile(",\n", "utf8");
      const item = (JSON.stringify(values[index], null, 2) ?? "null")
        .split("\n")
        .map((line) => `  ${line}`)
        .join("\n");
      await handle.writeFile(item, "utf8");
    }

    await handle.writeFile("\n]\n", "utf8");
    await handle.close();
    handle = null;
    await replaceFileWithRetry(tmp, filePath);
  } catch (error) {
    await handle?.close().catch(() => {});
    await fs.rm(tmp, { force: true }).catch(() => {});
    throw error;
  }
}

export async function writeJsonAtomic(filePath, value) {
  const previous = writeQueues.get(filePath) || Promise.resolve();
  const current = previous.catch(() => {}).then(() => writeJsonAtomicNow(filePath, value));
  writeQueues.set(filePath, current);

  try {
    await current;
  } finally {
    if (writeQueues.get(filePath) === current) writeQueues.delete(filePath);
  }
}

async function writeJsonArrayAtomic(filePath, values) {
  const previous = writeQueues.get(filePath) || Promise.resolve();
  const current = previous.catch(() => {}).then(() => writeJsonArrayAtomicNow(filePath, values));
  writeQueues.set(filePath, current);

  try {
    await current;
  } finally {
    if (writeQueues.get(filePath) === current) writeQueues.delete(filePath);
  }
}

export async function readSources() {
  await ensureStorage();
  const text = await fs.readFile(configPath, "utf8");
  const parsed = YAML.parse(text) || {};
  return Array.isArray(parsed.sources) ? parsed.sources : [];
}

export async function writeSources(sources) {
  const text = YAML.stringify({ sources });
  await fs.writeFile(configPath, text, "utf8");
}

export async function readManifest() {
  return withMetadataProvider(
    (sqlite, storage) => sqlite.readManifestFromSqlite(storage),
    () => readJson(manifestPath(), { files: {} })
  );
}

export async function writeManifest(manifest) {
  return withMetadataProvider(
    (sqlite, storage) => sqlite.writeManifestToSqlite(manifest, storage),
    () => writeJsonAtomic(manifestPath(), manifest)
  );
}

export async function readChunks() {
  return withMetadataProvider(
    (sqlite, storage) => sqlite.readChunksFromSqlite(storage),
    () => readJson(chunksPath(), [])
  );
}

export async function writeChunks(chunks) {
  return withMetadataProvider(
    (sqlite, storage) => sqlite.writeChunksToSqlite(chunks, storage),
    () => writeJsonArrayAtomic(chunksPath(), chunks)
  );
}

export async function readSourceSummaries() {
  return withMetadataProvider(
    (sqlite, storage) => sqlite.readSourceSummariesFromSqlite(storage),
    () => readSourceSummariesJson()
  );
}

export async function readSourceSummariesJson(filePath = sourceSummariesPath()) {
  return readJson(filePath, { summaries: {} });
}

export async function writeSourceSummaries(sourceSummaries) {
  return withMetadataProvider(
    (sqlite, storage) => sqlite.writeSourceSummariesToSqlite(sourceSummaries, storage),
    () => writeSourceSummariesJson(sourceSummaries)
  );
}

export async function writeSourceSummariesJson(sourceSummaries, filePath = sourceSummariesPath()) {
  const next = { summaries: sourceSummaries?.summaries || {} };
  await writeJsonAtomic(filePath, next);
  return next;
}

export async function readSourceSummary(sourceId) {
  const sourceSummaries = await readSourceSummaries();
  return sourceSummaries.summaries?.[sourceId] || null;
}

export async function readSourceSummaryJson(sourceId, filePath = sourceSummariesPath()) {
  const sourceSummaries = await readSourceSummariesJson(filePath);
  return sourceSummaries.summaries?.[sourceId] || null;
}

export async function writeSourceSummary(summary) {
  if (!summary?.sourceId) return null;
  return withMetadataProvider(
    (sqlite, storage) => sqlite.writeSourceSummaryToSqlite(summary, storage),
    () => writeSourceSummaryJson(summary)
  );
}

export async function writeSourceSummaryJson(summary, filePath = sourceSummariesPath()) {
  if (!summary?.sourceId) return null;
  const sourceSummaries = await readSourceSummariesJson(filePath);
  const next = {
    summaries: {
      ...(sourceSummaries.summaries || {}),
      [summary.sourceId]: summary
    }
  };
  await writeJsonAtomic(filePath, next);
  return summary;
}

export async function migrateJsonMetadataToSqlite(options = {}) {
  const settings = await readSettings();
  const storage = {
    ...(settings.storage || defaultStorageSettings),
    metadataProvider: "sqlite"
  };
  const [manifest, chunks] = await Promise.all([
    readJson(manifestPath(), { files: {} }),
    readJson(chunksPath(), [])
  ]);
  const sqlite = await import("./sqlite-metadata-store.js");
  return sqlite.migrateJsonMetadataToSqlite({
    manifest,
    chunks,
    storage,
    overwrite: options.overwrite !== false
  });
}

export async function readVectors() {
  return readJson(vectorsPath(), { version: 1, items: {} });
}

export async function writeVectors(vectors) {
  await writeJsonAtomic(vectorsPath(), { version: 1, items: vectors.items || {} });
}

export async function readJobs() {
  return readJson(jobsPath(), {});
}

export async function writeJobs(jobs) {
  await writeJsonAtomic(jobsPath(), jobs);
}

export async function readAgentRuns() {
  return readJson(agentRunsPath(), {});
}

export async function writeAgentRuns(runs) {
  await writeJsonAtomic(agentRunsPath(), runs);
}

function normalizeLlmProvider(provider) {
  const value = String(provider || "").trim().toLowerCase();
  if (value === "auto") return value;
  if (value === "remote" || value === "token") return "remote";
  return "local";
}

function normalizeRemoteRuntime(runtime) {
  const value = String(runtime || "").trim().toLowerCase();
  if (["openai", "openai-compatible", "openai_compatible", "vllm", "sglang", "llama.cpp", "llamacpp"].includes(value)) {
    return "openai-compatible";
  }
  return "lmstudio";
}

function envString(...names) {
  for (const name of names) {
    const value = process.env[name];
    if (value !== undefined && String(value).trim() !== "") return String(value).trim();
  }
  return "";
}

function envBoolean(...names) {
  const value = envString(...names);
  if (!value) return null;
  if (["1", "true", "yes", "on"].includes(value.toLowerCase())) return true;
  if (["0", "false", "no", "off"].includes(value.toLowerCase())) return false;
  return null;
}

function envNumber(fallback, ...names) {
  const raw = envString(...names);
  if (!raw) return fallback;
  const value = Number(raw);
  return Number.isFinite(value) ? value : fallback;
}

function normalizeMetadataProvider(provider) {
  const value = String(provider || defaultStorageSettings.metadataProvider).trim().toLowerCase();
  return value === "sqlite" ? "sqlite" : "json";
}

function normalizeStoredStorageSettings(storage = {}) {
  const sqlite = {
    ...defaultStorageSettings.sqlite,
    ...(storage.sqlite || {})
  };
  return {
    ...defaultStorageSettings,
    ...(storage || {}),
    metadataProvider: normalizeMetadataProvider(storage.metadataProvider),
    sqlite: {
      ...sqlite,
      databasePath: String(sqlite.databasePath || "").trim(),
      fallbackToJson: Boolean(sqlite.fallbackToJson)
    }
  };
}

function applyStorageEnvOverrides(storage) {
  const sqlite = storage.sqlite || {};
  return normalizeStoredStorageSettings({
    ...storage,
    metadataProvider: envString("RAG_METADATA_PROVIDER", "RAG_STORAGE_METADATA_PROVIDER") || storage.metadataProvider,
    sqlite: {
      ...sqlite,
      databasePath: envString("RAG_METADATA_SQLITE_PATH", "RAG_STORAGE_SQLITE_PATH") || sqlite.databasePath,
      fallbackToJson: envBoolean("RAG_METADATA_SQLITE_FALLBACK_JSON", "RAG_STORAGE_SQLITE_FALLBACK_JSON") ?? sqlite.fallbackToJson
    }
  });
}

function normalizeStoredLlmSettings(llm = {}) {
  const remote = {
    ...defaultLlmSettings.remote,
    ...(llm.remote || {})
  };
  const allowRemoteContext = Boolean(llm.allowRemoteContext ?? remote.enabled);
  return {
    ...defaultLlmSettings,
    ...llm,
    provider: normalizeLlmProvider(llm.provider),
    fallbackToLocalOnRemoteError: Boolean(llm.fallbackToLocalOnRemoteError),
    allowRemoteContext,
    baseUrl: String(llm.baseUrl || defaultLlmSettings.baseUrl).trim().replace(/\/$/, ""),
    apiKey: String(llm.apiKey || defaultLlmSettings.apiKey),
    model: String(llm.model || "").trim(),
    temperature: Number.isFinite(Number(llm.temperature)) ? Number(llm.temperature) : defaultLlmSettings.temperature,
    maxTokens: Math.max(100, Number(llm.maxTokens || defaultLlmSettings.maxTokens)),
    timeoutSeconds: Math.max(10, Number(llm.timeoutSeconds || defaultLlmSettings.timeoutSeconds)),
    remote: {
      ...defaultLlmSettings.remote,
      ...remote,
      enabled: allowRemoteContext,
      runtime: normalizeRemoteRuntime(remote.runtime),
      baseUrl: String(remote.baseUrl || defaultLlmSettings.remote.baseUrl).trim().replace(/\/$/, ""),
      apiKey: String(remote.apiKey || defaultLlmSettings.remote.apiKey || ""),
      model: String(remote.model || defaultLlmSettings.remote.model || "").trim(),
      timeoutSeconds: Math.max(defaultLlmSettings.remote.timeoutSeconds, Number(remote.timeoutSeconds || defaultLlmSettings.remote.timeoutSeconds))
    }
  };
}

function applyLlmEnvOverrides(llm) {
  const remote = llm.remote || {};
  return {
    ...llm,
    enabled: envBoolean("RAG_LLM_ENABLED") ?? llm.enabled,
    provider: envString("RAG_LLM_PROVIDER") || llm.provider,
    fallbackToLocalOnRemoteError: envBoolean("RAG_LLM_FALLBACK_TO_LOCAL_ON_REMOTE_ERROR") ?? llm.fallbackToLocalOnRemoteError,
    allowRemoteContext: envBoolean("RAG_ALLOW_REMOTE_CONTEXT", "RAG_REMOTE_LLM_ENABLED") ?? llm.allowRemoteContext,
    baseUrl: envString("RAG_LLM_BASE_URL", "LOCAL_LMSTUDIO_BASE_URL") || llm.baseUrl,
    apiKey: envString("RAG_LLM_API_KEY", "LOCAL_LMSTUDIO_API_KEY") || llm.apiKey,
    model: envString("RAG_LLM_MODEL", "LOCAL_LMSTUDIO_MODEL") || llm.model,
    remote: {
      ...remote,
      enabled: envBoolean("RAG_REMOTE_LLM_ENABLED", "RAG_ALLOW_REMOTE_CONTEXT") ?? remote.enabled,
      runtime: envString("RAG_REMOTE_LLM_RUNTIME", "RAG_REMOTE_RUNTIME") || remote.runtime,
      baseUrl: envString("RAG_REMOTE_LLM_BASE_URL", "LMSTUDIO_BASE_URL", "OPENAI_BASE_URL") || remote.baseUrl,
      apiKey: envString("RAG_REMOTE_LLM_API_KEY", "LMSTUDIO_API_KEY", "OPENAI_API_KEY") || remote.apiKey,
      model: envString("RAG_REMOTE_LLM_MODEL", "QWEN_MODEL", "OPENAI_MODEL") || remote.model,
      timeoutSeconds: envNumber(remote.timeoutSeconds, "RAG_REMOTE_LLM_TIMEOUT_SECONDS")
    }
  };
}

function normalizeStoredEmbeddingSettings(embeddings = {}) {
  return {
    ...defaultEmbeddingSettings,
    ...(embeddings || {}),
    enabled: embeddings.enabled === undefined ? defaultEmbeddingSettings.enabled : Boolean(embeddings.enabled),
    baseUrl: String(embeddings.baseUrl || defaultEmbeddingSettings.baseUrl).trim().replace(/\/$/, ""),
    apiKey: String(embeddings.apiKey || defaultEmbeddingSettings.apiKey),
    model: String(embeddings.model || defaultEmbeddingSettings.model).trim(),
    batchSize: Math.min(64, Math.max(1, Number(embeddings.batchSize || defaultEmbeddingSettings.batchSize))),
    timeoutSeconds: Math.max(10, Number(embeddings.timeoutSeconds || defaultEmbeddingSettings.timeoutSeconds))
  };
}

function applyEmbeddingEnvOverrides(embeddings) {
  return {
    ...embeddings,
    enabled: envBoolean("RAG_EMBEDDINGS_ENABLED", "RAG_EMBEDDING_ENABLED") ?? embeddings.enabled,
    baseUrl: envString("RAG_EMBEDDINGS_BASE_URL", "RAG_EMBEDDING_BASE_URL") || embeddings.baseUrl,
    apiKey: envString("RAG_EMBEDDINGS_API_KEY", "RAG_EMBEDDING_API_KEY") || embeddings.apiKey,
    model: envString("RAG_EMBEDDINGS_MODEL", "RAG_EMBEDDING_MODEL") || embeddings.model,
    batchSize: Math.min(64, Math.max(1, envNumber(embeddings.batchSize, "RAG_EMBEDDINGS_BATCH_SIZE", "RAG_EMBEDDING_BATCH_SIZE"))),
    timeoutSeconds: Math.max(10, envNumber(embeddings.timeoutSeconds, "RAG_EMBEDDINGS_TIMEOUT_SECONDS", "RAG_EMBEDDING_TIMEOUT_SECONDS"))
  };
}

function normalizeVectorStoreProvider(provider) {
  const value = String(provider || "").trim().toLowerCase();
  if (["auto", "qdrant", "json"].includes(value)) return value;
  return defaultVectorStoreSettings.provider;
}

function normalizeVectorDistance(distance) {
  const value = String(distance || defaultVectorStoreSettings.qdrant.distance).trim();
  return ["Cosine", "Euclid", "Dot", "Manhattan"].includes(value) ? value : defaultVectorStoreSettings.qdrant.distance;
}

function normalizeStoredVectorStoreSettings(vectorStore = {}) {
  const qdrant = {
    ...defaultVectorStoreSettings.qdrant,
    ...(vectorStore.qdrant || {})
  };

  return {
    ...defaultVectorStoreSettings,
    ...(vectorStore || {}),
    enabled: vectorStore.enabled === undefined ? defaultVectorStoreSettings.enabled : Boolean(vectorStore.enabled),
    provider: normalizeVectorStoreProvider(vectorStore.provider),
    qdrant: {
      ...qdrant,
      url: String(qdrant.url || defaultVectorStoreSettings.qdrant.url).trim().replace(/\/$/, ""),
      apiKey: String(qdrant.apiKey || ""),
      collection: String(qdrant.collection || defaultVectorStoreSettings.qdrant.collection).trim(),
      distance: normalizeVectorDistance(qdrant.distance),
      timeoutSeconds: Math.max(2, Number(qdrant.timeoutSeconds || defaultVectorStoreSettings.qdrant.timeoutSeconds)),
      batchSize: Math.min(512, Math.max(16, Number(qdrant.batchSize || defaultVectorStoreSettings.qdrant.batchSize)))
    }
  };
}

function applyVectorStoreEnvOverrides(vectorStore) {
  const qdrant = vectorStore.qdrant || {};
  return {
    ...vectorStore,
    enabled: envBoolean("RAG_VECTOR_STORE_ENABLED", "QDRANT_ENABLED") ?? vectorStore.enabled,
    provider: normalizeVectorStoreProvider(envString("RAG_VECTOR_STORE_PROVIDER", "RAG_VECTOR_STORE") || vectorStore.provider),
    qdrant: {
      ...qdrant,
      url: envString("QDRANT_URL", "RAG_QDRANT_URL") || qdrant.url,
      apiKey: envString("QDRANT_API_KEY", "RAG_QDRANT_API_KEY") || qdrant.apiKey,
      collection: envString("QDRANT_COLLECTION", "RAG_QDRANT_COLLECTION") || qdrant.collection,
      timeoutSeconds: Math.max(2, envNumber(qdrant.timeoutSeconds, "QDRANT_TIMEOUT_SECONDS", "RAG_QDRANT_TIMEOUT_SECONDS")),
      batchSize: Math.min(512, Math.max(16, envNumber(qdrant.batchSize, "QDRANT_BATCH_SIZE", "RAG_QDRANT_BATCH_SIZE")))
    }
  };
}

function normalizeStoredRerankerSettings(reranker = {}) {
  return {
    ...defaultRerankerSettings,
    ...(reranker || {}),
    enabled: reranker.enabled === undefined ? defaultRerankerSettings.enabled : Boolean(reranker.enabled),
    baseUrl: String(reranker.baseUrl || "").trim().replace(/\/$/, ""),
    apiKey: String(reranker.apiKey || ""),
    model: String(reranker.model || defaultRerankerSettings.model).trim(),
    candidateCount: Math.min(100, Math.max(1, Number(reranker.candidateCount || defaultRerankerSettings.candidateCount))),
    maxChars: Math.min(20000, Math.max(200, Number(reranker.maxChars || defaultRerankerSettings.maxChars))),
    timeoutSeconds: Math.min(300, Math.max(2, Number(reranker.timeoutSeconds || defaultRerankerSettings.timeoutSeconds)))
  };
}

function applyRerankerEnvOverrides(reranker) {
  return {
    ...reranker,
    enabled: envBoolean("RAG_RERANKER_ENABLED") ?? reranker.enabled,
    baseUrl: envString("RAG_RERANKER_BASE_URL", "JINA_RERANKER_URL", "COHERE_RERANKER_URL") || reranker.baseUrl,
    apiKey: envString("RAG_RERANKER_API_KEY", "JINA_API_KEY", "COHERE_API_KEY") || reranker.apiKey,
    model: envString("RAG_RERANKER_MODEL", "JINA_RERANKER_MODEL", "COHERE_RERANKER_MODEL") || reranker.model,
    candidateCount: Math.min(100, Math.max(1, envNumber(reranker.candidateCount, "RAG_RERANKER_CANDIDATES"))),
    maxChars: Math.min(20000, Math.max(200, envNumber(reranker.maxChars, "RAG_RERANKER_MAX_CHARS"))),
    timeoutSeconds: Math.min(300, Math.max(2, envNumber(reranker.timeoutSeconds, "RAG_RERANKER_TIMEOUT_SECONDS")))
  };
}

function normalizeSearchLexicalMode(mode) {
  return String(mode || "").trim().toLowerCase() === "simple" ? "simple" : "bm25";
}

function normalizeStoredSearchSettings(search = {}) {
  return {
    ...defaultSearchSettings,
    ...(search || {}),
    lexicalMode: normalizeSearchLexicalMode(search.lexicalMode),
    vectorCandidates: Math.min(1000, Math.max(1, Number(search.vectorCandidates || defaultSearchSettings.vectorCandidates))),
    lexicalCandidates: Math.min(1000, Math.max(1, Number(search.lexicalCandidates || defaultSearchSettings.lexicalCandidates))),
    finalCandidates: Math.min(500, Math.max(1, Number(search.finalCandidates || defaultSearchSettings.finalCandidates))),
    rerankCandidates: Math.min(200, Math.max(1, Number(search.rerankCandidates || defaultSearchSettings.rerankCandidates)))
  };
}

export async function readSettings() {
  const settings = await readJson(settingsPath, {
    dataDir: defaultDataDir(),
    llm: defaultLlmSettings,
    embeddings: defaultEmbeddingSettings,
    vectorStore: defaultVectorStoreSettings,
    reranker: defaultRerankerSettings,
    storage: defaultStorageSettings,
    search: defaultSearchSettings
  });
  const llm = normalizeStoredLlmSettings(applyLlmEnvOverrides(normalizeStoredLlmSettings(settings.llm || {})));
  const embeddings = normalizeStoredEmbeddingSettings(applyEmbeddingEnvOverrides(normalizeStoredEmbeddingSettings(settings.embeddings || {})));
  const vectorStore = normalizeStoredVectorStoreSettings(applyVectorStoreEnvOverrides(normalizeStoredVectorStoreSettings(settings.vectorStore || {})));
  const reranker = normalizeStoredRerankerSettings(applyRerankerEnvOverrides(normalizeStoredRerankerSettings(settings.reranker || {})));
  const storage = applyStorageEnvOverrides(normalizeStoredStorageSettings(settings.storage || {}));
  const search = normalizeStoredSearchSettings(settings.search || {});

  return {
    dataDir: dataDir(),
    configuredDataDir: settings.dataDir || defaultDataDir(),
    defaultDataDir: defaultDataDir(),
    envLocked: Boolean(process.env.RAG_DATA_DIR),
    llm,
    embeddings,
    vectorStore,
    reranker,
    storage: {
      ...storage,
      sqlite: {
        ...storage.sqlite,
        effectiveDatabasePath: storage.sqlite.databasePath || metadataSqlitePath()
      }
    },
    search
  };
}

export async function writeSettings(settings) {
  const current = await readJson(settingsPath, {
    dataDir: defaultDataDir(),
    llm: defaultLlmSettings,
    embeddings: defaultEmbeddingSettings,
    vectorStore: defaultVectorStoreSettings,
    reranker: defaultRerankerSettings,
    storage: defaultStorageSettings,
    search: defaultSearchSettings
  });
  const next = {
    dataDir: current.dataDir || defaultDataDir(),
    llm: normalizeStoredLlmSettings(current.llm || {}),
    embeddings: normalizeStoredEmbeddingSettings(current.embeddings || {}),
    vectorStore: normalizeStoredVectorStoreSettings(current.vectorStore || {}),
    reranker: normalizeStoredRerankerSettings(current.reranker || {}),
    storage: normalizeStoredStorageSettings(current.storage || {}),
    search: normalizeStoredSearchSettings(current.search || {})
  };

  if (settings.dataDir !== undefined && process.env.RAG_DATA_DIR) {
    throw new Error("RAG_DATA_DIR is set in the environment, so storage path cannot be changed from UI");
  }

  if (settings.dataDir !== undefined) {
    const nextDataDir = String(settings.dataDir || "").trim();
    if (!nextDataDir) throw new Error("dataDir is required");
    if (!path.isAbsolute(nextDataDir)) throw new Error("dataDir must be an absolute path");
    await fs.mkdir(nextDataDir, { recursive: true });
    next.dataDir = path.resolve(nextDataDir);
  }

  if (settings.llm !== undefined) {
    const incoming = settings.llm || {};
    const remoteIncoming = incoming.remote || {};
    const currentRemote = next.llm.remote || defaultLlmSettings.remote;
    const allowRemoteContext = remoteIncoming.enabled === undefined
      ? (
          incoming.allowRemoteContext === undefined
            ? Boolean(next.llm.allowRemoteContext ?? currentRemote.enabled)
            : Boolean(incoming.allowRemoteContext)
        )
      : Boolean(remoteIncoming.enabled);
    next.llm = {
      ...next.llm,
      enabled: incoming.enabled === undefined ? next.llm.enabled : Boolean(incoming.enabled),
      provider: normalizeLlmProvider(incoming.provider || next.llm.provider),
      fallbackToLocalOnRemoteError: incoming.fallbackToLocalOnRemoteError === undefined
        ? Boolean(next.llm.fallbackToLocalOnRemoteError)
        : Boolean(incoming.fallbackToLocalOnRemoteError),
      allowRemoteContext,
      baseUrl: String(incoming.baseUrl || defaultLlmSettings.baseUrl).trim().replace(/\/$/, ""),
      apiKey: incoming.apiKey === undefined ? next.llm.apiKey : String(incoming.apiKey || "lm-studio"),
      model: String(incoming.model || "").trim(),
      temperature: Number.isFinite(Number(incoming.temperature)) ? Number(incoming.temperature) : defaultLlmSettings.temperature,
      maxTokens: Math.max(100, Number(incoming.maxTokens || defaultLlmSettings.maxTokens)),
      timeoutSeconds: Math.max(10, Number(incoming.timeoutSeconds || defaultLlmSettings.timeoutSeconds)),
      remote: {
        ...currentRemote,
        enabled: allowRemoteContext,
        baseUrl: remoteIncoming.baseUrl === undefined
          ? currentRemote.baseUrl
          : String(remoteIncoming.baseUrl || "").trim().replace(/\/$/, ""),
        apiKey: remoteIncoming.apiKey === undefined ? currentRemote.apiKey : String(remoteIncoming.apiKey || ""),
        model: remoteIncoming.model === undefined ? currentRemote.model : String(remoteIncoming.model || "").trim(),
        runtime: remoteIncoming.runtime === undefined ? normalizeRemoteRuntime(currentRemote.runtime) : normalizeRemoteRuntime(remoteIncoming.runtime),
        timeoutSeconds: Math.max(defaultLlmSettings.remote.timeoutSeconds, Number(remoteIncoming.timeoutSeconds || currentRemote.timeoutSeconds || defaultLlmSettings.remote.timeoutSeconds))
      }
    };
  }

  if (settings.embeddings !== undefined) {
    const incoming = settings.embeddings || {};
    next.embeddings = {
      ...next.embeddings,
      enabled: incoming.enabled === undefined ? next.embeddings.enabled : Boolean(incoming.enabled),
      baseUrl: String(incoming.baseUrl || next.llm.baseUrl || defaultEmbeddingSettings.baseUrl).trim().replace(/\/$/, ""),
      apiKey: incoming.apiKey === undefined ? next.embeddings.apiKey : String(incoming.apiKey || next.llm.apiKey || "lm-studio"),
      model: String(incoming.model || defaultEmbeddingSettings.model).trim(),
      batchSize: Math.min(64, Math.max(1, Number(incoming.batchSize || defaultEmbeddingSettings.batchSize))),
      timeoutSeconds: Math.max(10, Number(incoming.timeoutSeconds || defaultEmbeddingSettings.timeoutSeconds))
    };
  }

  if (settings.vectorStore !== undefined) {
    const incoming = settings.vectorStore || {};
    const incomingQdrant = incoming.qdrant || {};
    const currentQdrant = next.vectorStore.qdrant || defaultVectorStoreSettings.qdrant;
    next.vectorStore = normalizeStoredVectorStoreSettings({
      ...next.vectorStore,
      enabled: incoming.enabled === undefined ? next.vectorStore.enabled : Boolean(incoming.enabled),
      provider: normalizeVectorStoreProvider(incoming.provider || next.vectorStore.provider),
      qdrant: {
        ...currentQdrant,
        url: incomingQdrant.url === undefined ? currentQdrant.url : String(incomingQdrant.url || "").trim().replace(/\/$/, ""),
        apiKey: incomingQdrant.apiKey === undefined ? currentQdrant.apiKey : String(incomingQdrant.apiKey || ""),
        collection: incomingQdrant.collection === undefined ? currentQdrant.collection : String(incomingQdrant.collection || "").trim(),
        distance: incomingQdrant.distance === undefined ? currentQdrant.distance : normalizeVectorDistance(incomingQdrant.distance),
        timeoutSeconds: incomingQdrant.timeoutSeconds === undefined
          ? currentQdrant.timeoutSeconds
          : Math.max(2, Number(incomingQdrant.timeoutSeconds || currentQdrant.timeoutSeconds)),
        batchSize: incomingQdrant.batchSize === undefined
          ? currentQdrant.batchSize
          : Math.min(512, Math.max(16, Number(incomingQdrant.batchSize || currentQdrant.batchSize)))
      }
    });
  }

  if (settings.reranker !== undefined) {
    const incoming = settings.reranker || {};
    next.reranker = normalizeStoredRerankerSettings({
      ...next.reranker,
      enabled: incoming.enabled === undefined ? next.reranker.enabled : Boolean(incoming.enabled),
      baseUrl: incoming.baseUrl === undefined ? next.reranker.baseUrl : String(incoming.baseUrl || "").trim().replace(/\/$/, ""),
      apiKey: incoming.apiKey === undefined ? next.reranker.apiKey : String(incoming.apiKey || ""),
      model: incoming.model === undefined ? next.reranker.model : String(incoming.model || defaultRerankerSettings.model).trim(),
      candidateCount: incoming.candidateCount === undefined
        ? next.reranker.candidateCount
        : Math.min(100, Math.max(1, Number(incoming.candidateCount || next.reranker.candidateCount))),
      maxChars: incoming.maxChars === undefined
        ? next.reranker.maxChars
        : Math.min(20000, Math.max(200, Number(incoming.maxChars || next.reranker.maxChars))),
      timeoutSeconds: incoming.timeoutSeconds === undefined
        ? next.reranker.timeoutSeconds
        : Math.min(300, Math.max(2, Number(incoming.timeoutSeconds || next.reranker.timeoutSeconds)))
    });
  }

  if (settings.storage !== undefined) {
    const incoming = settings.storage || {};
    const incomingSqlite = incoming.sqlite || {};
    const currentSqlite = next.storage.sqlite || defaultStorageSettings.sqlite;
    next.storage = normalizeStoredStorageSettings({
      ...next.storage,
      metadataProvider: incoming.metadataProvider || next.storage.metadataProvider,
      sqlite: {
        ...currentSqlite,
        databasePath: incomingSqlite.databasePath === undefined
          ? currentSqlite.databasePath
          : String(incomingSqlite.databasePath || "").trim(),
        fallbackToJson: incomingSqlite.fallbackToJson === undefined
          ? currentSqlite.fallbackToJson
          : Boolean(incomingSqlite.fallbackToJson)
      }
    });
  }

  if (settings.search !== undefined) {
    next.search = normalizeStoredSearchSettings({
      ...next.search,
      ...(settings.search || {})
    });
  }

  await writeJsonAtomic(settingsPath, next);
  await ensureStorage();
  return readSettings();
}

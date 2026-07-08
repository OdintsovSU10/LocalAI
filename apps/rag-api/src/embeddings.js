import crypto from "node:crypto";
import { defaultEmbeddingSettings, readSettings, readVectors, writeVectors } from "./store.js";
import { qdrantStatus, syncSourceToQdrant, vectorProviderDecision } from "./vector-store.js";

function withTimeout(timeoutSeconds) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutSeconds * 1000);
  return { controller, timeout };
}

function embeddingHeaders(settings) {
  return {
    "Content-Type": "application/json",
    "Authorization": `Bearer ${settings.apiKey || "lm-studio"}`
  };
}

function sha1(value) {
  return crypto.createHash("sha1").update(value).digest("hex");
}

export function normalizeEmbeddingSettings(embeddings) {
  return {
    ...defaultEmbeddingSettings,
    ...(embeddings || {}),
    baseUrl: String(embeddings?.baseUrl || defaultEmbeddingSettings.baseUrl).replace(/\/$/, ""),
    batchSize: Math.min(64, Math.max(1, Number(embeddings?.batchSize || defaultEmbeddingSettings.batchSize))),
    timeoutSeconds: Math.max(10, Number(embeddings?.timeoutSeconds || defaultEmbeddingSettings.timeoutSeconds))
  };
}

export function textHash(text) {
  return sha1(String(text || ""));
}

export function normalizeVector(vector) {
  const values = Array.isArray(vector) ? vector.map(Number) : [];
  const norm = Math.sqrt(values.reduce((sum, value) => sum + value * value, 0));
  if (!norm) return [];
  return values.map((value) => value / norm);
}

export function dotProduct(a, b) {
  const length = Math.min(a?.length || 0, b?.length || 0);
  let sum = 0;
  for (let i = 0; i < length; i += 1) sum += a[i] * b[i];
  return sum;
}

export async function embedTexts({ embeddings, texts }) {
  const settings = normalizeEmbeddingSettings(embeddings);
  if (!settings.enabled) return [];
  if (!settings.model) throw new Error("Embedding model is not configured");

  const { controller, timeout } = withTimeout(settings.timeoutSeconds);
  try {
    const response = await fetch(`${settings.baseUrl}/embeddings`, {
      method: "POST",
      headers: embeddingHeaders(settings),
      signal: controller.signal,
      body: JSON.stringify({
        model: settings.model,
        input: texts
      })
    });

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(`Embedding endpoint returned ${response.status}${text ? `: ${text}` : ""}`);
    }

    const payload = await response.json();
    const data = Array.isArray(payload.data) ? payload.data : [];
    return data
      .sort((a, b) => Number(a.index || 0) - Number(b.index || 0))
      .map((item) => normalizeVector(item.embedding));
  } finally {
    clearTimeout(timeout);
  }
}

export async function embedQuery(query, settingsOverride = null) {
  const settings = settingsOverride || await readSettings();
  const embeddings = normalizeEmbeddingSettings(settings.embeddings);
  if (!embeddings.enabled) return null;
  const [vector] = await embedTexts({ embeddings, texts: [query] });
  return { model: embeddings.model, vector };
}

function vectorItemForChunk(chunk, hash, model, vector) {
  return {
    id: chunk.id,
    fileId: chunk.fileId,
    sourceId: chunk.sourceId,
    path: chunk.path,
    chunkIndex: chunk.chunkIndex,
    model,
    textHash: hash,
    dimensions: vector.length,
    vector
  };
}

function configuredVectorProvider(vectorStore = {}) {
  const value = String(vectorStore.provider || "auto").trim().toLowerCase();
  return ["qdrant", "json", "auto"].includes(value) ? value : "auto";
}

async function resolveEmbeddingVectorTarget(vectorStore = {}) {
  const provider = configuredVectorProvider(vectorStore);
  if (vectorStore.enabled === false || provider === "json") {
    return {
      ...vectorProviderDecision({ vectorStore }),
      useQdrant: false,
      useJson: true
    };
  }

  if (provider === "qdrant") {
    return {
      ...vectorProviderDecision({ vectorStore }),
      useQdrant: true,
      useJson: false
    };
  }

  const status = await qdrantStatus(vectorStore);
  if (status.qdrantAvailable) {
    return {
      ...vectorProviderDecision({ vectorStore, qdrantAvailable: true }),
      qdrantStatus: status,
      useQdrant: true,
      useJson: false
    };
  }

  return {
    ...vectorProviderDecision({
      vectorStore,
      qdrantAvailable: false,
      qdrantError: status.qdrantError
    }),
    qdrantStatus: status,
    useQdrant: false,
    useJson: true,
    warning: status.warning || `Qdrant unavailable, using vectors.json fallback${status.qdrantError ? `: ${status.qdrantError}` : ""}`
  };
}

async function readJsonVectorItemsForSource(sourceId, chunks) {
  const vectors = await readVectors();
  const items = vectors.items || {};
  const chunkIds = new Set(chunks.map((chunk) => chunk.id));

  for (const [id, item] of Object.entries(items)) {
    if (item.sourceId === sourceId && !chunkIds.has(id)) delete items[id];
  }

  return items;
}

async function writeJsonVectorFallback({ sourceId, chunks, vectorItems }) {
  const items = await readJsonVectorItemsForSource(sourceId, chunks);
  for (const chunk of chunks) {
    if (vectorItems[chunk.id]) items[chunk.id] = vectorItems[chunk.id];
    else if (items[chunk.id]?.sourceId === sourceId) delete items[chunk.id];
  }
  await writeVectors({ items });
  return Object.values(items).filter((item) => item?.sourceId === sourceId).length;
}

export async function ensureChunkEmbeddings({ sourceId, chunks, onProgress = () => {} }) {
  const settings = await readSettings();
  const embeddings = normalizeEmbeddingSettings(settings.embeddings);
  const target = await resolveEmbeddingVectorTarget(settings.vectorStore);
  const items = target.useJson
    ? await readJsonVectorItemsForSource(sourceId, chunks)
    : {};

  if (!embeddings.enabled) {
    let vectorStoreResult = {
      vectorStoreProvider: target.vectorProviderUsed,
      configuredProvider: target.configuredProvider,
      vectorProviderUsed: target.vectorProviderUsed,
      qdrantEnabled: target.useQdrant,
      qdrantAvailable: Boolean(target.qdrantStatus?.qdrantAvailable),
      qdrantCollection: target.qdrantStatus?.qdrantCollection || "",
      collectionName: target.qdrantStatus?.collectionName || "",
      qdrantPoints: 0,
      vectorCount: 0,
      qdrantError: target.qdrantStatus?.qdrantError || "",
      warning: target.warning || ""
    };
    if (target.useJson) {
      await writeVectors({ items });
      vectorStoreResult.vectorCount = Object.values(items).filter((item) => item?.sourceId === sourceId).length;
    } else if (target.useQdrant) {
      vectorStoreResult = await syncSourceToQdrant({
        vectorStore: settings.vectorStore,
        sourceId,
        chunks,
        vectorItems: {}
      });
    }
    return {
      embeddingEnabled: false,
      embeddingModel: embeddings.model,
      vectorsTotal: chunks.length,
      vectorsEmbedded: 0,
      vectorsCached: 0,
      ...vectorStoreResult
    };
  }

  const pending = [];
  let cached = 0;
  const sourceVectorItems = {};
  for (const chunk of chunks) {
    const hash = textHash(chunk.text);
    const existing = items[chunk.id];
    if (existing && existing.model === embeddings.model && existing.textHash === hash && Array.isArray(existing.vector)) {
      sourceVectorItems[chunk.id] = existing;
      cached += 1;
      continue;
    }

    pending.push({ chunk, hash });
  }

  let embedded = 0;
  onProgress({
    phase: "embed",
    message: "Векторизация чанков",
    vectorsProcessed: cached,
    vectorsTotal: chunks.length,
    vectorsCached: cached,
    vectorsEmbedded: embedded,
    embeddingModel: embeddings.model,
    vectorProviderUsed: target.vectorProviderUsed,
    warning: target.warning || ""
  });

  for (let index = 0; index < pending.length; index += embeddings.batchSize) {
    const batch = pending.slice(index, index + embeddings.batchSize);
    const batchVectors = await embedTexts({
      embeddings,
      texts: batch.map(({ chunk }) => chunk.text)
    });

    batch.forEach(({ chunk, hash }, batchIndex) => {
      const vector = batchVectors[batchIndex] || [];
      if (!vector.length) return;
      const item = vectorItemForChunk(chunk, hash, embeddings.model, vector);
      sourceVectorItems[chunk.id] = item;
      if (target.useJson) items[chunk.id] = item;
      embedded += 1;
    });

    if (target.useJson) await writeVectors({ items });
    onProgress({
      phase: "embed",
      message: "Векторизация чанков",
      vectorsProcessed: cached + embedded,
      vectorsTotal: chunks.length,
      vectorsCached: cached,
      vectorsEmbedded: embedded,
      embeddingModel: embeddings.model,
      vectorProviderUsed: target.vectorProviderUsed,
      warning: target.warning || ""
    });
  }

  onProgress({
    phase: "vector_store",
    message: "Syncing vector store",
    vectorsProcessed: chunks.length,
    vectorsTotal: chunks.length,
    vectorsCached: cached,
    vectorsEmbedded: embedded,
    embeddingModel: embeddings.model,
    vectorProviderUsed: target.vectorProviderUsed,
    warning: target.warning || ""
  });

  let vectorStoreResult;
  if (target.useQdrant) {
    vectorStoreResult = await syncSourceToQdrant({
      vectorStore: settings.vectorStore,
      sourceId,
      chunks,
      vectorItems: sourceVectorItems
    });

    if (!vectorStoreResult.qdrantAvailable && target.configuredProvider === "auto") {
      const fallbackCount = await writeJsonVectorFallback({
        sourceId,
        chunks,
        vectorItems: sourceVectorItems
      });
      vectorStoreResult = {
        ...vectorStoreResult,
        vectorStoreProvider: "json",
        vectorProviderUsed: "json",
        vectorCount: fallbackCount,
        warning: vectorStoreResult.warning || `Qdrant unavailable, using vectors.json fallback${vectorStoreResult.qdrantError ? `: ${vectorStoreResult.qdrantError}` : ""}`
      };
    }
  } else {
    vectorStoreResult = {
      vectorStoreProvider: "json",
      configuredProvider: target.configuredProvider,
      vectorProviderUsed: "json",
      qdrantEnabled: false,
      qdrantAvailable: false,
      qdrantCollection: "",
      collectionName: "",
      qdrantPoints: 0,
      vectorCount: Object.values(items).filter((item) => item?.sourceId === sourceId).length,
      qdrantError: target.qdrantStatus?.qdrantError || "",
      warning: target.warning || ""
    };
  }

  return {
    embeddingEnabled: true,
    embeddingModel: embeddings.model,
    vectorsTotal: chunks.length,
    vectorsEmbedded: embedded,
    vectorsCached: cached,
    ...vectorStoreResult
  };
}

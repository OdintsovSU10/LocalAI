import crypto from "node:crypto";
import { QdrantClient } from "@qdrant/js-client-rest";

const qdrantClients = new Map();

function stableUuid(value) {
  const chars = crypto.createHash("sha256").update(String(value || "")).digest("hex").slice(0, 32).split("");
  chars[12] = "5";
  chars[16] = ((parseInt(chars[16], 16) & 0x3) | 0x8).toString(16);
  return [
    chars.slice(0, 8).join(""),
    chars.slice(8, 12).join(""),
    chars.slice(12, 16).join(""),
    chars.slice(16, 20).join(""),
    chars.slice(20, 32).join("")
  ].join("-");
}

function isQdrantNotFound(error) {
  const status = Number(error?.status || error?.getActualType?.()?.status || 0);
  return status === 404 || /\b404\b|not found/i.test(String(error?.message || ""));
}

function normalizeVectorProvider(provider) {
  const value = String(provider || "").trim().toLowerCase();
  return ["qdrant", "json", "auto"].includes(value) ? value : "auto";
}

export function vectorProviderDecision({ vectorStore = {}, qdrantAvailable = false, qdrantError = "" } = {}) {
  const provider = normalizeVectorProvider(vectorStore.provider || "auto");
  const enabled = vectorStore.enabled !== false;
  if (!enabled || provider === "json") {
    return {
      configuredProvider: provider,
      vectorProviderUsed: "json",
      useQdrant: false,
      writeJson: true,
      qdrantRequired: false,
      warning: ""
    };
  }

  if (provider === "qdrant") {
    return {
      configuredProvider: "qdrant",
      vectorProviderUsed: "qdrant",
      useQdrant: true,
      writeJson: false,
      qdrantRequired: true,
      warning: ""
    };
  }

  if (qdrantAvailable) {
    return {
      configuredProvider: "auto",
      vectorProviderUsed: "qdrant",
      useQdrant: true,
      writeJson: false,
      qdrantRequired: false,
      warning: ""
    };
  }

  return {
    configuredProvider: "auto",
    vectorProviderUsed: "json",
    useQdrant: false,
    writeJson: true,
    qdrantRequired: false,
    warning: qdrantError ? `Qdrant unavailable, using vectors.json fallback: ${qdrantError}` : "Qdrant unavailable, using vectors.json fallback"
  };
}

function qdrantSettings(vectorStore = {}) {
  const qdrant = vectorStore.qdrant || {};
  const provider = normalizeVectorProvider(vectorStore.provider || "auto");
  return {
    enabled: vectorStore.enabled !== false && provider !== "json",
    required: vectorStore.enabled !== false && provider === "qdrant",
    provider,
    url: String(qdrant.url || "http://127.0.0.1:6333").trim().replace(/\/$/, ""),
    apiKey: String(qdrant.apiKey || ""),
    collection: String(qdrant.collection || "localai_chunks").trim(),
    distance: String(qdrant.distance || "Cosine").trim(),
    timeoutSeconds: Math.max(2, Number(qdrant.timeoutSeconds || 10)),
    batchSize: Math.min(512, Math.max(16, Number(qdrant.batchSize || 128)))
  };
}

function disabledResult(reason = "disabled", provider = "json") {
  const normalizedProvider = normalizeVectorProvider(provider);
  return {
    vectorStoreProvider: "json",
    configuredProvider: normalizedProvider,
    vectorProviderUsed: "json",
    qdrantEnabled: false,
    qdrantAvailable: false,
    qdrantCollection: "",
    collectionName: "",
    qdrantPoints: 0,
    vectorCount: 0,
    qdrantError: "",
    warning: "",
    reason
  };
}

function qdrantClient(settings) {
  const key = `${settings.url}|${settings.apiKey ? "key" : "nokey"}|${settings.timeoutSeconds}`;
  if (!qdrantClients.has(key)) {
    qdrantClients.set(key, new QdrantClient({
      url: settings.url,
      apiKey: settings.apiKey || undefined,
      timeout: settings.timeoutSeconds * 1000,
      checkCompatibility: false
    }));
  }
  return qdrantClients.get(key);
}

function collectionVectorSize(collectionInfo) {
  const vectors = collectionInfo?.config?.params?.vectors;
  if (!vectors) return null;
  if (Number.isFinite(Number(vectors.size))) return Number(vectors.size);
  const first = Object.values(vectors)[0];
  return Number.isFinite(Number(first?.size)) ? Number(first.size) : null;
}

async function ensureQdrantCollection(client, settings, dimensions) {
  try {
    const info = await client.getCollection(settings.collection);
    const existingSize = collectionVectorSize(info);
    if (existingSize && existingSize !== dimensions) {
      throw new Error(`Qdrant collection "${settings.collection}" has ${existingSize} dimensions, expected ${dimensions}. Use another collection name or recreate it.`);
    }
    return { created: false };
  } catch (error) {
    if (!isQdrantNotFound(error)) throw error;
  }

  await client.createCollection(settings.collection, {
    vectors: {
      size: dimensions,
      distance: settings.distance
    }
  });

  await Promise.allSettled([
    client.createPayloadIndex(settings.collection, { field_name: "sourceId", field_schema: "keyword", wait: true }),
    client.createPayloadIndex(settings.collection, { field_name: "fileId", field_schema: "keyword", wait: true })
  ]);

  return { created: true };
}

function qdrantFilter(sourceId = "", sourceIds = null) {
  const scopedIds = Array.isArray(sourceIds)
    ? sourceIds.map((id) => String(id || "").trim()).filter(Boolean)
    : [];
  if (scopedIds.length > 1) {
    return {
      should: scopedIds.map((value) => ({
        key: "sourceId",
        match: { value }
      }))
    };
  }
  if (scopedIds.length === 1) {
    return {
      must: [{ key: "sourceId", match: { value: scopedIds[0] } }]
    };
  }

  const value = String(sourceId || "").trim();
  if (!value) return undefined;
  return {
    must: [{ key: "sourceId", match: { value } }]
  };
}

function qdrantPointForChunk(chunk, item) {
  return {
    id: stableUuid(chunk.id),
    vector: item.vector,
    payload: {
      chunkId: chunk.id,
      fileId: chunk.fileId,
      sourceId: chunk.sourceId,
      sourceTitle: chunk.sourceTitle,
      path: chunk.path,
      title: chunk.title,
      chunkIndex: chunk.chunkIndex,
      model: item.model,
      textHash: item.textHash,
      terms: Array.isArray(chunk.terms) ? chunk.terms.slice(0, 200) : []
    }
  };
}

function throwIfAborted(signal) {
  if (!signal?.aborted) return;
  const error = new Error("Индексация остановлена");
  error.name = "AbortError";
  throw error;
}

function qdrantErrorResult(settings, error) {
  if (settings.required) throw error;
  const decision = vectorProviderDecision({
    vectorStore: { enabled: true, provider: settings.provider },
    qdrantAvailable: false,
    qdrantError: error.message
  });
  return {
    vectorStoreProvider: decision.vectorProviderUsed,
    configuredProvider: settings.provider,
    vectorProviderUsed: decision.vectorProviderUsed,
    qdrantEnabled: true,
    qdrantAvailable: false,
    qdrantCollection: settings.collection,
    collectionName: settings.collection,
    qdrantPoints: 0,
    vectorCount: 0,
    qdrantError: error.message,
    warning: decision.warning
  };
}

function qdrantStatusErrorResult(settings, error) {
  const autoFallback = settings.provider === "auto";
  const decision = vectorProviderDecision({
    vectorStore: { enabled: true, provider: settings.provider },
    qdrantAvailable: false,
    qdrantError: error.message
  });
  return {
    vectorStoreProvider: autoFallback ? "json" : "qdrant",
    configuredProvider: settings.provider,
    vectorProviderUsed: autoFallback ? decision.vectorProviderUsed : "qdrant",
    qdrantEnabled: true,
    qdrantAvailable: false,
    qdrantCollection: settings.collection,
    collectionName: settings.collection,
    qdrantPoints: 0,
    vectorCount: 0,
    qdrantError: error.message,
    warning: autoFallback ? decision.warning : ""
  };
}

async function clearSourcePoints(client, settings, sourceId) {
  try {
    await client.getCollection(settings.collection);
  } catch (error) {
    if (isQdrantNotFound(error)) return { collectionExists: false };
    throw error;
  }

  await client.delete(settings.collection, {
    wait: true,
    filter: qdrantFilter(sourceId)
  });
  return { collectionExists: true };
}

export async function syncSourceToQdrant({ vectorStore, sourceId, chunks, vectorItems, signal = null }) {
  throwIfAborted(signal);
  const settings = qdrantSettings(vectorStore);
  if (!settings.enabled) return disabledResult("disabled", settings.provider);

  const points = [];
  for (const chunk of chunks) {
    const item = vectorItems[chunk.id];
    if (!Array.isArray(item?.vector) || !item.vector.length) continue;
    points.push(qdrantPointForChunk(chunk, item));
  }

  try {
    const client = qdrantClient(settings);
    if (!points.length) {
      throwIfAborted(signal);
      await clearSourcePoints(client, settings, sourceId);
      return {
        vectorStoreProvider: "qdrant",
        configuredProvider: settings.provider,
        vectorProviderUsed: "qdrant",
        qdrantEnabled: true,
        qdrantAvailable: true,
        qdrantCollection: settings.collection,
        collectionName: settings.collection,
        qdrantPoints: 0,
        vectorCount: 0,
        qdrantError: "",
        warning: "",
        sourceRebuilt: true,
        reason: "no_vectors"
      };
    }

    throwIfAborted(signal);
    await ensureQdrantCollection(client, settings, points[0].vector.length);
    throwIfAborted(signal);
    await clearSourcePoints(client, settings, sourceId);

    for (let index = 0; index < points.length; index += settings.batchSize) {
      throwIfAborted(signal);
      await client.upsert(settings.collection, {
        wait: true,
        points: points.slice(index, index + settings.batchSize)
      });
    }

    return {
      vectorStoreProvider: "qdrant",
      configuredProvider: settings.provider,
      vectorProviderUsed: "qdrant",
      qdrantEnabled: true,
      qdrantAvailable: true,
      qdrantCollection: settings.collection,
      collectionName: settings.collection,
      qdrantPoints: points.length,
      vectorCount: points.length,
      qdrantError: "",
      warning: "",
      sourceRebuilt: true
    };
  } catch (error) {
    if (error?.name === "AbortError" || signal?.aborted) throw error;
    return qdrantStatusErrorResult(settings, error);
  }
}

export async function searchQdrantVectors({ vectorStore, vector, sourceId, sourceIds = null, limit = 30 }) {
  const settings = qdrantSettings(vectorStore);
  if (!settings.enabled || !Array.isArray(vector) || !vector.length) {
    return { available: false, matches: [], error: "", vectorProviderUsed: "json", warning: "" };
  }

  try {
    const client = qdrantClient(settings);
    const result = await client.search(settings.collection, {
      vector,
      limit,
      filter: qdrantFilter(sourceId, sourceIds),
      with_payload: true,
      with_vector: false
    });

    return {
      available: true,
      configuredProvider: settings.provider,
      vectorProviderUsed: "qdrant",
      matches: result
        .map((point) => ({
          chunkId: point.payload?.chunkId || "",
          score: Number(point.score || 0)
        }))
        .filter((item) => item.chunkId),
      error: "",
      warning: ""
    };
  } catch (error) {
    if (settings.required) throw error;
    const decision = vectorProviderDecision({
      vectorStore: { enabled: true, provider: settings.provider },
      qdrantAvailable: false,
      qdrantError: error.message
    });
    return {
      available: false,
      configuredProvider: settings.provider,
      vectorProviderUsed: decision.vectorProviderUsed,
      matches: [],
      error: error.message,
      warning: decision.warning
    };
  }
}

export async function countQdrantVectorsBySource({ vectorStore, sourceIds = [] } = {}) {
  const settings = qdrantSettings(vectorStore);
  if (!settings.enabled) {
    return {
      ...disabledResult("disabled", settings.provider),
      counts: new Map()
    };
  }

  try {
    const client = qdrantClient(settings);
    await client.getCollection(settings.collection);
    const counts = new Map();

    for (const sourceId of sourceIds) {
      const id = String(sourceId || "").trim();
      if (!id) continue;
      const result = await client.count(settings.collection, {
        filter: qdrantFilter(id),
        exact: true,
        timeout: settings.timeoutSeconds
      });
      counts.set(id, Number(result?.count || 0));
    }

    return {
      vectorStoreProvider: "qdrant",
      configuredProvider: settings.provider,
      vectorProviderUsed: "qdrant",
      qdrantEnabled: true,
      qdrantAvailable: true,
      qdrantCollection: settings.collection,
      collectionName: settings.collection,
      qdrantPoints: Array.from(counts.values()).reduce((sum, count) => sum + count, 0),
      vectorCount: Array.from(counts.values()).reduce((sum, count) => sum + count, 0),
      qdrantError: "",
      warning: "",
      counts
    };
  } catch (error) {
    return {
      ...qdrantStatusErrorResult(settings, error),
      counts: new Map()
    };
  }
}

export async function qdrantStatus(vectorStore) {
  const settings = qdrantSettings(vectorStore);
  if (!settings.enabled) return disabledResult("disabled", settings.provider);

  try {
    const client = qdrantClient(settings);
    await client.getCollections();
    let collection = null;
    try {
      collection = await client.getCollection(settings.collection);
    } catch (error) {
      if (!isQdrantNotFound(error)) throw error;
    }

    return {
      vectorStoreProvider: "qdrant",
      configuredProvider: settings.provider,
      vectorProviderUsed: "qdrant",
      qdrantEnabled: true,
      qdrantAvailable: true,
      qdrantCollection: settings.collection,
      collectionName: settings.collection,
      qdrantPoints: Number(collection?.points_count || collection?.vectors_count || 0),
      vectorCount: Number(collection?.points_count || collection?.vectors_count || 0),
      qdrantError: "",
      warning: ""
    };
  } catch (error) {
    return qdrantErrorResult(settings, error);
  }
}

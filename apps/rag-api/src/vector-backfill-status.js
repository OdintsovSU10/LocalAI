function normalizeVectorProvider(provider) {
  const value = String(provider || "").trim().toLowerCase();
  return ["qdrant", "json", "auto"].includes(value) ? value : "auto";
}

function mapCount(counts, key) {
  if (!counts) return 0;
  if (counts instanceof Map) return Number(counts.get(key) || 0);
  return Number(counts[key] || 0);
}

export function countChunksBySource(chunks = []) {
  const counts = new Map();
  for (const chunk of chunks) {
    if (!chunk?.sourceId) continue;
    counts.set(chunk.sourceId, (counts.get(chunk.sourceId) || 0) + 1);
  }
  return counts;
}

export function countJsonVectorsBySource(vectors = {}) {
  const counts = new Map();
  for (const item of Object.values(vectors.items || {})) {
    if (!item?.sourceId) continue;
    counts.set(item.sourceId, (counts.get(item.sourceId) || 0) + 1);
  }
  return counts;
}

function resolveVectorProvider({ settings = {}, qdrantAvailable = false } = {}) {
  const vectorStore = settings.vectorStore || {};
  const provider = normalizeVectorProvider(vectorStore.provider || "auto");
  const enabled = vectorStore.enabled !== false;

  if (!enabled || provider === "json") {
    return {
      configuredProvider: provider,
      vectorProviderUsed: "json",
      qdrantExpected: false
    };
  }

  if (provider === "qdrant") {
    return {
      configuredProvider: "qdrant",
      vectorProviderUsed: "qdrant",
      qdrantExpected: true
    };
  }

  return {
    configuredProvider: "auto",
    vectorProviderUsed: qdrantAvailable ? "qdrant" : "json",
    qdrantExpected: true
  };
}

function rowWarning({ configuredProvider, vectorProviderUsed, qdrantExpected, qdrantAvailable, qdrantError, qdrantWarning }) {
  if (!qdrantExpected) return "";
  if (qdrantAvailable) return "";
  if (configuredProvider === "auto" && vectorProviderUsed === "json") {
    return qdrantWarning || (qdrantError
      ? `Qdrant unavailable, using vectors.json fallback: ${qdrantError}`
      : "Qdrant unavailable, using vectors.json fallback");
  }
  if (configuredProvider === "qdrant") {
    return qdrantError ? `Qdrant unavailable: ${qdrantError}` : "Qdrant unavailable";
  }
  return "";
}

export function buildVectorBackfillRows({
  sources = [],
  chunks = [],
  vectors = {},
  settings = {},
  qdrantCounts = new Map(),
  qdrantAvailable = false,
  qdrantError = "",
  qdrantWarning = ""
} = {}) {
  const chunkCounts = countChunksBySource(chunks);
  const jsonVectorCounts = countJsonVectorsBySource(vectors);
  const provider = resolveVectorProvider({ settings, qdrantAvailable });

  return sources
    .map((source) => {
      const chunksCount = chunkCounts.get(source.id) || 0;
      const jsonVectors = jsonVectorCounts.get(source.id) || 0;
      const qdrantVectors = mapCount(qdrantCounts, source.id);
      const storedVectors = provider.vectorProviderUsed === "qdrant" ? qdrantVectors : jsonVectors;
      const warning = rowWarning({
        ...provider,
        qdrantAvailable,
        qdrantError,
        qdrantWarning
      });

      return {
        id: source.id,
        title: source.title,
        chunks: chunksCount,
        // Legacy field: vectors means vectors.json count. New clients should use storedVectors.
        vectors: jsonVectors,
        jsonVectors,
        qdrantVectors,
        storedVectors,
        configuredProvider: provider.configuredProvider,
        vectorProviderUsed: provider.vectorProviderUsed,
        qdrantAvailable: Boolean(qdrantAvailable),
        qdrantError: qdrantError || "",
        warning,
        missing: Math.max(0, chunksCount - storedVectors),
        ready: chunksCount > 0 && storedVectors >= chunksCount
      };
    })
    .sort((left, right) => {
      if (left.missing && right.missing) return left.missing - right.missing;
      if (left.missing) return -1;
      if (right.missing) return 1;
      return left.title.localeCompare(right.title);
    });
}

export function buildCompletedVectorBackfillJob({ row, id, now = new Date().toISOString() } = {}) {
  if (!row?.ready) throw new Error("Cannot complete vector backfill for a source that is not ready.");

  return {
    id,
    type: "vector_backfill",
    sourceId: row.id,
    sourceTitle: row.title,
    status: "completed",
    phase: "done",
    message: "Vectors already complete",
    vectorsTotal: row.chunks,
    vectorsProcessed: row.storedVectors,
    vectorsCached: row.storedVectors,
    vectorsEmbedded: 0,
    jsonVectors: row.jsonVectors,
    qdrantVectors: row.qdrantVectors,
    storedVectors: row.storedVectors,
    vectorStoreProvider: row.vectorProviderUsed,
    configuredProvider: row.configuredProvider,
    vectorProviderUsed: row.vectorProviderUsed,
    qdrantAvailable: row.qdrantAvailable,
    vectorCount: row.storedVectors,
    qdrantError: row.qdrantError || "",
    warning: row.warning || "",
    ready: true,
    startedAt: now,
    updatedAt: now,
    finishedAt: now
  };
}

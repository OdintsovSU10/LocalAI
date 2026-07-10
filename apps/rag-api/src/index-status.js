import path from "node:path";

export const DEFAULT_INDEX_PROGRESS_STALE_MS = 2 * 60 * 1000;

function entries(manifest = {}) {
  return Object.entries(manifest.files || {})
    .map(([key, entry]) => ({ key, entry }))
    .filter(({ entry }) => entry);
}

function sourceIdFor(sourceOrId = "") {
  return typeof sourceOrId === "object"
    ? String(sourceOrId?.id || "")
    : String(sourceOrId || "");
}

function currentSourceIdSet(currentSourceIds = null) {
  if (currentSourceIds instanceof Set) return currentSourceIds;
  if (Array.isArray(currentSourceIds)) return new Set(currentSourceIds.map((id) => String(id || "")).filter(Boolean));
  return new Set();
}

function pathModuleFor(value = "") {
  const text = String(value || "");
  if (/^[a-z]:[\\/]/i.test(text) || /^\\\\/.test(text)) return path.win32;
  if (text.startsWith("/")) return path.posix;
  return path;
}

function finitePositiveNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function timestampMs(value) {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.getTime();
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (!value) return null;
  const parsed = new Date(value).getTime();
  return Number.isNaN(parsed) ? null : parsed;
}

export function indexProgressHealth(job = {}, options = {}) {
  const status = String(job?.status || "");
  const alive = Boolean(options.alive);
  const staleAfterMs = finitePositiveNumber(
    options.staleAfterMs ?? process.env.RAG_INDEX_PROGRESS_STALE_MS,
    DEFAULT_INDEX_PROGRESS_STALE_MS
  );
  const checkedAtMs = timestampMs(options.now ?? Date.now()) ?? Date.now();
  const lastProgressAt = job?.updatedAt || job?.startedAt || "";
  const lastProgressMs = timestampMs(lastProgressAt);
  const progressAgeMs = lastProgressMs === null ? null : Math.max(0, checkedAtMs - lastProgressMs);

  const base = {
    status: "idle",
    code: status || "not_indexed",
    alive,
    stale: false,
    staleAfterMs,
    progressAgeMs,
    lastProgressAt,
    checkedAt: new Date(checkedAtMs).toISOString()
  };

  if (status === "running") {
    if (!alive) {
      return {
        ...base,
        status: "interrupted",
        code: "process_missing",
        stale: true
      };
    }
    if (progressAgeMs !== null && progressAgeMs > staleAfterMs) {
      return {
        ...base,
        status: "stale",
        code: "no_recent_progress",
        stale: true
      };
    }
    return {
      ...base,
      status: "active",
      code: "progress_recent"
    };
  }

  if (status === "failed" && job?.phase === "interrupted") {
    return {
      ...base,
      status: "interrupted",
      code: "process_missing",
      stale: true
    };
  }

  if (status === "failed") return { ...base, status: "failed", code: "failed" };
  if (status === "cancelled") return { ...base, status: "cancelled", code: "cancelled" };
  if (status === "completed") return { ...base, status: "completed", code: "completed" };
  return base;
}

function pathInside(root = "", filePath = "") {
  if (!root || !filePath) return false;
  const pathLib = pathModuleFor(root);
  const resolvedRoot = pathLib.resolve(String(root));
  const resolvedFile = pathLib.resolve(String(filePath));
  const relative = pathLib.relative(resolvedRoot, resolvedFile);
  return !relative || (!relative.startsWith("..") && !pathLib.isAbsolute(relative));
}

function sourceRoots(source = {}) {
  return [source.path, ...(Array.isArray(source.additionalPaths) ? source.additionalPaths : [])]
    .map((root) => String(root || "").trim())
    .filter(Boolean);
}

function sourcePathMatchesEntry(source = {}, entry = {}, options = {}) {
  const knownCurrentIds = currentSourceIdSet(options.currentSourceIds);
  const entrySourceId = String(entry?.sourceId || "");
  if (entrySourceId && knownCurrentIds.has(entrySourceId)) return false;

  const entryPath = String(entry?.path || "");
  if (!entryPath || entry?.origin === "google-context") return false;
  return sourceRoots(source).some((root) => pathInside(root, entryPath));
}

export function manifestChunkCount(entry) {
  const count = Number(entry?.quality?.chunks ?? entry?.chunks ?? 0);
  return Number.isFinite(count) && count > 0 ? count : 0;
}

export function indexedEntryQualityStatus(entry) {
  return entry?.quality?.status || (manifestChunkCount(entry) > 0 ? "unchecked" : "error");
}

export function sourceIndexEntryMatches(sourceOrId = "", entry = {}, options = {}) {
  const sourceId = sourceIdFor(sourceOrId);
  if (sourceId && entry?.sourceId === sourceId) return true;
  if (!sourceOrId || typeof sourceOrId !== "object") return false;
  return sourcePathMatchesEntry(sourceOrId, entry, options);
}

export function indexedEntriesForSource(sourceOrId = "", manifest = {}, options = {}) {
  const sourceId = sourceIdFor(sourceOrId);
  const seen = new Set();
  const matched = [];

  for (const { key, entry } of entries(manifest)) {
    if (!sourceIndexEntryMatches(sourceOrId, entry, options)) continue;
    const entryKey = entry?.fileId || key;
    if (seen.has(entryKey)) continue;
    seen.add(entryKey);
    matched.push(entry);
  }

  if (!sourceId && typeof sourceOrId !== "object") return [];
  return matched;
}

export function indexedSnapshotForSource(sourceOrId, manifest = {}, options = {}) {
  const sourceEntries = indexedEntriesForSource(sourceOrId, manifest, options);
  const chunksTotal = sourceEntries.reduce((sum, entry) => sum + manifestChunkCount(entry), 0);
  const indexedAt = sourceEntries
    .map((entry) => entry.indexedAt)
    .filter(Boolean)
    .sort()
    .at(-1);

  return {
    files: sourceEntries.length,
    searchable: sourceEntries.filter((entry) => manifestChunkCount(entry) > 0).length,
    chunks: chunksTotal,
    indexedAt
  };
}

export function indexedSnapshotForAllSources(manifest = {}) {
  const sourceEntries = entries(manifest)
    .map(({ entry }) => entry)
    .filter((entry) => entry?.sourceId);
  const chunksTotal = sourceEntries.reduce((sum, entry) => sum + manifestChunkCount(entry), 0);
  const indexedAt = sourceEntries
    .map((entry) => entry.indexedAt)
    .filter(Boolean)
    .sort()
    .at(-1);

  return {
    files: sourceEntries.length,
    searchable: sourceEntries.filter((entry) => manifestChunkCount(entry) > 0).length,
    chunks: chunksTotal,
    indexedAt
  };
}

export function allSourcesIndexEntries(sources = [], manifest = {}) {
  const currentSourceIds = new Set(sources.map((source) => source?.id).filter(Boolean));
  const seen = new Set();
  const matched = [];

  for (const source of sources) {
    for (const entry of indexedEntriesForSource(source, manifest, { currentSourceIds })) {
      const key = entry?.fileId || `${entry?.sourceId || ""}:${entry?.path || ""}`;
      if (seen.has(key)) continue;
      seen.add(key);
      matched.push(entry);
    }
  }

  return matched;
}

export function sourceForIndexEntry(sources = [], entry = {}, fallback = null) {
  const direct = sources.find((source) => source?.id && source.id === entry?.sourceId);
  if (direct) return direct;

  const currentSourceIds = new Set(sources.map((source) => source?.id).filter(Boolean));
  return sources.find((source) => sourcePathMatchesEntry(source, entry, { currentSourceIds })) || fallback;
}

export function indexSourceIdsForSources(sources = [], manifest = {}) {
  const currentSourceIds = new Set(sources.map((source) => source?.id).filter(Boolean));
  const ids = new Set(currentSourceIds);

  for (const source of sources) {
    for (const entry of indexedEntriesForSource(source, manifest, { currentSourceIds })) {
      if (entry?.sourceId) ids.add(entry.sourceId);
    }
  }

  return [...ids];
}

export function mergeIndexedSnapshotStatus(status, snapshot) {
  if (!snapshot?.files) return status;
  if (status.status === "running") {
    return {
      ...status,
      indexedFiles: Math.max(status.indexedFiles || 0, snapshot.files),
      chunks: Math.max(status.chunks || 0, snapshot.chunks),
      vectorsTotal: Math.max(status.vectorsTotal || 0, snapshot.chunks)
    };
  }
  if (status.status === "failed") {
    return {
      ...status,
      indexedFiles: Math.max(status.indexedFiles || 0, snapshot.files),
      total: Math.max(status.total || 0, snapshot.files),
      eligibleFiles: Math.max(status.eligibleFiles || 0, snapshot.files),
      chunks: Math.max(status.chunks || 0, snapshot.chunks),
      vectorsTotal: Math.max(status.vectorsTotal || 0, snapshot.chunks)
    };
  }
  if (status.status === "completed" && (status.indexedFiles || status.chunks)) return status;
  return {
    ...status,
    status: "completed",
    phase: status.phase || "manifest",
    message: "Индекс найден",
    indexedFiles: snapshot.files,
    total: Math.max(status.total || 0, snapshot.files),
    eligibleFiles: Math.max(status.eligibleFiles || 0, snapshot.files),
    chunks: snapshot.chunks,
    vectorsTotal: Math.max(status.vectorsTotal || 0, snapshot.chunks),
    updatedAt: status.updatedAt || status.finishedAt || snapshot.indexedAt,
    finishedAt: status.finishedAt || snapshot.indexedAt
  };
}

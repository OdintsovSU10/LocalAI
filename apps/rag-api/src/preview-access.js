import path from "node:path";
import { sourceIndexEntryMatches } from "./index-status.js";

export function normalizePreviewPath(value) {
  return path.normalize(String(value || "").trim());
}

export function isPathInsideDirectory(rootDir, candidatePath) {
  const relative = path.relative(rootDir, candidatePath);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function hasEncodedTraversal(value) {
  return /%(?:2e|2f|5c)/i.test(String(value || ""));
}

export function findKnownSource(sources = [], sourceId = "") {
  const id = String(sourceId || "").trim();
  if (!id) return null;
  return sources.find((source) => source?.id === id) || null;
}

export function findPreviewManifestEntry({
  manifest = {},
  sourceId = "",
  source = null,
  currentSourceIds = null,
  filePath = "",
  fileId = "",
  chunk = null
} = {}) {
  const scopeSource = source || { id: sourceId };
  const entries = Object.values(manifest.files || {})
    .filter((entry) => sourceIndexEntryMatches(scopeSource, entry, { currentSourceIds }));
  const chunkPath = String(chunk?.path || "").trim();
  const requestedFileId = String(fileId || "").trim();
  const requestedPath = chunkPath || String(filePath || "").trim();

  if (chunkPath) {
    return entries.find((entry) => entry?.path === chunkPath) || null;
  }

  if (requestedFileId) {
    return entries.find((entry) => entry?.fileId === requestedFileId) || null;
  }

  if (requestedPath) {
    return entries.find((entry) => entry?.path === requestedPath) || null;
  }

  return null;
}

export async function resolvePreviewTarget({
  source = null,
  manifest = {},
  filePath = "",
  fileId = "",
  chunkId = "",
  findChunkById = async () => null
} = {}) {
  if (!source?.id) {
    return { status: 404, error: "source not found", targetMatched: false };
  }

  const normalizedChunkId = String(chunkId || "").trim();
  let chunk = null;
  if (normalizedChunkId) {
    chunk = await findChunkById(normalizedChunkId, source.id);
    if (!chunk) {
      return {
        status: 404,
        error: "chunk not found",
        targetMatched: false,
        sourceId: source.id,
        chunkId: normalizedChunkId
      };
    }
  }

  const entry = findPreviewManifestEntry({
    manifest,
    sourceId: source.id,
    source,
    filePath,
    fileId,
    chunk
  });

  if (!entry && !chunk) {
    return {
      status: 404,
      error: "indexed file not found",
      targetMatched: false,
      fallbackReason: "legacy target not found",
      sourceId: source.id
    };
  }

  return {
    status: 200,
    source,
    entry,
    chunk,
    targetMatched: Boolean(chunk),
    fallbackReason: chunk ? "" : "legacy file preview",
    sourceId: source.id,
    chunkId: chunk?.id || normalizedChunkId || ""
  };
}

export function resolveSourceCacheDir(cacheRoot, sourceId) {
  const root = path.resolve(cacheRoot);
  const id = String(sourceId || "").trim();
  if (!id || id === "." || id === ".." || /[\\/]/.test(id) || hasEncodedTraversal(id)) {
    throw new Error("Unsafe source cache id");
  }

  const sourceDir = path.resolve(root, id);
  if (sourceDir === root || !isPathInsideDirectory(root, sourceDir)) {
    throw new Error("Unsafe source cache id");
  }
  return sourceDir;
}

export function resolveMarkdownCachePath(cacheRoot, sourceId, cacheFile) {
  const sourceDir = resolveSourceCacheDir(cacheRoot, sourceId);
  const rawValue = String(cacheFile || "").trim();
  if (!rawValue || hasEncodedTraversal(rawValue)) throw new Error("Unsafe markdown cache path");
  const value = normalizePreviewPath(rawValue);

  const resolved = path.isAbsolute(value)
    ? path.resolve(value)
    : path.resolve(sourceDir, value);
  if (!isPathInsideDirectory(sourceDir, resolved)) {
    throw new Error("Unsafe markdown cache path");
  }

  return resolved;
}

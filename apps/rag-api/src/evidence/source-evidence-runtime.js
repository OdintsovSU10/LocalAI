import fs from "node:fs/promises";

import { indexedEntriesForSource } from "../index-status.js";
import { resolveMarkdownCachePath } from "../preview-access.js";
import { buildSourceEvidence } from "./build-source-evidence.js";

export class SourceNotFoundError extends Error {
  constructor(sourceId) {
    super(`source ${sourceId} not found`);
    this.statusCode = 404;
  }
}

// Reads index state for one source, rebuilds its evidence and replaces the stored build.
export async function rebuildSourceEvidence(sourceId, { store, readSources, readManifest, readChunks, markdownCacheRoot }) {
  const sources = await readSources();
  const source = sources.find((item) => item.id === sourceId);
  if (!source) throw new SourceNotFoundError(sourceId);

  const manifest = await readManifest();
  const currentSourceIds = new Set(sources.map((item) => item?.id).filter(Boolean));
  const files = indexedEntriesForSource(source, manifest, { currentSourceIds }).filter((entry) => entry?.fileId);
  const fileIds = new Set(files.map((entry) => entry.fileId));
  const chunks = (await readChunks()).filter((chunk) => fileIds.has(chunk.fileId));

  const build = await buildSourceEvidence({
    sourceId: source.id,
    files,
    chunks,
    readMarkdown: async (entry) => {
      if (!entry.cacheFile || !markdownCacheRoot) return null;
      const cachePath = resolveMarkdownCachePath(markdownCacheRoot, entry.sourceId || source.id, entry.cacheFile);
      return fs.readFile(cachePath, "utf8");
    }
  });
  return {
    summary: store.replaceSourceEvidence(build),
    relations: build.relations.length,
    conflicts: build.conflicts.length
  };
}

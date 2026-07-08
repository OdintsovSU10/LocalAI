import { maskPathValue, sanitizeValue } from "../sanitize/redact.js";

const QUALITY_FILTERS = new Set(["all", "ok", "warning", "error", "searchable"]);

function matchesQualityFilter(file, qualityFilter) {
  if (qualityFilter === "all") return true;
  if (qualityFilter === "searchable") return Number(file.chunks || 0) > 0;
  const status = file.quality?.status || (file.chunks > 0 ? "unchecked" : "error");
  return status === qualityFilter;
}

export async function getIndexedFiles(apiClient, args = {}) {
  const sourceId = String(args.sourceId || "").trim();
  if (!sourceId) {
    throw new Error("sourceId is required");
  }

  const qualityFilter = QUALITY_FILTERS.has(args.qualityFilter)
    ? args.qualityFilter
    : "all";

  const payload = await apiClient.get(`/api/sources/${encodeURIComponent(sourceId)}/indexed-files`);
  const files = Array.isArray(payload.files) ? payload.files : [];
  const filtered = files
    .filter((file) => matchesQualityFilter(file, qualityFilter))
    .map((file) => {
      const {
        path: _absolutePath,
        ...rest
      } = file;
      return sanitizeValue({
        fileId: rest.fileId,
        relativePath: rest.relativePath || rest.title || "",
        title: rest.title,
        extension: rest.extension,
        chunks: rest.chunks,
        indexedAt: rest.indexedAt,
        quality: rest.quality,
        recognition: rest.recognition
      });
    });

  return sanitizeValue({
    sourceId: payload.sourceId || sourceId,
    sourceTitle: payload.sourceTitle || "",
    maskedRoot: payload.root ? maskPathValue(payload.root) : "",
    total: filtered.length,
    searchable: filtered.filter((file) => Number(file.chunks || 0) > 0).length,
    chunks: filtered.reduce((sum, file) => sum + Number(file.chunks || 0), 0),
    quality: payload.quality || {},
    files: filtered
  });
}

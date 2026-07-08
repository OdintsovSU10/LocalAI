import { sanitizeValue } from "../sanitize/redact.js";
import { makeSnippet } from "../sanitize/truncate.js";

const SNIPPET_CHARS = 400;
const FULL_TEXT_BLOCKED_MESSAGE =
  "includeFullText=true is disabled in Phase 1. Use snippet results and previewCitation for excerpts.";

export async function search(apiClient, args = {}) {
  const query = String(args.query || "").trim();
  if (!query) {
    throw new Error("query is required");
  }
  if (query.length > 2000) {
    throw new Error("query must be at most 2000 characters");
  }

  if (Boolean(args.includeFullText)) {
    throw new Error(FULL_TEXT_BLOCKED_MESSAGE);
  }

  const sourceId = String(args.sourceId || "").trim();
  const limit = Math.min(Math.max(Number(args.limit || 10), 1), 30);

  const payload = await apiClient.get("/api/search", {
    q: query,
    sourceId,
    limit
  });

  const results = (Array.isArray(payload.results) ? payload.results : []).map((item, index) => {
    const snippet = item.snippet || makeSnippet(item.text || "", SNIPPET_CHARS);
    return sanitizeValue({
      rank: index + 1,
      chunkId: item.chunkId || item.id,
      fileId: item.fileId || "",
      sourceId: item.sourceId,
      sourceTitle: item.sourceTitle,
      citationLabel: item.citationLabel,
      score: item.score,
      snippet,
      citationTarget: item.citationTarget || null
    });
  });

  return {
    query: payload.query || query,
    results,
    metadata: sanitizeValue(payload.metadata || {})
  };
}

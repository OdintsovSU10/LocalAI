import { sanitizeValue } from "../sanitize/redact.js";
import { truncateFields } from "../sanitize/truncate.js";

const PHASE1_MAX_CHARS = 20_000;

function hasTarget(args = {}) {
  return Boolean(args.chunkId || args.fileId || args.path);
}

function resolveMaxChars(value) {
  const requested = Number(value || 12_000);
  const bounded = Math.min(Math.max(requested, 500), PHASE1_MAX_CHARS);
  return bounded;
}

export async function previewCitation(apiClient, args = {}) {
  const sourceId = String(args.sourceId || "").trim();
  if (!sourceId) {
    throw new Error("sourceId is required");
  }
  if (!hasTarget(args)) {
    throw new Error("At least one of chunkId, fileId, or path is required");
  }

  const maxChars = resolveMaxChars(args.maxChars);
  const focusText = String(args.focusText || "").trim().slice(0, 900);

  const payload = await apiClient.get("/api/files/preview", {
    sourceId,
    chunkId: args.chunkId,
    fileId: args.fileId,
    path: args.path,
    focusText
  });

  const relativePath = payload.relativePath
    || (payload.path ? String(payload.path).split(/[\\/]/).pop() : "");

  const excerptResult = truncateFields(
    { excerpt: payload.excerpt || payload.text || "" },
    ["excerpt"],
    maxChars
  );
  const markdownResult = truncateFields(
    { markdown: payload.markdown || "" },
    ["markdown"],
    maxChars
  );

  const truncated = Boolean(
    excerptResult.truncated
    || markdownResult.truncated
    || payload.truncated
    || payload.truncatedBefore
    || payload.truncatedAfter
  );

  return sanitizeValue({
    targetMatched: Boolean(payload.targetMatched),
    sourceId: payload.sourceId || sourceId,
    chunkId: payload.chunkId || args.chunkId || "",
    fileId: payload.fileId || args.fileId || "",
    label: payload.label || "",
    title: payload.title || "",
    relativePath,
    excerpt: excerptResult.record.excerpt,
    markdown: markdownResult.record.markdown,
    focus: payload.focus || null,
    truncated,
    truncatedBefore: Boolean(payload.truncatedBefore || excerptResult.truncated || markdownResult.truncated),
    truncatedAfter: Boolean(payload.truncatedAfter || excerptResult.truncated || markdownResult.truncated),
    evidenceMatched: Boolean(payload.evidenceMatched)
  });
}

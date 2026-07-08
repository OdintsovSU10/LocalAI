import path from "node:path";

const MAX_TOP_TYPES = 5;
const MAX_WARNING_FILES = 8;

function toIsoString(value) {
  if (value instanceof Date) return value.toISOString();
  const date = new Date(value || Date.now());
  return Number.isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString();
}

function sourceEntries(sourceId, manifest = {}) {
  return Object.values(manifest.files || {})
    .filter((entry) => entry?.sourceId === sourceId);
}

function extensionFor(entry = {}) {
  return path.extname(String(entry.path || entry.title || "")).toLowerCase() || "[no extension]";
}

function topFileTypes(entries = []) {
  const counts = new Map();
  for (const entry of entries) {
    const extension = extensionFor(entry);
    counts.set(extension, (counts.get(extension) || 0) + 1);
  }

  return Array.from(counts, ([extension, count]) => ({ extension, count }))
    .sort((left, right) => right.count - left.count || left.extension.localeCompare(right.extension))
    .slice(0, MAX_TOP_TYPES);
}

function warningLabel(warning) {
  return String(warning || "").trim();
}

function qualityWarningsSummary(entries = []) {
  const byWarning = new Map();
  const files = [];
  let total = 0;

  for (const entry of entries) {
    const warnings = Array.isArray(entry?.quality?.warnings)
      ? entry.quality.warnings.map(warningLabel).filter(Boolean)
      : [];
    if (!warnings.length && entry?.quality?.status !== "error") continue;

    const normalized = warnings.length ? [...new Set(warnings)] : ["quality_error"];
    for (const warning of normalized) {
      byWarning.set(warning, (byWarning.get(warning) || 0) + 1);
      total += 1;
    }

    if (files.length < MAX_WARNING_FILES) {
      files.push({
        fileId: entry.fileId || "",
        path: entry.path || "",
        title: path.basename(String(entry.path || entry.title || "")),
        status: entry?.quality?.status || "",
        score: Number.isFinite(Number(entry?.quality?.score)) ? Number(entry.quality.score) : null,
        warnings: normalized,
        recognitionMethod: entry?.recognition?.method || ""
      });
    }
  }

  return {
    total,
    byWarning: Array.from(byWarning, ([warning, count]) => ({ warning, count }))
      .sort((left, right) => right.count - left.count || left.warning.localeCompare(right.warning)),
    files
  };
}

function tenderRecognitionSummary(entries = []) {
  const tenderEntries = entries.filter((entry) => entry?.tenderRecognition?.sourceType === "tender");
  if (!tenderEntries.length) return null;

  const byDocumentType = new Map();
  let commercialProposals = 0;
  let priceSignalFiles = 0;
  let estimateSignalFiles = 0;

  for (const entry of tenderEntries) {
    const recognition = entry.tenderRecognition || {};
    const documentType = recognition.documentType || "tender_file";
    byDocumentType.set(documentType, (byDocumentType.get(documentType) || 0) + 1);
    if (recognition.isCommercialProposal) commercialProposals += 1;
    if (recognition.hasPriceSignals) priceSignalFiles += 1;
    if (recognition.hasEstimateSignals) estimateSignalFiles += 1;
  }

  return {
    files: tenderEntries.length,
    commercialProposals,
    priceSignalFiles,
    estimateSignalFiles,
    byDocumentType: Array.from(byDocumentType, ([documentType, count]) => ({ documentType, count }))
      .sort((left, right) => right.count - left.count || left.documentType.localeCompare(right.documentType))
  };
}

function sourceChunkCount(sourceId, chunks = [], entries = []) {
  const explicit = chunks.filter((chunk) => chunk?.sourceId === sourceId).length;
  if (explicit) return explicit;
  return entries.reduce((sum, entry) => sum + Number(entry?.quality?.chunks || entry?.chunks || 0), 0);
}

function deterministicSummaryText({ entries, chunkCount, warnings }) {
  const fileWord = entries.length === 1 ? "file" : "files";
  const chunkWord = chunkCount === 1 ? "chunk" : "chunks";
  const warningText = warnings.total
    ? `${warnings.total} quality warning${warnings.total === 1 ? "" : "s"}`
    : "no quality warnings";
  return `${entries.length} ${fileWord}, ${chunkCount} ${chunkWord}, ${warningText}.`;
}

export function buildSourceSummary({ source = {}, manifest = { files: {} }, chunks = [], now = new Date(), llmSummary = "" } = {}) {
  const sourceId = String(source.id || "");
  const entries = sourceEntries(sourceId, manifest);
  const chunkCount = sourceChunkCount(sourceId, chunks, entries);
  const qualityWarnings = qualityWarningsSummary(entries);
  const tenderRecognition = tenderRecognitionSummary(entries);

  const summary = {
    sourceId,
    sourceTitle: source.title || "",
    updatedAt: toIsoString(now),
    fileCount: entries.length,
    chunkCount,
    topFileTypes: topFileTypes(entries),
    qualityWarnings,
    deterministicSummary: deterministicSummaryText({ entries, chunkCount, warnings: qualityWarnings })
  };

  if (tenderRecognition) summary.tenderRecognition = tenderRecognition;
  if (llmSummary) summary.llmSummary = String(llmSummary);
  return summary;
}

import path from "node:path";

const MAX_TOP_TYPES = 5;
const MAX_WARNING_FILES = 8;
const QUALITY_STATUSES = new Set(["ok", "warning", "error", "unchecked"]);

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

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function percent(part, total) {
  const denominator = Number(total || 0);
  if (!denominator) return 0;
  return Math.max(0, Math.min(100, Math.round((Number(part || 0) / denominator) * 100)));
}

function average(values = []) {
  const numbers = values
    .map(finiteNumber)
    .filter((value) => value !== null);
  if (!numbers.length) return null;
  return Math.round(numbers.reduce((sum, value) => sum + value, 0) / numbers.length);
}

function entryChunkCount(entry = {}) {
  return Number(entry?.quality?.chunks ?? entry?.chunks ?? 0) || 0;
}

function entryQualityStatus(entry = {}) {
  return entry?.quality?.status || (entryChunkCount(entry) > 0 ? "unchecked" : "error");
}

function fallbackQualityScore(status, chunks) {
  if (status === "ok") return 100;
  if (status === "warning") return 70;
  if (status === "error") return 0;
  return chunks > 0 ? 80 : 0;
}

function isOcrRecognition(recognition = {}) {
  return /ocr/i.test(String(recognition.method || ""));
}

function recognitionQualitySummary(entries = []) {
  const files = {
    total: entries.length,
    searchable: 0,
    ok: 0,
    warning: 0,
    error: 0,
    unchecked: 0,
    withText: 0,
    textCoveragePercent: 0
  };
  const scoreValues = [];
  const charsValues = [];
  const wordsValues = [];
  const ocrConfidenceValues = [];
  const ocrP10Values = [];
  const ocr = {
    files: 0,
    pages: 0,
    totalPages: 0,
    coveragePercent: 0,
    avgConfidence: null,
    confidenceP10: null,
    limitedFiles: 0,
    lowConfidenceFiles: 0,
    lowConfidencePages: 0,
    emptyPages: 0
  };

  for (const entry of entries) {
    const quality = entry?.quality || {};
    const recognition = entry?.recognition || {};
    const chunks = entryChunkCount(entry);
    const status = entryQualityStatus(entry);
    const score = finiteNumber(quality.score);
    const chars = finiteNumber(quality.chars ?? recognition.chars);
    const words = finiteNumber(quality.words);
    const warnings = Array.isArray(quality.warnings) ? quality.warnings : [];

    if (QUALITY_STATUSES.has(status)) files[status] += 1;
    else files.unchecked += 1;
    if (chunks > 0) files.searchable += 1;
    if (chunks > 0 || Number(chars || 0) >= 80) files.withText += 1;
    scoreValues.push(score ?? fallbackQualityScore(status, chunks));
    if (chars !== null) charsValues.push(chars);
    if (words !== null) wordsValues.push(words);

    if (!isOcrRecognition(recognition)) continue;

    ocr.files += 1;
    const recognizedPages = finiteNumber(recognition.ocrRecognizedPages ?? recognition.ocrPages);
    const totalPages = finiteNumber(recognition.ocrTotalPages ?? recognition.pdfPages);
    if (recognizedPages !== null) ocr.pages += recognizedPages;
    if (totalPages !== null) ocr.totalPages += totalPages;
    if (recognition.ocrLimited) ocr.limitedFiles += 1;
    if (warnings.includes("low_ocr_confidence") || warnings.includes("low_ocr_page_confidence")) {
      ocr.lowConfidenceFiles += 1;
    }
    if (Array.isArray(recognition.ocrLowConfidencePages)) {
      ocr.lowConfidencePages += recognition.ocrLowConfidencePages.length;
    }
    if (Array.isArray(recognition.ocrEmptyPages)) {
      ocr.emptyPages += recognition.ocrEmptyPages.length;
    }
    const confidence = finiteNumber(recognition.ocrConfidence);
    if (confidence !== null) ocrConfidenceValues.push(confidence);
    const confidenceP10 = finiteNumber(recognition.ocrConfidenceP10);
    if (confidenceP10 !== null) ocrP10Values.push(confidenceP10);
  }

  files.textCoveragePercent = percent(files.searchable, files.total);
  ocr.coveragePercent = percent(ocr.pages, ocr.totalPages);
  ocr.avgConfidence = average(ocrConfidenceValues);
  ocr.confidenceP10 = average(ocrP10Values);

  const score = average(scoreValues) ?? 0;
  const status = !files.total
    ? "empty"
    : files.error > 0 || score < 60
      ? "error"
      : files.warning > 0 || files.unchecked > 0 || score < 85
        ? "warning"
        : "ok";

  return {
    status,
    score,
    files,
    text: {
      totalChars: charsValues.reduce((sum, value) => sum + value, 0),
      totalWords: wordsValues.reduce((sum, value) => sum + value, 0),
      avgChars: average(charsValues) ?? 0,
      avgWords: average(wordsValues) ?? 0
    },
    ocr
  };
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

function reindexSummary(entries = []) {
  const summary = {
    retriedFiles: 0,
    resolvedFiles: 0,
    unresolvedFiles: 0,
    failedFiles: 0,
    recoveredErrorFiles: 0,
    byReason: [],
    files: []
  };
  const byReason = new Map();

  for (const entry of entries) {
    const report = entry?.reindex || null;
    if (!report?.retried) continue;

    summary.retriedFiles += 1;
    if (report.status === "resolved") summary.resolvedFiles += 1;
    else if (report.status === "unresolved") summary.unresolvedFiles += 1;
    else if (report.status === "retry_failed") summary.failedFiles += 1;
    if ((report.reasons || []).includes("conversion_error")) summary.recoveredErrorFiles += 1;

    for (const reason of Array.isArray(report.reasons) ? report.reasons : []) {
      const key = warningLabel(reason);
      if (key) byReason.set(key, (byReason.get(key) || 0) + 1);
    }

    if (summary.files.length < MAX_WARNING_FILES) {
      summary.files.push({
        fileId: entry.fileId || "",
        path: entry.path || "",
        title: path.basename(String(entry.path || entry.title || "")),
        status: report.status || "",
        reasons: Array.isArray(report.reasons) ? report.reasons : [],
        finalReasons: Array.isArray(report.finalReasons) ? report.finalReasons : [],
        improved: Boolean(report.improved)
      });
    }
  }

  summary.byReason = Array.from(byReason, ([reason, count]) => ({ reason, count }))
    .sort((left, right) => right.count - left.count || left.reason.localeCompare(right.reason));
  return summary.retriedFiles ? summary : null;
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
  return entries.reduce((sum, entry) => sum + entryChunkCount(entry), 0);
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
  const recognitionQuality = recognitionQualitySummary(entries);
  const tenderRecognition = tenderRecognitionSummary(entries);
  const reindex = reindexSummary(entries);

  const summary = {
    sourceId,
    sourceTitle: source.title || "",
    updatedAt: toIsoString(now),
    fileCount: entries.length,
    chunkCount,
    topFileTypes: topFileTypes(entries),
    recognitionQuality,
    qualityWarnings,
    deterministicSummary: deterministicSummaryText({ entries, chunkCount, warnings: qualityWarnings })
  };

  if (tenderRecognition) summary.tenderRecognition = tenderRecognition;
  if (reindex) summary.reindex = reindex;
  if (llmSummary) summary.llmSummary = String(llmSummary);
  return summary;
}

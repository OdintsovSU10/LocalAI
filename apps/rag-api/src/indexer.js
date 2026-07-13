import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { convertToMarkdownWithReport, converterStatus, supportedExtensions, textQualityReport } from "./converters.js";
import { indexLockPath, markdownCacheDir } from "./paths.js";
import { chunkMarkdown, normalizeText, tokenize } from "./text.js";
import { readChunks, readManifest, writeChunks, writeManifest, writeSourceSummary } from "./store.js";
import { ensureChunkEmbeddings } from "./embeddings.js";
import { matchesExclude, matchesInclude } from "./path-filter.js";
import { indexedRelativePath, indexRootsForSource } from "./source-index-roots.js";
import { buildSourceSummary } from "./source-summary.js";
import { publicContextLinks } from "./context-links.js";
import { fetchGoogleContextMarkdown, googleContextVirtualPath } from "./google-context.js";
import { googleAuthCanFetch, googleAuthFetch } from "./google-auth.js";
import { recognizeTenderDocument, tenderChunkMetadata } from "./tender-recognition.js";
import {
  createReindexReport,
  createReindexStats,
  qualityReindexDecision,
  reindexOrchestratorSettings,
  updateReindexStats
} from "./reindex-orchestrator.js";

const INDEX_LOCK_STALE_MS = 6 * 60 * 60 * 1000;
const INDEX_LOCK_WAIT_MS = 1000;

function sha1(value) {
  return crypto.createHash("sha1").update(value).digest("hex");
}

function stableFileId(sourceId, filePath) {
  return sha1(`${sourceId}:${filePath.toLowerCase()}`);
}

function stableGoogleContextFileId(sourceId, link) {
  return stableFileId(sourceId, `google-context:${link.id || link.url || link.title || ""}`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function lockStaleMs() {
  const value = Number(process.env.RAG_INDEX_LOCK_STALE_MS || INDEX_LOCK_STALE_MS);
  return Number.isFinite(value) && value > 0 ? value : INDEX_LOCK_STALE_MS;
}

async function readIndexLock(lockPath) {
  try {
    return JSON.parse(await fs.readFile(lockPath, "utf8"));
  } catch {
    return null;
  }
}

function lockOwnerIsAlive(pid) {
  const ownerPid = Number(pid);
  if (!Number.isInteger(ownerPid) || ownerPid <= 0) return null;
  if (ownerPid === process.pid) return true;

  try {
    process.kill(ownerPid, 0);
    return true;
  } catch (error) {
    if (error.code === "ESRCH") return false;
    if (error.code === "EPERM") return true;
    return null;
  }
}

async function acquireIndexLock(onWait = () => {}, options = {}) {
  const lockPath = indexLockPath();
  let waitNotified = false;
  const signal = options.signal || null;

  while (true) {
    throwIfAborted(signal);
    try {
      await fs.mkdir(path.dirname(lockPath), { recursive: true });
      const handle = await fs.open(lockPath, "wx");
      await handle.writeFile(JSON.stringify({
        createdAt: new Date().toISOString(),
        pid: process.pid
      }, null, 2), "utf8");
      const heartbeat = setInterval(() => {
        const now = new Date();
        fs.utimes(lockPath, now, now).catch(() => {});
      }, 60_000);
      heartbeat.unref?.();

      return async () => {
        clearInterval(heartbeat);
        await handle.close().catch(() => {});
        await fs.rm(lockPath, { force: true }).catch(() => {});
      };
    } catch (error) {
      if (error.code !== "EEXIST") throw error;

      try {
        const lock = await readIndexLock(lockPath);
        if (lockOwnerIsAlive(lock?.pid) === false) {
          await fs.rm(lockPath, { force: true });
          continue;
        }

        const stat = await fs.stat(lockPath);
        if (Date.now() - stat.mtimeMs > lockStaleMs()) {
          await fs.rm(lockPath, { force: true });
          continue;
        }
      } catch (statError) {
        if (statError.code !== "ENOENT") throw statError;
      }

      if (!waitNotified) {
        waitNotified = true;
        onWait();
      }
      await sleep(INDEX_LOCK_WAIT_MS);
      throwIfAborted(signal);
    }
  }
}

function throwIfAborted(signal) {
  if (!signal?.aborted) return;
  const error = new Error("Индексация остановлена");
  error.name = "AbortError";
  throw error;
}

function isAbortError(error, signal) {
  return signal?.aborted || error?.name === "AbortError" || /aborted|cancelled|остановлена/i.test(String(error?.message || ""));
}

function createScanStats() {
  return {
    totalFiles: 0,
    eligibleFiles: 0,
    unsupportedFiles: 0,
    temporaryFiles: 0,
    excludedFiles: 0,
    includedFiles: 0,
    excludedByInclude: 0,
    excludedByExclude: 0,
    directories: 0,
    unreadableDirectories: 0,
    unsupportedByExt: {},
    scanErrors: []
  };
}

function relativeFilterPath(root, filePath) {
  return (path.relative(root, filePath) || path.basename(filePath)).replaceAll("\\", "/");
}

async function* walk(root, stats, source, relativeRoot = "") {
  let entries;
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch (error) {
    stats.unreadableDirectories += 1;
    stats.scanErrors.push({ path: root, message: error.message });
    return;
  }

  for (const entry of entries) {
    const fullPath = path.join(root, entry.name);
    const relativePath = relativeRoot ? `${relativeRoot}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      stats.directories += 1;
      if (matchesExclude(relativePath, source?.exclude)) continue;
      yield* walk(fullPath, stats, source, relativePath);
    } else if (entry.isFile()) {
      yield fullPath;
    }
  }
}

function isTemporaryOfficeFile(filePath) {
  return path.basename(filePath).startsWith("~$");
}

function classifyFile(filePath, source, stats, root) {
  stats.totalFiles += 1;
  const relativePath = indexedRelativePath(source, filePath, root);

  if (isTemporaryOfficeFile(filePath)) {
    stats.temporaryFiles += 1;
    return { eligible: false, reason: "temporary" };
  }

  if (matchesExclude(relativePath, source.exclude)) {
    stats.excludedFiles += 1;
    stats.excludedByExclude += 1;
    return { eligible: false, reason: "excluded" };
  }

  if (!matchesInclude(relativePath, source.include)) {
    stats.excludedFiles += 1;
    stats.excludedByInclude += 1;
    return { eligible: false, reason: "excluded" };
  }

  stats.includedFiles += 1;

  const ext = path.extname(filePath).toLowerCase() || "[no extension]";
  if (!supportedExtensions.has(ext)) {
    stats.unsupportedFiles += 1;
    stats.unsupportedByExt[ext] = (stats.unsupportedByExt[ext] || 0) + 1;
    return { eligible: false, reason: "unsupported" };
  }

  stats.eligibleFiles += 1;
  return { eligible: true };
}

function skippedFileEntry(root, filePath, classification) {
  return {
    path: filePath,
    relativePath: path.relative(root, filePath) || path.basename(filePath),
    title: path.basename(filePath),
    extension: path.extname(filePath).toLowerCase() || "[no extension]",
    reason: classification.reason
  };
}

export async function scanSkippedFiles(source) {
  const roots = indexRootsForSource(source);
  if (!roots.length) throw new Error("source path is required");

  const stats = createScanStats();
  const skippedFiles = [];
  let eligibleTotal = 0;

  for (const root of roots) {
    await fs.access(root);
    for await (const filePath of walk(root, stats, source)) {
      const classification = classifyFile(filePath, source, stats, root);
      if (classification.eligible) {
        eligibleTotal += 1;
      } else {
        skippedFiles.push(skippedFileEntry(root, filePath, classification));
      }
    }
  }

  return {
    sourceId: source.id,
    sourceTitle: source.title,
    scannedAt: new Date().toISOString(),
    eligibleTotal,
    skippedTotal: skippedFiles.length,
    skippedFiles,
    ...stats
  };
}

function frontMatter(source, filePath, stat, recognition = null) {
  const lines = [
    "---",
    `source_id: ${JSON.stringify(source.id)}`,
    `source_title: ${JSON.stringify(source.title)}`,
    `source_path: ${JSON.stringify(filePath)}`,
    `source_mtime: ${JSON.stringify(stat.mtime.toISOString())}`,
    `source_size: ${stat.size}`,
    `indexed_at: ${JSON.stringify(new Date().toISOString())}`
  ];

  // Recorded so ocrCacheNeedsRefresh() can tell that a cached markdown was produced
  // with a different OCR configuration (e.g. a lower render scale) and must be redone.
  if (recognition?.method) lines.push(`recognition_method: ${JSON.stringify(String(recognition.method))}`);
  if (Number.isFinite(Number(recognition?.ocrScale))) lines.push(`recognition_scale: ${Number(recognition.ocrScale)}`);
  if (recognition?.ocrLangs) lines.push(`recognition_langs: ${JSON.stringify(String(recognition.ocrLangs))}`);

  lines.push("---", "");
  return lines.join("\n");
}

function stripFrontMatter(markdown) {
  return String(markdown || "").replace(/^---\n[\s\S]*?\n---\n?/, "");
}

function parseCacheFrontMatter(markdown) {
  const match = String(markdown || "").match(/^---\n([\s\S]*?)\n---\n?/);
  if (!match) return {};

  const metadata = {};
  for (const line of match[1].split(/\n/)) {
    const separator = line.indexOf(":");
    if (separator <= 0) continue;
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();
    if (!key) continue;
    try {
      metadata[key] = JSON.parse(value);
    } catch {
      metadata[key] = value;
    }
  }
  return metadata;
}

function cacheMatchesFile(metadata, filePath, stat) {
  return metadata?.source_path === filePath
    && String(metadata?.source_mtime || "") === stat.mtime.toISOString()
    && Number(metadata?.source_size) === stat.size;
}

export function ocrCacheNeedsRefresh(markdown, status = converterStatus(), cacheMetadata = {}) {
  const text = String(markdown || "");
  if (!status?.builtinOcr?.enabled) return false;

  // A cache produced at a different render scale is stale: re-OCR it at the current one.
  // Caches written before the scale was recorded carry no marker, so they are stale too.
  if (text.includes("## OCR page ")) {
    const currentScale = Number(status.builtinOcr.scale);
    const cachedScale = Number(cacheMetadata?.recognition_scale);
    if (Number.isFinite(currentScale) && cachedScale !== currentScale) return true;
  }

  const limitMatch = text.match(/Recognized\s+(\d+)\s+of\s+(\d+)\s+pages/i);
  if (!limitMatch) return false;

  const cachedPages = Number(limitMatch[1]);
  const totalPages = Number(limitMatch[2]);
  const currentMaxPages = Number(status.builtinOcr.maxPages);
  if (!Number.isFinite(cachedPages) || !Number.isFinite(totalPages) || cachedPages >= totalPages) return false;

  return currentMaxPages === 0 || currentMaxPages > cachedPages;
}

function documentTypeForPath(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".markdown") return "md";
  return ext.replace(".", "") || "unknown";
}

function baseChunkMetadata(filePath, recognition = {}, extraMetadata = {}) {
  const documentType = recognition.documentType || documentTypeForPath(filePath);
  const metadata = { documentType, ...extraMetadata };
  const totalPages = Number(recognition.pdfPages || recognition.ocrTotalPages || 0);
  if (documentType === "pdf" && Number.isFinite(totalPages) && totalPages > 0) {
    metadata.totalPages = totalPages;
  }
  return metadata;
}

function indexRootForFile(source, filePath) {
  const resolvedFile = path.resolve(String(filePath || ""));
  const roots = indexRootsForSource(source);
  return roots.find((root) => {
    const relative = path.relative(path.resolve(root), resolvedFile);
    return !relative || (!relative.startsWith("..") && !path.isAbsolute(relative));
  }) || roots[0] || path.dirname(resolvedFile);
}

function indexedRelativePathForFile(source, filePath) {
  return indexedRelativePath(source, filePath, indexRootForFile(source, filePath));
}

function currentFileProgress(source, filePath, extra = {}) {
  return {
    currentFileTitle: path.basename(filePath),
    currentFileRelativePath: indexedRelativePathForFile(source, filePath),
    currentFileExtension: path.extname(filePath).toLowerCase() || "",
    ...extra
  };
}

function googleContextLinksForSource(source) {
  return publicContextLinks(source);
}

function googleContextCacheFile(sourceId, fileId) {
  return path.join(markdownCacheDir(), sourceId, `${fileId}.md`);
}

function googleContextStat(markdown, indexedAt = new Date()) {
  return {
    mtime: indexedAt,
    mtimeMs: indexedAt.getTime(),
    size: Buffer.byteLength(String(markdown || ""), "utf8")
  };
}

function googleContextFailureQuality(reason) {
  const quality = verifyIndexedMarkdown("", [], {
    method: "google-context-error",
    documentType: "google-context"
  });
  return {
    ...quality,
    status: "error",
    warnings: [...new Set([...(quality.warnings || []), reason].filter(Boolean))]
  };
}

function conversionFailureQuality(reason) {
  const quality = verifyIndexedMarkdown("", [], { method: "conversion-error" });
  return {
    ...quality,
    status: "error",
    chunks: 0,
    warnings: [...new Set([...(quality.warnings || []), reason].filter(Boolean))]
  };
}

// A file whose conversion threw gets a manifest entry anyway. Without one the prune loop
// keeps the previous run's entry (fileId is already in seenFileIds) while its chunks are
// gone — the file then looks indexed but is unsearchable, and the UI shows no reason at all.
async function conversionFailureEntry({ source, fileId, filePath, existing, error }) {
  const message = String(error?.message || error || "Не удалось обработать файл");
  const recognition = {
    method: "conversion-error",
    documentType: documentTypeForPath(filePath),
    chars: 0,
    errorMessage: message
  };

  let relativePath = filePath;
  try {
    relativePath = indexedRelativePathForFile(source, filePath);
  } catch {
    relativePath = existing?.relativePath || filePath;
  }

  // The stat may itself be what failed (locked or deleted file).
  let stat = null;
  try {
    stat = await fs.stat(filePath);
  } catch {
    stat = null;
  }

  // Drop the stale markdown cache: otherwise the next run sees matching mtime/size plus old
  // markdown, treats the file as unchanged, and silently resurrects the previous success.
  await removeMarkdownCacheFile(path.join(markdownCacheDir(), source.id, `${fileId}.md`));
  if (existing?.cacheFile) await removeMarkdownCacheFile(existing.cacheFile);

  return {
    fileId,
    sourceId: source.id,
    sourceTitle: source.title,
    path: filePath,
    relativePath,
    title: path.basename(filePath),
    extension: path.extname(filePath).toLowerCase() || "",
    cacheFile: "",
    mtimeMs: stat?.mtimeMs ?? existing?.mtimeMs ?? 0,
    size: stat?.size ?? existing?.size ?? 0,
    indexedAt: new Date().toISOString(),
    recognition,
    quality: conversionFailureQuality("conversion_error")
  };
}

function googleContextManifestEntry({ source, link, fileId, filePath, cacheFile, stat, recognition, tenderRecognition, quality, indexedAt }) {
  return {
    fileId,
    sourceId: source.id,
    sourceTitle: source.title,
    path: filePath,
    relativePath: filePath,
    title: link.title || path.basename(filePath),
    extension: path.extname(filePath).toLowerCase() || "",
    origin: "google-context",
    contextLinkId: link.id || "",
    cacheFile,
    mtimeMs: stat.mtimeMs,
    size: stat.size,
    indexedAt: indexedAt.toISOString(),
    recognition,
    tenderRecognition,
    quality
  };
}

function normalizeChunkRecord(chunk) {
  if (typeof chunk === "string") return { text: chunk, metadata: {} };
  const { text, ...metadata } = chunk || {};
  return {
    text: String(text || ""),
    metadata: Object.fromEntries(
      Object.entries(metadata).filter(([, value]) => value !== undefined && value !== null && value !== "")
    )
  };
}

async function readableCachePath(paths) {
  for (const cachePath of paths.filter(Boolean)) {
    try {
      await fs.access(cachePath);
      return cachePath;
    } catch {
      // Try the next known cache location.
    }
  }
  return "";
}

async function clearSourceMarkdownCache(sourceId) {
  const cacheRoot = path.resolve(markdownCacheDir());
  const cacheTarget = path.resolve(cacheRoot, String(sourceId || ""));
  const relative = path.relative(cacheRoot, cacheTarget);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("Unsafe markdown cache path");
  }
  await fs.rm(cacheTarget, { recursive: true, force: true });
}

async function removeMarkdownCacheFile(cacheFile) {
  if (!cacheFile) return;
  const cacheRoot = path.resolve(markdownCacheDir());
  const cacheTarget = path.resolve(String(cacheFile || ""));
  const relative = path.relative(cacheRoot, cacheTarget);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) return;
  await fs.rm(cacheTarget, { force: true }).catch(() => {});
}

function countMatches(text, pattern) {
  return String(text || "").match(pattern)?.length || 0;
}

function inferRecognition(filePath, markdown, existing = null) {
  const ext = path.extname(filePath).toLowerCase();
  const limitMatch = markdown.match(/Recognized\s+(\d+)\s+of\s+(\d+)\s+pages/i);
  if (existing?.method) {
    if ((existing.method === "ocr" || existing.method === "ocr-cache") && limitMatch && !existing.ocrTotalPages) {
      return {
        ...existing,
        ocrPages: Number(existing.ocrPages || limitMatch[1]),
        ocrTotalPages: Number(limitMatch[2]),
        ocrLimited: true
      };
    }
    return existing;
  }

  if (ext === ".pdf" && markdown.includes("## OCR page ")) {
    const ocrPages = countMatches(markdown, /^## OCR page \d+/gm);
    const ocrTotalPages = limitMatch ? Number(limitMatch[2]) : null;
    return {
      method: "ocr-cache",
      chars: markdown.length,
      ocrPages,
      ocrTotalPages,
      ocrRecognizedPages: ocrPages,
      ocrLimited: Boolean(limitMatch) || markdown.includes("## OCR status")
    };
  }

  return {
    method: ext.replace(".", "") || "unknown",
    chars: markdown.length
  };
}

function verifyIndexedMarkdown(markdown, chunks, recognition = {}) {
  const text = String(markdown || "").trim();
  const textQuality = textQualityReport(text);
  const chars = text.length;
  const letters = countMatches(text, /\p{L}/gu);
  const words = countMatches(text, /[\p{L}\p{N}]{2,}/gu);
  const replacementChars = countMatches(text, /\uFFFD/g);
  const letterRatio = chars ? letters / chars : 0;
  const replacementRatio = chars ? replacementChars / chars : 0;
  const warnings = [...textQuality.warnings];

  if (!chunks.length) warnings.push("no_chunks");
  if (chars < 120) warnings.push("too_little_text");
  if (words < 25) warnings.push("too_few_words");
  if (chars >= 120 && letterRatio < 0.2) warnings.push("low_text_density");
  if (replacementRatio > 0.01) warnings.push("encoding_noise");
  if (recognition.ocrLimited) warnings.push("ocr_limited");
  if (Number.isFinite(Number(recognition.ocrConfidence)) && Number(recognition.ocrConfidence) < 50) {
    warnings.push("low_ocr_confidence");
  }
  if (Array.isArray(recognition.ocrLowConfidencePages) && recognition.ocrLowConfidencePages.length) {
    warnings.push("low_ocr_page_confidence");
  }
  if (Array.isArray(recognition.ocrEmptyPages) && recognition.ocrEmptyPages.length) {
    warnings.push("empty_ocr_pages");
  }
  if (Array.isArray(recognition.ocrRejectedPages) && recognition.ocrRejectedPages.length) {
    warnings.push("ocr_rejected_pages");
  }
  if (Number(recognition.ocrAcceptedPages) === 0 && Number(recognition.ocrRawRecognizedPages) > 0) {
    warnings.push("no_usable_ocr_pages");
  }
  if (Array.isArray(recognition.ocrFailedPages) && recognition.ocrFailedPages.length) {
    warnings.push("ocr_failed_pages");
  }
  if (recognition.method === "conversion-error") warnings.push("conversion_error");
  if (recognition.selectedPdfText === "text-layer" && recognition.textLayerQuality?.warnings?.includes("encoding_noise")) {
    warnings.push("pdf_text_layer_noise");
  }
  if (recognition.selectedPdfText === "text-layer" && recognition.textLayerQuality?.warnings?.includes("ocr_text_noise")) {
    warnings.push("pdf_text_layer_noise");
  }
  if (recognition.method === "pdf-empty") warnings.push("empty_pdf_text");

  const uniqueWarnings = [...new Set(warnings)];
  const hasSevereRecognitionNoise = uniqueWarnings.includes("ocr_text_noise") || uniqueWarnings.includes("pdf_text_layer_noise");
  const status = !chunks.length || chars < 80 || hasSevereRecognitionNoise ? "error" : uniqueWarnings.length ? "warning" : "ok";
  let score = 100;
  if (uniqueWarnings.includes("ocr_limited")) score -= 15;
  if (uniqueWarnings.includes("low_ocr_confidence")) score -= 25;
  if (uniqueWarnings.includes("low_ocr_page_confidence")) score -= 15;
  if (uniqueWarnings.includes("empty_ocr_pages")) score -= 10;
  if (uniqueWarnings.includes("ocr_rejected_pages")) score -= 15;
  if (uniqueWarnings.includes("no_usable_ocr_pages")) score -= 35;
  if (uniqueWarnings.includes("ocr_failed_pages")) score -= 20;
  if (uniqueWarnings.includes("pdf_text_layer_noise")) score -= 20;
  if (uniqueWarnings.includes("ocr_text_noise")) score -= 35;
  if (uniqueWarnings.includes("low_text_density")) score -= 20;
  if (uniqueWarnings.includes("encoding_noise")) score -= 25;
  if (uniqueWarnings.includes("too_little_text")) score -= 30;
  if (uniqueWarnings.includes("too_few_words")) score -= 20;
  if (uniqueWarnings.includes("no_chunks")) score = 0;

  return {
    status,
    score: Math.max(0, Math.min(100, score)),
    warnings: uniqueWarnings,
    chars,
    words,
    chunks: chunks.length,
    letterRatio: Number(letterRatio.toFixed(3)),
    noiseRatio: textQuality.noiseRatio,
    noisyTokens: textQuality.noisyTokens,
    checkedAt: new Date().toISOString()
  };
}

export function shouldSuppressChunksForQuality(quality = {}) {
  const warnings = new Set(Array.isArray(quality.warnings) ? quality.warnings : []);
  // no_usable_ocr_pages is deliberately absent: the OCR text is salvaged and kept searchable
  // (see ocrPdfToMarkdown), because an unsearchable file is worse than a noisy one.
  return warnings.has("ocr_text_noise") || warnings.has("pdf_text_layer_noise");
}

function suppressChunksForQuality(chunks, quality) {
  if (!chunks.length || !shouldSuppressChunksForQuality(quality)) return { chunks, quality };
  return {
    chunks: [],
    quality: {
      ...quality,
      status: "error",
      chunks: 0,
      skippedChunks: chunks.length,
      warnings: [...new Set([...(quality.warnings || []), "chunks_skipped_for_quality"])]
    }
  };
}

async function indexSourceUnlocked(source, onProgress = () => {}, options = {}) {
  const startedAt = new Date().toISOString();
  const roots = indexRootsForSource(source);
  if (!roots.length) throw new Error("source path is required");
  const force = Boolean(options.force);
  const signal = options.signal || null;
  throwIfAborted(signal);
  for (const root of roots) {
    await fs.access(root);
    throwIfAborted(signal);
  }

  const manifest = await readManifest();
  const allChunks = await readChunks();
  const retainedChunks = allChunks.filter((chunk) => chunk.sourceId !== source.id);
  const sourceChunks = [];
  const seenFileIds = new Set();
  const files = [];
  const skippedFiles = [];
  const scanStats = createScanStats();

  onProgress({ phase: "scan", message: "Сканирование папки" });

  if (force) {
    onProgress({ phase: "cleanup", message: "Очистка кэша индекса" });
    throwIfAborted(signal);
    await clearSourceMarkdownCache(source.id);
  }

  for (const root of roots) {
    for await (const filePath of walk(root, scanStats, source)) {
      throwIfAborted(signal);
      const classification = classifyFile(filePath, source, scanStats, root);
      if (classification.eligible) {
        files.push(filePath);
      } else {
        skippedFiles.push(skippedFileEntry(root, filePath, classification));
      }
    }
  }

  const googleContextLinks = googleContextLinksForSource(source);
  const totalItems = files.length + googleContextLinks.length;

  onProgress({
    phase: "scan",
    message: "Сканирование завершено",
    processed: 0,
    total: totalItems,
    googleContextLinks: googleContextLinks.length,
    ...scanStats
  });

  let processed = 0;
  let cached = 0;
  let failed = 0;
  const errors = [];
  const reindexSettings = reindexOrchestratorSettings();
  const reindex = createReindexStats();

  async function persistPartialManifest() {
    await writeManifest(manifest);
  }

  for (const filePath of files) {
    throwIfAborted(signal);
    const fileId = stableFileId(source.id, filePath);
    seenFileIds.add(fileId);
    processed += 1;
    const fileProgress = currentFileProgress(source, filePath);

    try {
      const stat = await fs.stat(filePath);
      const existing = manifest.files[fileId];
      const cacheFile = path.join(markdownCacheDir(), source.id, `${fileId}.md`);
      const sourceCacheFile = await readableCachePath([cacheFile, existing?.cacheFile]);
      let cacheMetadata = {};
      let cachedMarkdown = "";
      if (sourceCacheFile) {
        const rawCache = await fs.readFile(sourceCacheFile, "utf8");
        cacheMetadata = parseCacheFrontMatter(rawCache);
        cachedMarkdown = stripFrontMatter(rawCache);
      }
      const unchanged = !force
        && sourceCacheFile
        && cachedMarkdown.trim()
        && !ocrCacheNeedsRefresh(cachedMarkdown, converterStatus(), cacheMetadata)
        && (
          (existing && existing.mtimeMs === stat.mtimeMs && existing.size === stat.size)
          || cacheMatchesFile(cacheMetadata, filePath, stat)
        );

      let markdown;
      let recognition;
      let manifestEntry = existing || {};
      if (unchanged) {
        cached += 1;
        markdown = cachedMarkdown;
        recognition = inferRecognition(filePath, markdown, existing?.recognition);
        manifestEntry = { ...existing, cacheFile };
      } else {
        onProgress({
          phase: "convert",
          message: `Конвертация: ${path.basename(filePath)}`,
          processed,
          total: totalItems,
          cached,
          failed,
          googleContextLinks: googleContextLinks.length,
          ...fileProgress,
          ...scanStats
        });
        const converted = await convertToMarkdownWithReport(filePath, {
          signal,
          onProgress: (progress) => onProgress({
            ...progress,
            processed,
            total: totalItems,
            cached,
            failed,
            googleContextLinks: googleContextLinks.length,
            ...fileProgress,
            ...scanStats
          })
        });
        throwIfAborted(signal);
        markdown = converted.markdown;
        recognition = inferRecognition(filePath, markdown, converted.recognition);
        await fs.mkdir(path.dirname(cacheFile), { recursive: true });
        await fs.writeFile(cacheFile, `${frontMatter(source, filePath, stat, recognition)}${markdown}\n`, "utf8");

        manifestEntry = {
          fileId,
          sourceId: source.id,
          sourceTitle: source.title,
          path: filePath,
          cacheFile,
          mtimeMs: stat.mtimeMs,
          size: stat.size,
          indexedAt: new Date().toISOString()
        };
      }

      let relativePath = indexedRelativePathForFile(source, filePath);
      let tenderRecognition = recognizeTenderDocument({ source, filePath, relativePath, markdown });
      let chunks = chunkMarkdown(
        markdown,
        1800,
        220,
        baseChunkMetadata(filePath, recognition, tenderChunkMetadata(tenderRecognition))
      );
      let quality = verifyIndexedMarkdown(markdown, chunks, recognition);
      ({ chunks, quality } = suppressChunksForQuality(chunks, quality));
      let reindexReport = null;
      const decision = qualityReindexDecision({
        quality,
        fromCache: Boolean(unchanged),
        attempt: 0,
        settings: reindexSettings
      });

      if (decision.queued) {
        reindex.queued += 1;
        const initialQuality = quality;
        const startedAt = new Date();
        try {
          await removeMarkdownCacheFile(cacheFile);
          await removeMarkdownCacheFile(sourceCacheFile);
          onProgress({
            phase: "reindex",
            message: `Reindex: ${path.basename(filePath)}`,
            processed,
            total: totalItems,
            cached,
            failed,
            reindexQueued: reindex.queued,
            reindexRetried: reindex.retried,
            reindexResolved: reindex.resolved,
            reindexUnresolved: reindex.unresolved,
            reindexFailed: reindex.failed,
            googleContextLinks: googleContextLinks.length,
            ...fileProgress,
            ...scanStats
          });
          const converted = await convertToMarkdownWithReport(filePath, {
            refreshRecognitionCache: true,
            signal,
            onProgress: (progress) => onProgress({
              ...progress,
              processed,
              total: totalItems,
              cached,
              failed,
              reindexQueued: reindex.queued,
              reindexRetried: reindex.retried,
              reindexResolved: reindex.resolved,
              reindexUnresolved: reindex.unresolved,
              reindexFailed: reindex.failed,
              googleContextLinks: googleContextLinks.length,
              ...fileProgress,
              ...scanStats
            })
          });
          throwIfAborted(signal);
          markdown = converted.markdown;
          recognition = inferRecognition(filePath, markdown, converted.recognition);
          await fs.mkdir(path.dirname(cacheFile), { recursive: true });
          await fs.writeFile(cacheFile, `${frontMatter(source, filePath, stat, recognition)}${markdown}\n`, "utf8");
          manifestEntry = {
            fileId,
            sourceId: source.id,
            sourceTitle: source.title,
            path: filePath,
            cacheFile,
            mtimeMs: stat.mtimeMs,
            size: stat.size,
            indexedAt: new Date().toISOString()
          };

          relativePath = indexedRelativePathForFile(source, filePath);
          tenderRecognition = recognizeTenderDocument({ source, filePath, relativePath, markdown });
          chunks = chunkMarkdown(
            markdown,
            1800,
            220,
            baseChunkMetadata(filePath, recognition, tenderChunkMetadata(tenderRecognition))
          );
          quality = verifyIndexedMarkdown(markdown, chunks, recognition);
          ({ chunks, quality } = suppressChunksForQuality(chunks, quality));
          reindexReport = createReindexReport({
            decision,
            initialQuality,
            finalQuality: quality,
            fromCache: Boolean(unchanged),
            startedAt,
            finishedAt: new Date(),
            settings: reindexSettings
          });
          if (unchanged) cached = Math.max(0, cached - 1);
        } catch (retryError) {
          if (isAbortError(retryError, signal)) throw retryError;
          reindexReport = createReindexReport({
            decision,
            initialQuality,
            finalQuality: initialQuality,
            fromCache: Boolean(unchanged),
            error: retryError.message,
            startedAt,
            finishedAt: new Date(),
            settings: reindexSettings
          });
          errors.push({ path: filePath, message: `Quality reindex failed: ${retryError.message}` });
        }
        updateReindexStats(reindex, reindexReport);
      }

      manifest.files[fileId] = {
        ...manifestEntry,
        fileId,
        sourceId: source.id,
        sourceTitle: source.title,
        path: filePath,
        relativePath,
        cacheFile,
        mtimeMs: stat.mtimeMs,
        size: stat.size,
        recognition,
        tenderRecognition,
        quality,
        ...(reindexReport ? { reindex: reindexReport } : {})
      };
      chunks.forEach((chunk, chunkIndex) => {
        const chunkRecord = normalizeChunkRecord(chunk);
        sourceChunks.push({
          id: `${fileId}:${chunkIndex}`,
          fileId,
          sourceId: source.id,
          sourceTitle: source.title,
          path: filePath,
          relativePath,
          title: path.basename(filePath),
          chunkIndex,
          ...chunkRecord.metadata,
          metadata: chunkRecord.metadata,
          text: chunkRecord.text,
          terms: tokenize(chunkRecord.text)
        });
      });
      await persistPartialManifest();
    } catch (error) {
      if (isAbortError(error, signal)) throw error;
      failed += 1;
      errors.push({ path: filePath, message: error.message });

      try {
        manifest.files[fileId] = await conversionFailureEntry({
          source,
          fileId,
          filePath,
          existing: manifest.files[fileId],
          error
        });
        await persistPartialManifest();
      } catch (entryError) {
        errors.push({ path: filePath, message: `Не удалось записать отказ в манифест: ${entryError.message}` });
      }
    }

    onProgress({
      phase: "index",
      message: "Индексация",
      processed,
      total: totalItems,
      cached,
      skipped: cached,
      failed,
      reindexQueued: reindex.queued,
      reindexRetried: reindex.retried,
      reindexResolved: reindex.resolved,
      reindexUnresolved: reindex.unresolved,
      reindexFailed: reindex.failed,
      googleContextLinks: googleContextLinks.length,
      ...fileProgress,
      ...scanStats
    });
  }

  for (const link of googleContextLinks) {
    throwIfAborted(signal);
    const fileId = stableGoogleContextFileId(source.id, link);
    seenFileIds.add(fileId);
    processed += 1;

    const initialTitle = link.title || "Google context";
    let filePath = googleContextVirtualPath(link, ".google");
    let currentGoogleTitle = initialTitle;
    const cacheFile = googleContextCacheFile(source.id, fileId);
    const indexedAt = new Date();
    const googleFileProgress = () => ({
      currentFileTitle: currentGoogleTitle || path.basename(filePath),
      currentFileRelativePath: filePath,
      currentFileExtension: path.extname(filePath).toLowerCase() || ".google"
    });

    try {
      onProgress({
        phase: "google-context",
        message: `Google context: ${initialTitle}`,
        processed,
        total: totalItems,
        cached,
        failed,
        currentGoogleContextLinkId: link.id || "",
        currentGoogleContextTitle: initialTitle,
        googleContextLinks: googleContextLinks.length,
        ...googleFileProgress(),
        ...scanStats
      });

      const sessionFetch = options.googleContextSessionFetch || null;
      const fetched = await fetchGoogleContextMarkdown(link, {
        fetchImpl: sessionFetch || options.googleContextFetch || options.fetchImpl,
        authFetchImpl: sessionFetch ? null : options.googleContextAuthFetch || (
          googleAuthCanFetch() && !options.googleContextFetch ? googleAuthFetch : null
        )
      });
      throwIfAborted(signal);

      if (!fetched.ok) {
        failed += 1;
        const reason = fetched.reason || "google_context_fetch_failed";
        const failureMarkdown = normalizeText(`# ${initialTitle}\n\nGoogle context link was not indexed: ${reason}.`);
        const stat = googleContextStat(failureMarkdown, indexedAt);
        const recognition = {
          method: "google-context-error",
          documentType: "google-context",
          errorReason: reason,
          errorMessage: fetched.message || "",
          chars: 0
        };
        const tenderRecognition = recognizeTenderDocument({
          source,
          filePath,
          relativePath: filePath,
          markdown: failureMarkdown
        });
        const quality = googleContextFailureQuality(reason);

        await fs.mkdir(path.dirname(cacheFile), { recursive: true });
        await fs.writeFile(cacheFile, `${frontMatter(source, filePath, stat)}${failureMarkdown}\n`, "utf8");
        manifest.files[fileId] = googleContextManifestEntry({
          source,
          link,
          fileId,
          filePath,
          cacheFile,
          stat,
          recognition,
          tenderRecognition,
          quality,
          indexedAt
        });
        errors.push({ path: filePath, message: fetched.message || "Google context link was not indexed" });
        skippedFiles.push({
          path: filePath,
          relativePath: filePath,
          title: initialTitle,
          extension: path.extname(filePath).toLowerCase() || "",
          reason
        });
        await persistPartialManifest();
        continue;
      }

      const linkWithTitle = { ...link, title: fetched.title || initialTitle };
      currentGoogleTitle = linkWithTitle.title || initialTitle;
      filePath = googleContextVirtualPath(linkWithTitle, fetched.extension || ".google");
      const markdown = fetched.markdown;
      const stat = googleContextStat(markdown, indexedAt);
      const recognition = fetched.recognition || {
        method: "google-context",
        documentType: "google-context",
        chars: markdown.length
      };
      const tenderRecognition = recognizeTenderDocument({
        source,
        filePath,
        relativePath: filePath,
        markdown
      });

      await fs.mkdir(path.dirname(cacheFile), { recursive: true });
      await fs.writeFile(cacheFile, `${frontMatter(source, filePath, stat)}${markdown}\n`, "utf8");

      const baseMetadata = {
        ...baseChunkMetadata(filePath, recognition, tenderChunkMetadata(tenderRecognition)),
        origin: "google-context",
        contextLinkId: link.id || ""
      };
      let chunks = chunkMarkdown(markdown, 1800, 220, baseMetadata);
      let quality = verifyIndexedMarkdown(markdown, chunks, recognition);
      ({ chunks, quality } = suppressChunksForQuality(chunks, quality));
      manifest.files[fileId] = googleContextManifestEntry({
        source,
        link: linkWithTitle,
        fileId,
        filePath,
        cacheFile,
        stat,
        recognition,
        tenderRecognition,
        quality,
        indexedAt
      });
      chunks.forEach((chunk, chunkIndex) => {
        const chunkRecord = normalizeChunkRecord(chunk);
        sourceChunks.push({
          id: `${fileId}:${chunkIndex}`,
          fileId,
          sourceId: source.id,
          sourceTitle: source.title,
          path: filePath,
          relativePath: filePath,
          title: linkWithTitle.title || path.basename(filePath),
          chunkIndex,
          origin: "google-context",
          contextLinkId: link.id || "",
          ...chunkRecord.metadata,
          metadata: chunkRecord.metadata,
          text: chunkRecord.text,
          terms: tokenize(chunkRecord.text)
        });
      });
      await persistPartialManifest();
    } catch (error) {
      if (isAbortError(error, signal)) throw error;
      failed += 1;
      const reason = "google_context_fetch_failed";
      const failureMarkdown = normalizeText(`# ${initialTitle}\n\nGoogle context link was not indexed: ${reason}.`);
      const stat = googleContextStat(failureMarkdown, indexedAt);
      const recognition = {
        method: "google-context-error",
        documentType: "google-context",
        errorReason: reason,
        errorMessage: error.message || "",
        chars: 0
      };
      const tenderRecognition = recognizeTenderDocument({
        source,
        filePath,
        relativePath: filePath,
        markdown: failureMarkdown
      });
      const quality = googleContextFailureQuality(reason);

      try {
        await fs.mkdir(path.dirname(cacheFile), { recursive: true });
        await fs.writeFile(cacheFile, `${frontMatter(source, filePath, stat)}${failureMarkdown}\n`, "utf8");
        manifest.files[fileId] = googleContextManifestEntry({
          source,
          link,
          fileId,
          filePath,
          cacheFile,
          stat,
          recognition,
          tenderRecognition,
          quality,
          indexedAt
        });
        await persistPartialManifest();
      } catch {
        // Preserve the original indexing error for the job summary.
      }

      errors.push({ path: filePath, message: error.message || "Google context link was not indexed" });
      skippedFiles.push({
        path: filePath,
        relativePath: filePath,
        title: initialTitle,
        extension: path.extname(filePath).toLowerCase() || "",
        reason
      });
    }

    onProgress({
      phase: "index",
      message: "Индексация",
      processed,
      total: totalItems,
      cached,
      skipped: cached,
      failed,
      currentGoogleContextLinkId: "",
      currentGoogleContextTitle: "",
      reindexQueued: reindex.queued,
      reindexRetried: reindex.retried,
      reindexResolved: reindex.resolved,
      reindexUnresolved: reindex.unresolved,
      reindexFailed: reindex.failed,
      googleContextLinks: googleContextLinks.length,
      ...googleFileProgress(),
      ...scanStats
    });
  }

  for (const [fileId, entry] of Object.entries(manifest.files)) {
    if (entry.sourceId === source.id && !seenFileIds.has(fileId)) {
      delete manifest.files[fileId];
    }
  }

  const nextChunks = [...retainedChunks, ...sourceChunks];
  await writeManifest(manifest);
  await writeChunks(nextChunks);
  const sourceSummary = buildSourceSummary({ source, manifest, chunks: nextChunks });
  await writeSourceSummary(sourceSummary);

  const vectorResult = await ensureChunkEmbeddings({
    sourceId: source.id,
    chunks: sourceChunks,
    signal,
    onProgress: (progress) => onProgress({
      ...progress,
      processed,
      total: totalItems,
      cached,
      failed,
      reindexQueued: reindex.queued,
      reindexRetried: reindex.retried,
      reindexResolved: reindex.resolved,
      reindexUnresolved: reindex.unresolved,
      reindexFailed: reindex.failed,
      googleContextLinks: googleContextLinks.length,
      ...scanStats
    })
  });

  return {
    sourceId: source.id,
    startedAt,
    finishedAt: new Date().toISOString(),
    files: totalItems,
    indexedFiles: totalItems - failed,
    chunks: sourceChunks.length,
    force,
    cached,
    skipped: cached,
    failed,
    reindexQueued: reindex.queued,
    reindexRetried: reindex.retried,
    reindexResolved: reindex.resolved,
    reindexUnresolved: reindex.unresolved,
    reindexFailed: reindex.failed,
    reindexRecoveredErrors: reindex.recoveredErrors,
    errors,
    skippedFiles,
    googleContextLinks: googleContextLinks.length,
    sourceSummary,
    ...vectorResult,
    ...scanStats
  };
}

export async function indexSource(source, onProgress = () => {}, options = {}) {
  const signal = options.signal || null;
  throwIfAborted(signal);
  const release = await acquireIndexLock(() => {
    onProgress({
      phase: "queued",
      message: "Ожидание другой индексации"
    });
  }, { signal });

  try {
    throwIfAborted(signal);
    return await indexSourceUnlocked(source, onProgress, options);
  } finally {
    await release();
  }
}

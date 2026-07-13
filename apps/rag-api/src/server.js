import express from "express";
import path from "node:path";
import crypto from "node:crypto";
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { formatCitationLabel } from "./citations.js";
import { chunksPath, markdownCacheDir, projectRoot } from "./paths.js";
import { ensureStorage, readChunks, readJobs, readManifest, readSettings, readSourceSummaries, readSources, readVectors, writeChunks, writeJobs, writeManifest, writeSettings, writeSourceSummaries, writeSources, writeVectors } from "./store.js";
import { indexSource, scanSkippedFiles } from "./indexer.js";
import { ensureChunkEmbeddings } from "./embeddings.js";
import { dailyAgentLockStatus, publicDailyAgentRun, readDailyAgentRuns, runDailyIndexAgent } from "./daily-agent.js";
import { searchChunksWithMetadata } from "./search.js";
import { authorizeDifyAdapterRequest, runDifyRetrieval } from "./dify-adapter.js";
import { countQdrantVectorsBySource, qdrantStatus } from "./vector-store.js";
import { buildCompletedVectorBackfillJob, buildVectorBackfillRows, countJsonVectorsBySource } from "./vector-backfill-status.js";
import { managedQdrantStatus, restartManagedQdrant, startManagedQdrant, stopManagedQdrant } from "./qdrant-process.js";
import { listFolders, listRoots, openFileInSystem, revealFileInSystem } from "./filesystem.js";
import { chooseFolderWithExplorer } from "./dialog.js";
import { chatCompletion, chatCompletionStream, isLmStudioRuntime, listLlmModels, lmStudioNativeBaseUrl, matchConfiguredModel, mergeModelRows, modelRowsFromPayload, normalizeRemoteRuntime } from "./llm.js";
import { converterStatus } from "./converters.js";
import { clearGoogleAuth, completeGoogleAuth, googleAuthPublicStatus, startGoogleAuth } from "./google-auth.js";
import { rerankerStatus } from "./reranker.js";
import { managedRerankerStatus, restartManagedReranker, startManagedReranker, stopManagedReranker } from "./reranker-process.js";
import { matchSourceForQuestion } from "./source-match.js";
import { applySourcePatch } from "./source-updates.js";
import { resolveChatSourceScope } from "./chat-scope.js";
import { expandedChatRetrievalQuery, hasBroadAnswerIntent } from "./chat-intent.js";
import {
  contractSources,
  contractForTender,
  isContractSource,
  isTenderSource,
  normalizeSourceType,
  publicLinkedTenderSummary,
  searchScopeSourceIds,
  tendersLinkedToContract
} from "./source-scope.js";
import { runTenderSourceSync } from "./tender-sync.js";
import { createHubTenderAdapterFromEnv } from "./hubtender-adapter.js";
import { runTenderPriceAudit } from "./tender-price-audit.js";
import { getGlobalTenderAuditRun, startGlobalTenderAudit } from "./tender-global-audit.js";
import { chatLlmCandidates, llmRouteMetadata, normalizeLlmProvider, providerLabel, selectedLlmSettings } from "./llm-routing.js";
import { createApiSecurityMiddleware, readApiSecurityConfig, warnIfUnsafeNetworkBinding } from "./security.js";
import { findKnownSource, resolveMarkdownCachePath, resolvePreviewTarget } from "./preview-access.js";
import { startSseResponse, writeSseEvent } from "./sse.js";
import { normalizeContextLink, publicContextLinks, resolveContextLinkTitle } from "./context-links.js";
import {
  allSourcesIndexEntries,
  indexSourceIdsForSources,
  indexedEntryQualityStatus,
  indexedEntriesForSource,
  indexProgressHealth,
  indexedSnapshotForAllSources,
  indexedSnapshotForSource,
  manifestChunkCount,
  mergeIndexedSnapshotStatus as mergeIndexSnapshotStatus,
  sourceForIndexEntry
} from "./index-status.js";

const app = express();
const apiSecurity = readApiSecurityConfig();
const jobs = new Map();
const jobControllers = new Map();
const execFileAsync = promisify(execFile);
const llmRequests = new Map();
const lastLlmGenerations = new Map();
let agentRunInProcess = false;
let agentRunController = null;
let lastLlmActivity = null;
let usageCache = { at: 0, payload: null };
let cpuUsageSample = null;

app.use(express.json({ limit: "2mb" }));
app.use("/api", createApiSecurityMiddleware(apiSecurity));
app.use(express.static(path.join(projectRoot, "apps", "rag-ui")));

function sourceIdForPath(folderPath) {
  return `source-${crypto.createHash("sha1").update(folderPath.toLowerCase()).digest("hex").slice(0, 10)}`;
}

function stripFrontMatter(markdown) {
  return String(markdown || "").replace(/^---\n[\s\S]*?\n---\n?/, "");
}

function findFocusRange(markdown, focusText) {
  const text = String(focusText || "").trim();
  if (!text) return null;

  let start = markdown.indexOf(text);
  if (start >= 0) return { start, end: start + text.length, text };

  const samples = [
    text.slice(0, 900),
    text.slice(0, 500),
    text.split(/\n{2,}/).find((part) => part.trim().length > 80),
    text.split(/\n/).find((part) => part.trim().length > 80)
  ].map((part) => String(part || "").trim()).filter(Boolean);

  for (const sample of samples) {
    start = markdown.indexOf(sample);
    if (start >= 0) return { start, end: start + sample.length, text: sample };
  }

  return null;
}

function compactEvidenceText(value) {
  return String(value || "")
    .replace(/\[(\d+)\]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 900);
}

function indexOfFolded(haystack, needle) {
  const source = String(haystack || "");
  const query = String(needle || "");
  if (!source || !query) return -1;
  return source.toLowerCase().indexOf(query.toLowerCase());
}

function uniqueValues(values = []) {
  const seen = new Set();
  const result = [];
  for (const value of values) {
    const text = String(value || "").trim();
    const key = text.toLowerCase();
    if (!text || seen.has(key)) continue;
    seen.add(key);
    result.push(text);
  }
  return result;
}

function evidenceTokens(value) {
  const text = compactEvidenceText(value);
  const emails = Array.from(text.matchAll(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi), (match) => match[0]);
  const urls = Array.from(text.matchAll(/https?:\/\/[^\s),;]+/gi), (match) => match[0]);
  const numbers = Array.from(text.matchAll(/\b\d[\d\s.,-]*(?:%|₽|руб\.?|дн(?:ей|я)?|мес(?:яцев|ца)?|лет|год(?:а|ов)?)?/giu), (match) => match[0].trim())
    .filter((token) => /\d/.test(token));
  const words = Array.from(text.matchAll(/[\p{L}\p{N}_@.+%-]{3,}/gu), (match) => match[0])
    .filter((token) => !/^\d+$/.test(token));
  return uniqueValues([...emails, ...urls, ...numbers, ...words]).slice(0, 32);
}

function lineRanges(text) {
  const value = String(text || "");
  const ranges = [];
  let start = 0;
  while (start <= value.length) {
    const next = value.indexOf("\n", start);
    const end = next >= 0 ? next : value.length;
    ranges.push({ start, end });
    if (next < 0) break;
    start = next + 1;
  }
  return ranges;
}

function trimRange(text, start, end) {
  let nextStart = Math.max(0, Number(start || 0));
  let nextEnd = Math.min(String(text || "").length, Number(end || 0));
  while (nextStart < nextEnd && /\s/.test(text[nextStart])) nextStart += 1;
  while (nextEnd > nextStart && /\s/.test(text[nextEnd - 1])) nextEnd -= 1;
  return nextEnd > nextStart ? { start: nextStart, end: nextEnd, text: text.slice(nextStart, nextEnd) } : null;
}

function lineExpandedStart(text, index) {
  const start = Math.max(0, Number(index || 0));
  return text.lastIndexOf("\n", start) + 1;
}

function lineExpandedEnd(text, index) {
  const end = Math.min(String(text || "").length, Number(index || 0));
  const nextBreak = text.indexOf("\n", end);
  return nextBreak >= 0 ? nextBreak : text.length;
}

function previewWindowAroundRange(text, range, options = {}) {
  const source = String(text || "");
  if (!range || !Number.isFinite(Number(range.start)) || !Number.isFinite(Number(range.end))) {
    return {
      text: source,
      focus: { found: false },
      truncatedBefore: false,
      truncatedAfter: false
    };
  }

  const before = Math.max(0, Number(options.before ?? 520));
  const after = Math.max(0, Number(options.after ?? 760));
  const rawStart = Math.max(0, Number(range.start) - before);
  const rawEnd = Math.min(source.length, Number(range.end) + after);
  const windowStart = lineExpandedStart(source, rawStart);
  const windowEnd = lineExpandedEnd(source, rawEnd);
  const excerpt = source.slice(windowStart, windowEnd);

  return {
    text: excerpt,
    focus: {
      found: true,
      start: Number(range.start) - windowStart,
      end: Number(range.end) - windowStart,
      text: range.text || source.slice(range.start, range.end)
    },
    truncatedBefore: windowStart > 0,
    truncatedAfter: windowEnd < source.length
  };
}

function tokenWeight(token) {
  if (/@/.test(token) || /^https?:\/\//i.test(token)) return 8;
  if (/\d/.test(token)) return 4;
  return token.length >= 6 ? 2 : 1;
}

function findEvidenceRange(markdown, focusText) {
  const source = String(markdown || "");
  const evidence = compactEvidenceText(focusText);
  if (!source || !evidence) return null;

  const directStart = indexOfFolded(source, evidence);
  if (directStart >= 0) return trimRange(source, directStart, directStart + evidence.length);

  const tokens = evidenceTokens(evidence);
  if (!tokens.length) return null;

  const ranges = lineRanges(source).filter((range) => source.slice(range.start, range.end).trim());
  let best = null;

  for (let index = 0; index < ranges.length; index += 1) {
    for (let span = 1; span <= 3 && index + span - 1 < ranges.length; span += 1) {
      const start = ranges[index].start;
      const end = ranges[index + span - 1].end;
      const segment = source.slice(start, end);
      const folded = segment.toLowerCase();
      let score = 0;
      const matched = [];

      for (const token of tokens) {
        if (folded.includes(token.toLowerCase())) {
          score += tokenWeight(token);
          matched.push(token);
        }
      }

      if (!score) continue;
      const length = end - start;
      if (!best || score > best.score || (score === best.score && length < best.length)) {
        best = { start, end, score, length, matched };
      }
    }
  }

  if (!best) return null;

  const segment = source.slice(best.start, best.end);
  const strongMatched = best.matched.filter((token) => tokenWeight(token) >= 4);
  const highlightTokens = strongMatched.length ? strongMatched : best.matched;
  const positions = highlightTokens
    .map((token) => {
      const start = indexOfFolded(segment, token);
      return start >= 0 ? { start, end: start + token.length } : null;
    })
    .filter(Boolean);

  if (!positions.length) return trimRange(source, best.start, best.end);

  const start = best.start + Math.min(...positions.map((item) => item.start));
  const end = best.start + Math.max(...positions.map((item) => item.end));
  return trimRange(source, start, end) || trimRange(source, best.start, best.end);
}

function chunkPreviewMetadata(chunk = {}) {
  const metadata = chunk.metadata || {};
  return {
    documentType: chunk.documentType || metadata.documentType || "",
    pageStart: chunk.pageStart ?? metadata.pageStart,
    pageEnd: chunk.pageEnd ?? metadata.pageEnd,
    totalPages: chunk.totalPages ?? metadata.totalPages,
    sheetName: chunk.sheetName || metadata.sheetName || "",
    rowStart: chunk.rowStart ?? metadata.rowStart,
    rowEnd: chunk.rowEnd ?? metadata.rowEnd,
    sectionTitle: chunk.sectionTitle || metadata.sectionTitle || ""
  };
}

async function persistJob(job) {
  const persisted = await readJobs();
  persisted[job.id] = job;
  await writeJobs(persisted);
}

function isAbortError(error) {
  return error?.name === "AbortError" || /aborted|cancelled|остановлена/i.test(String(error?.message || ""));
}

function latestJobForSource(sourceId, persistedJobs = {}) {
  const candidates = [
    ...Object.values(persistedJobs || {}),
    ...Array.from(jobs.values())
  ].filter((job) => job?.sourceId === sourceId);

  if (!candidates.length) return null;

  candidates.sort((a, b) => {
    const aTime = new Date(a.updatedAt || a.finishedAt || a.startedAt || 0).getTime();
    const bTime = new Date(b.updatedAt || b.finishedAt || b.startedAt || 0).getTime();
    return bTime - aTime;
  });

  return candidates[0];
}

function normalizePublicJob(job) {
  if (!job) return null;
  if (job.status === "running" && !jobs.has(job.id)) {
    return {
      ...job,
      status: "failed",
      phase: "interrupted",
      message: "Индексация прервана; запустите заново",
      failed: job.failed || 0,
      updatedAt: job.updatedAt || job.startedAt
    };
  }
  return job;
}

function optionalNumber(value) {
  if (value === undefined || value === null || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

const MAX_PUBLIC_JOB_ERRORS = 50;

// The job object is polled, so the error list is capped; errorsTotal keeps the real count.
function publicJobErrors(job) {
  if (!Array.isArray(job?.errors)) return [];
  return job.errors.slice(0, MAX_PUBLIC_JOB_ERRORS).map((error) => ({
    path: String(error?.path || ""),
    message: String(error?.message || "")
  }));
}

function publicJobStatus(job) {
  const rawJob = job;
  job = normalizePublicJob(job);
  if (!job) return { status: "not_indexed", message: "Не индексировалось" };

  const skippedTotal = (job.unsupportedFiles || 0) + (job.temporaryFiles || 0) + (job.excludedFiles || 0);
  const qdrantPoints = optionalNumber(job.qdrantPoints);
  const vectorCount = optionalNumber(job.vectorCount);
  const alive = Boolean(rawJob?.status === "running" && rawJob?.id && jobs.has(rawJob.id));
  const health = indexProgressHealth(rawJob || job, { alive });
  return {
    id: job.id,
    type: job.type || "",
    sourceId: job.sourceId || "",
    sourceTitle: job.sourceTitle || "",
    status: job.status,
    phase: job.phase,
    message: job.message,
    health,
    force: Boolean(job.force),
    processed: job.processed || 0,
    total: job.total || job.files || 0,
    totalFiles: job.totalFiles || 0,
    eligibleFiles: job.eligibleFiles || job.files || 0,
    indexedFiles: job.indexedFiles ?? Math.max(0, (job.files || job.total || 0) - (job.failed || 0)),
    chunks: job.chunks || 0,
    vectorsTotal: job.vectorsTotal || 0,
    vectorsProcessed: job.vectorsProcessed || 0,
    vectorsCached: job.vectorsCached || 0,
    jsonVectors: job.jsonVectors || 0,
    qdrantVectors: job.qdrantVectors || 0,
    storedVectors: job.storedVectors || 0,
    ready: Boolean(job.ready),
    embeddingModel: job.embeddingModel || "",
    vectorsEmbedded: job.vectorsEmbedded || 0,
    vectorStoreProvider: job.vectorStoreProvider || "",
    configuredProvider: job.configuredProvider || "",
    vectorProviderUsed: job.vectorProviderUsed || job.vectorStoreProvider || "",
    qdrantAvailable: job.qdrantAvailable === undefined ? null : Boolean(job.qdrantAvailable),
    qdrantCollection: job.qdrantCollection || "",
    collectionName: job.collectionName || job.qdrantCollection || "",
    qdrantPoints,
    vectorCount: vectorCount ?? qdrantPoints ?? 0,
    qdrantError: job.qdrantError || "",
    warning: job.warning || "",
    failed: job.failed || 0,
    errors: publicJobErrors(job),
    errorsTotal: Array.isArray(job.errors) ? job.errors.length : 0,
    skippedTotal,
    unsupportedFiles: job.unsupportedFiles || 0,
    temporaryFiles: job.temporaryFiles || 0,
    excludedFiles: job.excludedFiles || 0,
    unreadableDirectories: job.unreadableDirectories || 0,
    reindexQueued: job.reindexQueued || 0,
    reindexRetried: job.reindexRetried || 0,
    reindexResolved: job.reindexResolved || 0,
    reindexUnresolved: job.reindexUnresolved || 0,
    reindexFailed: job.reindexFailed || 0,
    reindexRecoveredErrors: job.reindexRecoveredErrors || 0,
    unsupportedByExt: job.unsupportedByExt || {},
    googleContextLinks: job.googleContextLinks || 0,
    currentGoogleContextLinkId: job.currentGoogleContextLinkId || "",
    currentGoogleContextTitle: job.currentGoogleContextTitle || "",
    currentFileTitle: job.currentFileTitle || "",
    currentFileRelativePath: job.currentFileRelativePath || "",
    currentFileExtension: job.currentFileExtension || "",
    startedAt: job.startedAt,
    updatedAt: job.updatedAt,
    finishedAt: job.finishedAt
  };
}

async function scanChunkObjects(onChunk) {
  const settings = await readSettings();
  if (settings.storage?.metadataProvider === "sqlite") {
    for (const chunk of await readChunks()) {
      const shouldContinue = await onChunk(chunk);
      if (shouldContinue === false) return;
    }
    return;
  }

  let depth = 0;
  let buffer = "";
  let inString = false;
  let escaped = false;
  let collecting = false;

  try {
    for await (const data of createReadStream(chunksPath(), { encoding: "utf8" })) {
      for (const char of data) {
        if (!collecting) {
          if (char === "{") {
            collecting = true;
            depth = 1;
            buffer = char;
            inString = false;
            escaped = false;
          }
          continue;
        }

        buffer += char;

        if (inString) {
          if (escaped) {
            escaped = false;
          } else if (char === "\\") {
            escaped = true;
          } else if (char === "\"") {
            inString = false;
          }
          continue;
        }

        if (char === "\"") {
          inString = true;
        } else if (char === "{") {
          depth += 1;
        } else if (char === "}") {
          depth -= 1;
          if (depth === 0) {
            const raw = buffer;
            buffer = "";
            collecting = false;
            const shouldContinue = await onChunk(JSON.parse(raw));
            if (shouldContinue === false) return;
          }
        }
      }
    }
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
}

async function findChunk(predicate) {
  let found = null;
  await scanChunkObjects((chunk) => {
    if (predicate(chunk)) {
      found = chunk;
      return false;
    }
    return true;
  });
  return found;
}

function knownIndexableFileCount(status = {}, snapshot = {}) {
  return Math.max(
    Number(status.total || 0),
    Number(status.eligibleFiles || 0),
    Number(snapshot.files || 0)
  );
}

function knownScannedFileCount(status = {}, indexableFiles = 0) {
  return Math.max(
    Number(status.totalFiles || 0),
    Number(indexableFiles || 0)
  );
}

function fallbackVectorStoreStatus(settings = {}, error = null) {
  const vectorStore = settings.vectorStore || {};
  const qdrant = vectorStore.qdrant || {};
  return {
    configuredProvider: vectorStore.provider || "",
    vectorProviderUsed: vectorStore.provider === "json" ? "json" : "qdrant",
    qdrantEnabled: Boolean(vectorStore.enabled),
    qdrantAvailable: false,
    qdrantCollection: qdrant.collection || "",
    collectionName: qdrant.collection || "",
    qdrantPoints: 0,
    vectorCount: 0,
    qdrantError: error?.message || "",
    warning: ""
  };
}

async function safeQdrantStatus(settings = {}) {
  try {
    return await qdrantStatus(settings.vectorStore);
  } catch (error) {
    return fallbackVectorStoreStatus(settings, error);
  }
}

function buildIndexOverview({ sources = [], persistedJobs = {}, manifest = {}, vectorStore = {} } = {}) {
  const entries = allSourcesIndexEntries(sources, manifest);
  const recognizedEntries = entries.filter((entry) => (
    manifestChunkCount(entry) > 0 && indexedEntryQualityStatus(entry) !== "error"
  ));
  const quality = { ok: 0, warning: 0, error: 0, unchecked: 0 };
  for (const entry of entries) {
    const status = indexedEntryQualityStatus(entry);
    if (Object.hasOwn(quality, status)) quality[status] += 1;
    else quality.unchecked += 1;
  }

  let knownIndexableFiles = 0;
  let knownScannedFiles = 0;
  let failedFiles = 0;
  let skippedFiles = 0;
  let sourcesWithIndex = 0;
  let unknownSources = 0;
  let interruptedJobs = 0;
  const currentSourceIds = new Set(sources.map((source) => source?.id).filter(Boolean));

  for (const source of sources) {
    const snapshot = indexedSnapshotForSource(source, manifest, { currentSourceIds });
    const status = publicJobStatus(latestJobForSource(source.id, persistedJobs));
    const indexable = knownIndexableFileCount(status, snapshot);
    knownIndexableFiles += indexable;
    knownScannedFiles += knownScannedFileCount(status, indexable);
    failedFiles += Number(status.failed || 0);
    skippedFiles += Number(status.skippedTotal || 0);
    if (snapshot.files || status.status !== "not_indexed") sourcesWithIndex += 1;
    if (!indexable && !snapshot.files && status.status === "not_indexed") unknownSources += 1;
    if (status.health?.status === "interrupted") interruptedJobs += 1;
  }

  const runningJobs = Array.from(jobs.values()).filter((job) => job?.status === "running");
  const runningStatuses = runningJobs.map((job) => publicJobStatus(job));
  const staleRunningJobs = runningStatuses.filter((status) => status.health?.status === "stale");
  const runningTotal = runningJobs.reduce((sum, job) => sum + Number(job.total || job.files || 0), 0);
  const runningProcessed = runningJobs.reduce((sum, job) => sum + Number(job.processed || 0), 0);
  const chunks = entries.reduce((sum, entry) => sum + manifestChunkCount(entry), 0);
  const total = knownIndexableFiles || entries.length;
  const qdrantPoints = optionalNumber(vectorStore.qdrantPoints);

  return {
    status: runningJobs.length
      ? (staleRunningJobs.length ? "warning" : "running")
      : (recognizedEntries.length ? ((failedFiles || interruptedJobs) ? "warning" : "ready") : (interruptedJobs ? "warning" : "empty")),
    files: {
      recognized: recognizedEntries.length,
      indexed: entries.length,
      total,
      scanned: knownScannedFiles || total,
      chunks,
      failed: failedFiles,
      skipped: skippedFiles,
      quality,
      totalKnown: knownIndexableFiles > 0,
      unknownSources
    },
    sources: {
      total: sources.length,
      withIndex: sourcesWithIndex
    },
    running: {
      jobs: runningJobs.length,
      active: Math.max(0, runningJobs.length - staleRunningJobs.length),
      stale: staleRunningJobs.length,
      processed: runningProcessed,
      total: runningTotal,
      lastProgressAt: runningStatuses
        .map((status) => status.health?.lastProgressAt)
        .filter(Boolean)
        .sort()
        .at(-1) || ""
    },
    issues: {
      staleJobs: staleRunningJobs.length,
      interruptedJobs
    },
    qdrant: {
      enabled: Boolean(vectorStore.qdrantEnabled),
      available: vectorStore.qdrantAvailable === true,
      provider: vectorStore.vectorProviderUsed || vectorStore.configuredProvider || "",
      configuredProvider: vectorStore.configuredProvider || "",
      collection: vectorStore.qdrantCollection || vectorStore.collectionName || "",
      points: qdrantPoints,
      error: vectorStore.qdrantError || "",
      warning: vectorStore.warning || ""
    },
    updatedAt: entries
      .map((entry) => entry.indexedAt)
      .filter(Boolean)
      .sort()
      .at(-1) || ""
  };
}

function activeIndexProgressText() {
  const running = Array.from(jobs.values()).filter((job) => job?.status === "running");
  if (!running.length) return "";

  const total = running.reduce((sum, job) => sum + Number(job.total || 0), 0);
  const processed = running.reduce((sum, job) => sum + Number(job.processed || 0), 0);
  if (!total) return " Сейчас идет индексация.";
  return ` Сейчас идет индексация: ${processed}/${total}.`;
}

function allSourcesNoResultsAnswer(manifest = {}) {
  const snapshot = indexedSnapshotForAllSources(manifest);
  const progress = activeIndexProgressText();
  if (!snapshot.chunks) {
    return `По всем проектам пока нет готового индекса.${progress} Запустите агента или дождитесь завершения индексации, затем повторите вопрос.`;
  }

  return `По готовым индексам всех проектов ничего не найдено.${progress} Попробуйте уточнить формулировку или дождитесь завершения текущей индексации.`;
}

function mergeIndexedSnapshotStatus(status, snapshot) {
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

function contextLinkIndexEntry(source, link, manifest = {}) {
  if (!manifest) return null;
  return Object.values(manifest.files || {}).find((entry) => (
    entry?.sourceId === source.id
    && entry?.origin === "google-context"
    && entry?.contextLinkId === link.id
  )) || null;
}

function contextLinkIndexStatus(source, link, manifest = null, latestJob = null) {
  const jobStatus = publicJobStatus(latestJob);
  const entry = contextLinkIndexEntry(source, link, manifest);
  const chunks = manifestChunkCount(entry);

  if (jobStatus.status === "running") {
    if (jobStatus.currentGoogleContextLinkId && jobStatus.currentGoogleContextLinkId === link.id) {
      return {
        status: "indexing",
        label: "индексируется",
        chunks,
        updatedAt: jobStatus.updatedAt || jobStatus.startedAt || "",
        message: jobStatus.message || ""
      };
    }

    if (!entry && Number(jobStatus.googleContextLinks || 0) > 0) {
      return {
        status: "queued",
        label: "в очереди",
        chunks: 0,
        updatedAt: jobStatus.updatedAt || jobStatus.startedAt || "",
        message: "Ожидает очереди индексации"
      };
    }
  }

  if (!entry) {
    return {
      status: "not_indexed",
      label: "не индексировалось",
      chunks: 0,
      updatedAt: "",
      message: ""
    };
  }

  const qualityStatus = entry.quality?.status || "";
  const reason = entry.recognition?.errorReason || entry.quality?.warnings?.[0] || "";
  const statusMessage = googleContextIndexMessage(entry.recognition?.errorMessage || reason);
  if (qualityStatus === "error" || entry.recognition?.method === "google-context-error" || chunks <= 0) {
    return {
      status: "failed",
      label: "ошибка",
      chunks,
      updatedAt: entry.indexedAt || "",
      message: statusMessage || "Google контекст не дал фрагментов"
    };
  }

  if (qualityStatus === "warning") {
    return {
      status: "warning",
      label: `${chunks} фрагм., проверить`,
      chunks,
      updatedAt: entry.indexedAt || "",
      message: entry.quality?.warnings?.join(", ") || ""
    };
  }

  return {
    status: "indexed",
    label: `${chunks} фрагм.`,
    chunks,
    updatedAt: entry.indexedAt || "",
    message: ""
  };
}

function googleContextIndexMessage(reason = "") {
  const value = String(reason || "").trim();
  if (/HTTP\s*(401|403)\b|access denied|not authorized|permission/i.test(value)) {
    return "Google документ недоступен для серверного экспорта. Откройте доступ по ссылке для чтения и запустите переиндексацию.";
  }
  if (/HTML page instead of document text|HTML page instead of a downloadable file/i.test(value)) {
    return "Google вернул страницу входа или просмотра вместо текста. Проверьте доступ по ссылке и запустите переиндексацию.";
  }
  return {
    google_context_fetch_failed: "Не удалось получить Google документ. Проверьте доступ по ссылке и запустите переиндексацию.",
    unsupported_google_context_link: "Этот тип Google ссылки пока не индексируется.",
    unsupported_google_drive_file: "Этот тип Google Drive файла пока не индексируется.",
    empty_google_context_export: "Google export не вернул текст.",
    empty_google_drive_export: "Google Drive файл не дал текст."
  }[value] || value;
}

function publicContextLinksWithIndexStatus(source, manifest = null, latestJob = null) {
  return publicContextLinks(source).map((link) => ({
    ...link,
    indexStatus: contextLinkIndexStatus(source, link, manifest, latestJob)
  }));
}

function publicSource(source, persistedJobs = {}, manifest = null, sourceSummary = null, allSources = []) {
  const latestJob = latestJobForSource(source.id, persistedJobs);
  const status = publicJobStatus(latestJob);
  const currentSourceIds = new Set((allSources || []).map((item) => item?.id).filter(Boolean));
  const indexStatus = manifest
    ? mergeIndexSnapshotStatus(status, indexedSnapshotForSource(source, manifest, { currentSourceIds }))
    : status;
  const linkedContract = isTenderSource(source) ? contractForTender(source, allSources) : null;
  return {
    id: source.id,
    title: source.title,
    path: source.path,
    sourceType: normalizeSourceType(source),
    tenderCategory: String(source.tenderCategory || "").trim(),
    additionalPaths: Array.isArray(source.additionalPaths) ? source.additionalPaths : [],
    linkedContractId: String(source.linkedContractId || "").trim(),
    linkedContractTitle: linkedContract?.title || "",
    linkedTenders: isContractSource(source)
      ? tendersLinkedToContract(source.id, allSources).map(publicLinkedTenderSummary)
      : [],
    contextLinks: publicContextLinksWithIndexStatus(source, manifest, latestJob),
    createdAt: source.createdAt,
    updatedAt: source.updatedAt,
    summary: sourceSummary || null,
    indexStatus
  };
}

function relativeIndexedPath(source, filePath) {
  if (!path.isAbsolute(String(filePath || ""))) return String(filePath || "");
  const relativePath = path.relative(source.path, filePath);
  if (!relativePath || relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
    return path.basename(filePath);
  }
  return relativePath;
}

function publicIndexedFile(source, entry, chunkCount = null) {
  const filePath = String(entry.path || "");
  const chunks = chunkCount === null || chunkCount === undefined ? manifestChunkCount(entry) : Number(chunkCount || 0);
  return {
    fileId: entry.fileId,
    sourceId: entry.sourceId || source.id,
    sourceTitle: source.title,
    sourceType: normalizeSourceType(source),
    sourcePath: source.path,
    path: filePath,
    relativePath: entry.relativePath || relativeIndexedPath(source, filePath),
    title: entry.title || path.basename(filePath),
    extension: entry.extension || path.extname(filePath).toLowerCase() || "",
    origin: entry.origin || "",
    size: Number(entry.size || 0),
    indexedAt: entry.indexedAt || "",
    chunks,
    recognition: entry.recognition || null,
    tenderRecognition: entry.tenderRecognition || null,
    quality: entry.quality || null,
    reindex: entry.reindex || null
  };
}

function indexedQualitySummary(files) {
  const summary = { ok: 0, warning: 0, error: 0, unchecked: 0 };
  for (const file of files) {
    const status = file.quality?.status || (file.chunks > 0 ? "unchecked" : "error");
    if (Object.hasOwn(summary, status)) summary[status] += 1;
    else summary.unchecked += 1;
  }
  return summary;
}

function publicMatchedSource(source, options = {}) {
  if (!source) return null;
  return {
    id: source.id,
    title: source.title,
    path: source.path,
    autoSelected: Boolean(options.autoSelected),
    score: Number(options.score || 0)
  };
}

function normalizedSourceTitle(title = "") {
  return String(title || "").trim().replace(/\s+/g, " ").toLowerCase();
}

function normalizedSourcePath(folderPath = "") {
  return String(folderPath || "").trim().replace(/\\/g, "/").toLowerCase();
}

function isLikelyTemporarySourcePath(folderPath = "") {
  const normalized = normalizedSourcePath(folderPath);
  return normalized.includes("/localai-auto-")
    || normalized.includes("/appdata/local/temp/")
    || normalized.startsWith("/tmp/");
}

function findExistingTemporarySourceByTitle(sources = [], title = "", folderPath = "") {
  const normalizedTitle = normalizedSourceTitle(title);
  if (!normalizedTitle || !isLikelyTemporarySourcePath(folderPath)) return null;
  return sources.find((source) => (
    normalizedSourceTitle(source?.title) === normalizedTitle
    && isLikelyTemporarySourcePath(source?.path)
  )) || null;
}

function sourceHasRunningJob(sourceId) {
  return Array.from(jobs.values()).some((job) => job?.sourceId === sourceId && job.status === "running");
}

function sourceIdSet(sourceIds = []) {
  return new Set(
    sourceIds
      .map((sourceId) => String(sourceId || "").trim())
      .filter(Boolean)
  );
}

function jobMatchesAnySource(job = {}, sourceIds = new Set()) {
  return sourceIds.has(String(job?.sourceId || ""));
}

function removeSourceFromManifest(manifest = {}, sourceId = "") {
  const files = {};
  for (const [fileId, entry] of Object.entries(manifest.files || {})) {
    if (entry?.sourceId !== sourceId) files[fileId] = entry;
  }
  return { ...manifest, files };
}

function removeSourceFromVectors(vectors = {}, sourceId = "") {
  const items = {};
  for (const [id, item] of Object.entries(vectors.items || {})) {
    if (item?.sourceId !== sourceId) items[id] = item;
  }
  return { ...vectors, items };
}

function removeSourceFromJobs(persistedJobs = {}, sourceId = "") {
  return Object.fromEntries(
    Object.entries(persistedJobs || {}).filter(([, job]) => job?.sourceId !== sourceId)
  );
}

function removeSourceFromSummaries(sourceSummaries = {}, sourceId = "") {
  const summaries = { ...(sourceSummaries.summaries || {}) };
  delete summaries[sourceId];
  return { ...sourceSummaries, summaries };
}

function removeSourcesFromManifest(manifest = {}, sourceIds = new Set()) {
  const files = {};
  for (const [fileId, entry] of Object.entries(manifest.files || {})) {
    if (!sourceIds.has(String(entry?.sourceId || ""))) files[fileId] = entry;
  }
  return { ...manifest, files };
}

function removeSourcesFromVectors(vectors = {}, sourceIds = new Set()) {
  const items = {};
  for (const [id, item] of Object.entries(vectors.items || {})) {
    if (!sourceIds.has(String(item?.sourceId || ""))) items[id] = item;
  }
  return { ...vectors, items };
}

function removeSourcesFromJobs(persistedJobs = {}, sourceIds = new Set()) {
  return Object.fromEntries(
    Object.entries(persistedJobs || {}).filter(([, job]) => !jobMatchesAnySource(job, sourceIds))
  );
}

function removeSourcesFromSummaries(sourceSummaries = {}, sourceIds = new Set()) {
  const summaries = { ...(sourceSummaries.summaries || {}) };
  for (const sourceId of sourceIds) delete summaries[sourceId];
  return { ...sourceSummaries, summaries };
}

async function cleanupDeletedSourceMetadata(sourceIds) {
  const ids = sourceIdSet(sourceIds);
  if (!ids.size) return;

  const [manifest, chunks, sourceSummaries, vectors, persistedJobs] = await Promise.all([
    readManifest(),
    readChunks(),
    readSourceSummaries(),
    readVectors(),
    readJobs()
  ]);

  const nextManifest = removeSourcesFromManifest(manifest, ids);
  const nextChunks = Array.isArray(chunks) ? chunks.filter((chunk) => !ids.has(String(chunk?.sourceId || ""))) : [];
  const nextSourceSummaries = removeSourcesFromSummaries(sourceSummaries, ids);
  const nextVectors = removeSourcesFromVectors(vectors, ids);
  const nextJobs = removeSourcesFromJobs(persistedJobs, ids);

  for (const [jobId, job] of jobs.entries()) {
    if (jobMatchesAnySource(job, ids)) jobs.delete(jobId);
  }

  await Promise.all([
    writeManifest(nextManifest),
    writeChunks(nextChunks),
    writeSourceSummaries(nextSourceSummaries),
    writeVectors(nextVectors),
    writeJobs(nextJobs)
  ]);
}

async function deleteSourcesByIds(sourceIds = []) {
  const ids = sourceIdSet(sourceIds);
  const sources = await readSources();
  const targets = sources.filter((source) => ids.has(String(source.id || "")));
  if (!targets.length) return { sources, targets: [] };

  const running = targets.find((source) => sourceHasRunningJob(source.id));
  if (running) {
    const error = new Error("source has a running job; wait for indexing to finish");
    error.statusCode = 409;
    throw error;
  }

  const targetIds = sourceIdSet(targets.map((source) => source.id));
  const nextSources = sources.filter((source) => !targetIds.has(String(source.id || "")));
  for (const [jobId, job] of jobs.entries()) {
    if (jobMatchesAnySource(job, targetIds)) jobs.delete(jobId);
  }
  await writeSources(nextSources);
  cleanupDeletedSourceMetadata([...targetIds]).catch((error) => {
    console.error("Deleted source metadata cleanup failed:", error);
  });
  return { sources: nextSources, targets };
}

function publicLlmSettings(llm = {}, options = {}) {
  const { apiKey, remote: incomingRemote, ...publicLlm } = llm;
  const { apiKey: remoteApiKey, ...remote } = incomingRemote || {};
  remote.hasApiKey = Boolean(remoteApiKey);

  return {
    ...publicLlm,
    ...(options.maskApiKey ? { hasApiKey: Boolean(apiKey) } : {}),
    remote
  };
}

function publicEmbeddingSettings(embeddings = {}) {
  const { apiKey, ...publicEmbeddings } = embeddings;
  return {
    ...publicEmbeddings,
    hasApiKey: Boolean(apiKey)
  };
}

function publicVectorStoreSettings(vectorStore = {}) {
  const { qdrant: incomingQdrant, ...publicVectorStore } = vectorStore;
  const { apiKey, ...qdrant } = incomingQdrant || {};
  return {
    ...publicVectorStore,
    qdrant: {
      ...qdrant,
      hasApiKey: Boolean(apiKey)
    }
  };
}

function publicRerankerSettings(reranker = {}) {
  const { apiKey, ...publicReranker } = reranker;
  return {
    ...publicReranker,
    hasApiKey: Boolean(apiKey)
  };
}

function emptyRouteMetadata(settings = null) {
  return llmRouteMetadata(chatLlmCandidates(settings || {})[0]);
}

function ragDebugMetadata({
  routeMetadata = {},
  searchMetadata = {},
  matchedSource = null,
  finalSourceCount = 0,
  promptChars = 0,
  answer = "",
  llmMs = 0,
  totalMs = 0
} = {}) {
  const searchTimings = searchMetadata.timings || {};
  return {
    ...routeMetadata,
    ...searchMetadata,
    matchedSource,
    finalSourceCount: Number(finalSourceCount || 0),
    promptChars: Number(promptChars || 0),
    answerChars: String(answer || "").length,
    timings: {
      retrievalMs: Number(searchTimings.retrievalMs || 0),
      rerankMs: Number(searchTimings.rerankMs || 0),
      llmMs: Number(llmMs || 0),
      totalMs: Number(totalMs || 0)
    }
  };
}

function publicSettings(settings) {
  return {
    ...settings,
    llm: publicLlmSettings(settings.llm || {}, { maskApiKey: true }),
    embeddings: publicEmbeddingSettings(settings.embeddings || {}),
    vectorStore: publicVectorStoreSettings(settings.vectorStore || {}),
    reranker: publicRerankerSettings(settings.reranker || {})
  };
}

async function vectorBackfillRowsForState({ sources = [], chunks = [], vectors = {}, settings = {} } = {}) {
  const qdrantCountsStatus = await countQdrantVectorsBySource({
    vectorStore: settings.vectorStore,
    sourceIds: sources.map((source) => source.id)
  });

  return buildVectorBackfillRows({
    sources,
    chunks,
    vectors,
    settings,
    qdrantCounts: qdrantCountsStatus.counts,
    qdrantAvailable: qdrantCountsStatus.qdrantAvailable,
    qdrantError: qdrantCountsStatus.qdrantError,
    qdrantWarning: qdrantCountsStatus.warning
  });
}

function aggregateCount(counts, sourceIds = []) {
  return sourceIds.reduce((sum, sourceId) => {
    if (!sourceId) return sum;
    if (counts instanceof Map) return sum + Number(counts.get(sourceId) || 0);
    return sum + Number(counts?.[sourceId] || 0);
  }, 0);
}

function indexedSourceIdsForRefresh(source, manifest = {}, currentSourceIds = new Set()) {
  const ids = new Set([source.id]);
  for (const entry of indexedEntriesForSource(source, manifest, { currentSourceIds })) {
    if (entry?.sourceId) ids.add(entry.sourceId);
  }
  return [...ids].filter(Boolean);
}

function refreshedVectorStatus({ settings = {}, qdrantCountsStatus = {}, jsonVectors = 0, qdrantVectors = 0 } = {}) {
  const vectorStore = settings.vectorStore || {};
  const provider = String(vectorStore.provider || "auto").trim().toLowerCase();
  const enabled = vectorStore.enabled !== false;
  const qdrantAvailable = qdrantCountsStatus.qdrantAvailable === true;
  const qdrantCollection = qdrantCountsStatus.qdrantCollection || qdrantCountsStatus.collectionName || vectorStore.qdrant?.collection || "";
  const qdrantError = qdrantCountsStatus.qdrantError || "";

  if (!enabled || provider === "json") {
    return {
      vectorStoreProvider: "json",
      configuredProvider: provider || "json",
      vectorProviderUsed: "json",
      jsonVectors,
      qdrantVectors,
      storedVectors: jsonVectors,
      vectorCount: jsonVectors
    };
  }

  if (qdrantAvailable && qdrantVectors > 0) {
    return {
      vectorStoreProvider: "qdrant",
      configuredProvider: provider || "auto",
      vectorProviderUsed: "qdrant",
      qdrantAvailable: true,
      qdrantCollection,
      collectionName: qdrantCollection,
      qdrantPoints: qdrantVectors,
      jsonVectors,
      qdrantVectors,
      storedVectors: qdrantVectors,
      vectorCount: qdrantVectors
    };
  }

  if (!qdrantAvailable && provider === "auto" && jsonVectors > 0) {
    return {
      vectorStoreProvider: "json",
      configuredProvider: "auto",
      vectorProviderUsed: "json",
      qdrantAvailable: false,
      qdrantCollection,
      collectionName: qdrantCollection,
      qdrantError,
      warning: qdrantCountsStatus.warning || (qdrantError ? `Qdrant unavailable, using vectors.json fallback: ${qdrantError}` : "Qdrant unavailable, using vectors.json fallback"),
      jsonVectors,
      qdrantVectors,
      storedVectors: jsonVectors,
      vectorCount: jsonVectors
    };
  }

  return {
    configuredProvider: provider || "auto",
    jsonVectors,
    qdrantVectors,
    storedVectors: Math.max(jsonVectors, qdrantVectors),
    vectorCount: Math.max(jsonVectors, qdrantVectors),
    ...(qdrantAvailable ? {} : { qdrantAvailable: false, qdrantCollection, collectionName: qdrantCollection, qdrantError })
  };
}

function refreshedIndexJobForSource({ source, snapshot, vectorStatus = {}, now = new Date().toISOString() } = {}) {
  const indexedAt = snapshot.indexedAt || now;
  return {
    id: crypto.randomUUID(),
    type: "index_refresh",
    sourceId: source.id,
    sourceTitle: source.title,
    status: "completed",
    phase: "done",
    message: "Статус восстановлен из существующего индекса",
    processed: snapshot.files,
    total: snapshot.files,
    totalFiles: snapshot.files,
    eligibleFiles: snapshot.files,
    indexedFiles: snapshot.files,
    chunks: snapshot.chunks,
    vectorsTotal: Math.max(Number(vectorStatus.storedVectors || 0), snapshot.chunks),
    vectorsProcessed: Number(vectorStatus.storedVectors || 0),
    vectorsCached: Number(vectorStatus.storedVectors || 0),
    vectorsEmbedded: 0,
    ready: snapshot.chunks > 0,
    startedAt: now,
    updatedAt: now,
    finishedAt: indexedAt,
    ...vectorStatus
  };
}

async function refreshExistingIndexState() {
  const [sources, persistedJobs, manifest, vectors, settings, sourceSummaries] = await Promise.all([
    readSources(),
    readJobs(),
    readManifest(),
    readVectors(),
    readSettings(),
    readSourceSummaries()
  ]);

  const currentSourceIds = new Set(sources.map((source) => source?.id).filter(Boolean));
  const sourceIdsByCurrentId = new Map();
  const allIndexSourceIds = new Set();

  for (const source of sources) {
    const sourceIds = indexedSourceIdsForRefresh(source, manifest, currentSourceIds);
    sourceIdsByCurrentId.set(source.id, sourceIds);
    sourceIds.forEach((sourceId) => allIndexSourceIds.add(sourceId));
  }

  const [qdrantCountsStatus, jsonVectorCounts] = await Promise.all([
    countQdrantVectorsBySource({
      vectorStore: settings.vectorStore,
      sourceIds: [...allIndexSourceIds]
    }),
    Promise.resolve(countJsonVectorsBySource(vectors))
  ]);

  const targetIds = new Set(sources.map((source) => source.id));
  const nextJobs = Object.fromEntries(
    Object.entries(persistedJobs || {}).filter(([, job]) => !(job?.type === "index_refresh" && targetIds.has(String(job.sourceId || ""))))
  );
  const now = new Date().toISOString();
  const refreshedSourceIds = [];
  let skippedRunning = 0;
  let skippedEmpty = 0;

  for (const source of sources) {
    if (sourceHasRunningJob(source.id)) {
      skippedRunning += 1;
      continue;
    }

    const snapshot = indexedSnapshotForSource(source, manifest, { currentSourceIds });
    if (!snapshot.files && !snapshot.chunks) {
      skippedEmpty += 1;
      continue;
    }

    const sourceIds = sourceIdsByCurrentId.get(source.id) || [source.id];
    const vectorStatus = refreshedVectorStatus({
      settings,
      qdrantCountsStatus,
      jsonVectors: aggregateCount(jsonVectorCounts, sourceIds),
      qdrantVectors: aggregateCount(qdrantCountsStatus.counts, sourceIds)
    });
    const job = refreshedIndexJobForSource({ source, snapshot, vectorStatus, now });
    nextJobs[job.id] = job;
    refreshedSourceIds.push(source.id);
  }

  await writeJobs(nextJobs);

  const vectorStore = await safeQdrantStatus(settings);
  const overview = buildIndexOverview({ sources, persistedJobs: nextJobs, manifest, vectorStore });
  return {
    status: "completed",
    refreshedSources: refreshedSourceIds.length,
    skippedRunning,
    skippedEmpty,
    totalSources: sources.length,
    overview,
    sources: sources.map((source) => publicSource(
      source,
      nextJobs,
      manifest,
      sourceSummaries.summaries?.[source.id] || null,
      sources
    ))
  };
}

function withFallbackSources(answer, sourceCount) {
  const text = String(answer || "").trim();
  if (!text || /(^|\n)\s*Источники\s*:/i.test(text)) return text;

  const maxSourceNumber = Math.max(Number(sourceCount || 0), 0);
  if (!maxSourceNumber) return text;

  const cited = Array.from(text.matchAll(/\[(\d+)\]/g), (match) => Number(match[1]))
    .filter((number, index, numbers) => (
      Number.isInteger(number)
      && number > 0
      && number <= maxSourceNumber
      && numbers.indexOf(number) === index
    ));
  const sourceNumbers = cited.length
    ? cited.slice(0, 12)
    : Array.from({ length: Math.min(maxSourceNumber, 3) }, (_value, index) => index + 1);
  const refs = sourceNumbers.map((number) => `[${number}]`).join(", ");
  return `${text}\n\nИсточники: ${refs}.`;
}

function buildRagContext(results, profile = {}) {
  const maxSources = Math.max(1, Number(profile.maxSources || 8));
  const maxCharsPerSource = Math.max(500, Number(profile.maxCharsPerSource || 1400));
  return results
    .slice(0, maxSources)
    .map((item, index) => `[${index + 1}] Источник: ${item.citationLabel || formatCitationLabel(item)}\nПроект: ${item.sourceTitle || ""}\nФайл: ${item.title}\nПуть: ${item.path}\nФрагмент:\n${item.text.slice(0, maxCharsPerSource)}`)
    .join("\n\n");
}

function buildChatMessages(question, context, options = {}) {
  const broadAnswer = Boolean(options.broadAnswer);
  const broadInstructions = broadAnswer
    ? [
        "Запрос широкий или обзорный: сначала собери все разные релевантные факты из контекста, затем дай сводку прямо в ответе.",
        "Не отвечай двумя общими пунктами, если контекст содержит больше: перечисли предметные условия отдельными строками или короткими разделами.",
        "Для условий договора проверь и отрази, если есть в контексте: предмет/стороны, документы и редакции, цену и изменения цены, сроки, оплату и аванс, гарантийное удержание или обеспечение, ответственность и допсоглашения.",
        "Если важная категория не подтверждена найденными фрагментами, так и напиши: «в найденных фрагментах не подтверждено»."
      ]
    : [];
  return [
    {
      role: "system",
      content: [
        "Ты локальный RAG-помощник по рабочим документам.",
        "Отвечай на русском, развёрнуто и по делу: покрывай все релевантные найденные факты, но без воды.",
        "Не используй thinking/reasoning режим. Сразу выводи финальный ответ.",
        "Используй только предоставленный контекст.",
        "Если ответа нет в контексте, прямо скажи, что в найденных фрагментах нет подтверждения.",
        "Не придумывай значения, суммы, даты и условия.",
        "Строго различай типы значений: размер, процент, сумма, срок, дата, период, условие возврата или выплаты.",
        "Проценты и суммы никогда не называй сроком. Слово срок используй только для дней, месяцев, лет, дат или дедлайнов.",
        "Если вопрос содержит несколько сущностей, например срок и размер, отвечай отдельными строками: Размер, Срок/период, Условия возврата/выплаты.",
        "Каждое смысловое утверждение, пункт списка или предложение с фактом, числом, сроком, суммой, процентом, условием, названием документа или выводом сопровождай ссылкой на источник сразу в конце этой строки: [1], [2].",
        "Не оставляй фактические строки без ссылок. Если строка является только твоим заголовком/группировкой и не взята из документа, не формулируй ее как факт.",
        "Не заменяй построчные ссылки общим блоком источников в конце; общий блок допустим только дополнительно.",
        "Для гарантийного удержания отдельно указывай: размер удержания, порядок удержания, срок выплаты или возврата, гарантийный период и вариант с банковской гарантией, если это есть в контексте.",
        "Перед финальным ответом проверь, что каждое число подписано правильным смыслом: 3% — это размер/процент, 30 дней — срок выплаты, 3 года или 60 месяцев — период.",
        "Не сокращай составные сроки: если написано «в течение 30 дней после истечения 3 лет», укажи и 30 дней, и событие/период отсчета.",
        "Если в контексте есть несколько разных значений по одному вопросу, например разные редакции договора или допсоглашения, не выбирай одно молча: перечисли варианты и укажи документы или пункты.",
        "Если вопрос задан по нескольким проектам, всем проектам или в контексте много файлов, не ограничивайся одним-двумя пунктами: сгруппируй ответ по проектам/документам и перечисли найденные значения по каждому релевантному источнику.",
        "Если одно и то же значение встречается в нескольких документах, укажи значение один раз и рядом перечисли документы/проекты, где оно подтверждено.",
        ...broadInstructions,
        "В конце ответа укажи источники номерами в формате: Источники: [1], [2]."
      ].join(" ")
    },
    {
      role: "user",
      content: `/no_think\n\nВопрос:\n${question}\n\nКонтекст:\n${context}`
    }
  ];
}

function normalizeFallbackText(value) {
  return String(value || "")
    .toLowerCase()
    .replaceAll("ё", "е")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function fallbackTokens(value) {
  return Array.from(new Set(normalizeFallbackText(value).split(" ").filter((token) => token.length >= 2)));
}

function compactAnswerText(value) {
  return String(value || "")
    .replace(/\r/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

function sanitizeChatTitle(value = "") {
  const title = String(value || "")
    .replace(/<[^>]*>/g, " ")
    .replace(/^[\s"'«»`]+|[\s"'«»`.,:;!?]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return title.slice(0, 72);
}

function fallbackChatTitle(question = "") {
  const title = sanitizeChatTitle(question);
  return title || "Новый чат";
}

function buildChatTitleMessages({ question = "", answer = "", sourceTitle = "" } = {}) {
  const compactQuestion = compactAnswerText(question).slice(0, 900);
  const compactAnswer = compactAnswerText(answer).slice(0, 1400);
  return [
    {
      role: "system",
      content: [
        "Ты называешь чат по смыслу переписки.",
        "Верни только короткое русское название, 2-6 слов.",
        "Не добавляй дату, кавычки, двоеточие, точку, markdown или пояснения.",
        "Не раскрывай секреты, токены, ключи или приватные URL."
      ].join(" ")
    },
    {
      role: "user",
      content: `/no_think\n\nПроект: ${sourceTitle || "Авто"}\n\nВопрос:\n${compactQuestion}\n\nОтвет:\n${compactAnswer}`
    }
  ];
}

async function generateChatTitle({ settings = {}, question = "", answer = "", sourceTitle = "", signal } = {}) {
  const fallbackTitle = fallbackChatTitle(question);
  const candidates = chatLlmCandidates(settings).filter((llm) => llm.enabled !== false);
  if (!candidates.length) return { title: fallbackTitle, fallbackUsed: true };

  let lastError = null;
  for (const candidate of candidates) {
    if (candidate.missingRemoteContext || candidate.missingBaseUrl || candidate.missingApiKey) {
      lastError = new Error("LLM route is not configured for title generation");
      if (!candidate.allowAutoFallback) break;
      continue;
    }

    try {
      const reply = await chatCompletion({
        llm: candidate,
        signal,
        messages: buildChatTitleMessages({ question, answer, sourceTitle })
      });
      const title = sanitizeChatTitle(reply.text);
      if (title) {
        return {
          title,
          model: reply.model,
          provider: candidate.provider,
          fallbackUsed: false
        };
      }
    } catch (error) {
      lastError = error;
      if (signal?.aborted) throw error;
      if (!candidate.allowAutoFallback) break;
    }
  }

  return { title: fallbackTitle, fallbackUsed: true, error: lastError?.message || "" };
}

function resultExcerptForFallback(result, question) {
  const terms = fallbackTokens(question);
  const paragraphs = compactAnswerText(result.text)
    .split(/\n{2,}/)
    .map((part) => part.trim())
    .filter((part) => part.length >= 30);

  const scored = paragraphs.map((text, index) => {
    const normalized = normalizeFallbackText(text);
    const score = terms.reduce((sum, term) => sum + (normalized.includes(term) ? 1 : 0), 0)
      + (/\d{2}\.\d{2}\.\d{4}/.test(text) ? 0.5 : 0);
    return { text, index, score };
  });

  const selected = scored
    .filter((item) => item.score > 0)
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .slice(0, 4)
    .sort((left, right) => left.index - right.index)
    .map((item) => item.text);

  const excerpt = selected.length ? selected.join("\n\n") : compactAnswerText(result.text).slice(0, 900);
  return excerpt.length > 1200 ? `${excerpt.slice(0, 1200).trim()}...` : excerpt;
}

function llmErrorAnswer(error, results, question) {
  const topResults = results.slice(0, 3);
  const lines = [
    `Модель временно не ответила (${String(error?.message || error || "ошибка генерации")}). Индекс при этом работает, ниже самые релевантные выдержки:`
  ];

  topResults.forEach((result, index) => {
    lines.push(`\n[${index + 1}] ${result.citationLabel || formatCitationLabel(result)}\n${resultExcerptForFallback(result, question)}`);
  });

  lines.push(`\nИсточники: ${topResults.map((_result, index) => `[${index + 1}]`).join(", ")}.`);
  return lines.join("\n");
}

function isContextSizeError(error) {
  return /context size|context length|n_ctx|n_keep/i.test(String(error?.message || error || ""));
}

const chatContextProfiles = [
  { name: "compact", maxSources: 8, maxCharsPerSource: 1400 },
  { name: "tight", maxSources: 6, maxCharsPerSource: 900 }
];

const broadChatContextProfiles = [
  { name: "broad", maxSources: 14, maxCharsPerSource: 1200 },
  { name: "broad-tight", maxSources: 10, maxCharsPerSource: 900 }
];

const allSourcesChatContextProfiles = [
  { name: "all-sources-compact", maxSources: 16, maxCharsPerSource: 900 },
  { name: "all-sources-tight", maxSources: 12, maxCharsPerSource: 700 }
];

const allSourcesBroadChatContextProfiles = [
  { name: "all-sources-broad", maxSources: 20, maxCharsPerSource: 900 },
  { name: "all-sources-broad-tight", maxSources: 14, maxCharsPerSource: 700 }
];

function chatContextProfilesForRequest({ sourceId = "", broadAnswer = false } = {}) {
  if (sourceId) return broadAnswer ? broadChatContextProfiles : chatContextProfiles;
  return broadAnswer ? allSourcesBroadChatContextProfiles : allSourcesChatContextProfiles;
}

function chatSearchLimit({ searchAllSources = false, broadAnswer = false } = {}) {
  if (searchAllSources) return broadAnswer ? 36 : 24;
  return broadAnswer ? 20 : 12;
}

async function runChatLlm({
  llmCandidates,
  results,
  question,
  sourceId,
  broadAnswer = false,
  signal,
  stream = false,
  onToken = () => {}
}) {
  let reply;
  let usedLlm = null;
  let lastLlmError = null;
  let promptChars = 0;
  const llmStartedAt = Date.now();
  const contextProfiles = chatContextProfilesForRequest({ sourceId, broadAnswer });

  for (let candidateIndex = 0; candidateIndex < llmCandidates.length; candidateIndex += 1) {
    const candidateLlm = llmCandidates[candidateIndex];
    if (candidateLlm.missingRemoteContext) {
      lastLlmError = new Error("Удаленный контекст выключен. Включите remote context в настройках LLM, чтобы отправлять RAG-контекст в удаленную LM Studio.");
      if (!candidateLlm.allowAutoFallback) break;
      continue;
    }

    if (candidateLlm.missingBaseUrl || candidateLlm.missingApiKey) {
      lastLlmError = new Error(`${providerLabel(candidateLlm.provider)} не настроен. Проверьте URL и токен в настройках LLM.`);
      if (!candidateLlm.allowAutoFallback) break;
      continue;
    }

    const llmRequestId = crypto.randomUUID();
    updateLlmRequest(llmRequestId, {
      phase: "generating",
      model: candidateLlm.model,
      provider: candidateLlm.provider,
      selectedBy: candidateLlm.selectedBy || "",
      autoFallbackReason: candidateLlm.autoFallbackReason || "",
      timeoutSeconds: candidateLlm.timeoutSeconds,
      sourceId,
      sourcesCount: results.length,
      promptChars: 0
    });

    try {
      for (let attempt = 0; attempt < contextProfiles.length; attempt += 1) {
        const contextProfile = contextProfiles[attempt];
        const context = buildRagContext(results, contextProfile);
        updateLlmRequest(llmRequestId, {
          phase: attempt > 0 ? "compacting_context" : "generating",
          promptChars: context.length,
          contextProfile: contextProfile.name
        });
        promptChars = context.length;

        try {
          const completionArgs = {
            llm: candidateLlm,
            signal,
            onProgress: (progress) => updateLlmRequest(llmRequestId, progress),
            messages: buildChatMessages(question, context, { broadAnswer })
          };
          reply = stream
            ? await chatCompletionStream({ ...completionArgs, onToken })
            : await chatCompletion(completionArgs);
          break;
        } catch (error) {
          lastLlmError = error;
          if (!isContextSizeError(error) || attempt === contextProfiles.length - 1) throw error;
        }
      }

      if (!reply) throw lastLlmError || new Error("LLM response is empty");
      usedLlm = { ...candidateLlm, fallbackUsed: candidateIndex > 0 };
      recordLlmGeneration(candidateLlm, reply, {
        selectedBy: candidateLlm.selectedBy || "",
        autoFallbackReason: candidateLlm.autoFallbackReason || "",
        sourceId,
        sourcesCount: results.length,
        promptChars: llmRequests.get(llmRequestId)?.promptChars || 0
      });
      finishLlmRequest(llmRequestId, "completed");
      break;
    } catch (error) {
      finishLlmRequest(llmRequestId, signal?.aborted ? "cancelled" : "failed", error.message);
      lastLlmError = error;
      if (signal?.aborted) throw error;
      if (!candidateLlm.allowAutoFallback) break;
    }
  }

  return {
    reply,
    usedLlm,
    lastLlmError,
    promptChars,
    llmMs: Date.now() - llmStartedAt
  };
}

function activeLlmRequests() {
  return Array.from(llmRequests.values()).map((request) => ({
    id: request.id,
    phase: request.phase,
    model: request.model,
    modelState: request.modelState || "",
    modelLoaded: request.modelLoaded === undefined ? null : Boolean(request.modelLoaded),
    provider: request.provider,
    providerLabel: providerLabel(request.provider),
    selectedBy: request.selectedBy || "",
    autoFallbackReason: request.autoFallbackReason || "",
    timeoutSeconds: request.timeoutSeconds || 0,
    sourceId: request.sourceId,
    sourcesCount: request.sourcesCount || 0,
    promptChars: request.promptChars || 0,
    contextProfile: request.contextProfile || "",
    startedAt: request.startedAt,
    updatedAt: request.updatedAt
  }));
}

function activeLlmRequestsForProvider(provider) {
  const normalized = normalizeLlmProvider(provider);
  return activeLlmRequests().filter((request) => request.provider === normalized);
}

function llmAuthHeaders(llm) {
  const apiKey = String(llm.apiKey || "lm-studio").trim();
  return {
    "Content-Type": "application/json",
    "Authorization": /^Bearer\s+/i.test(apiKey) ? apiKey : `Bearer ${apiKey}`
  };
}

function compactHttpError(text) {
  return String(text || "")
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 240);
}

async function timedJsonRequest(url, llm, timeoutSeconds = 5) {
  const controller = new AbortController();
  const started = Date.now();
  const timeout = setTimeout(() => controller.abort(), Math.max(1, timeoutSeconds) * 1000);
  try {
    const response = await fetch(url, {
      headers: llmAuthHeaders(llm),
      signal: controller.signal
    });
    const latencyMs = Date.now() - started;
    const text = await response.text();
    let payload = null;
    try {
      payload = text ? JSON.parse(text) : null;
    } catch {
      payload = null;
    }

    return {
      ok: response.ok,
      status: response.status,
      latencyMs,
      payload,
      error: response.ok ? "" : `HTTP ${response.status}${text ? `: ${compactHttpError(text)}` : ""}`
    };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      latencyMs: Date.now() - started,
      payload: null,
      error: error.name === "AbortError" ? "timeout" : error.message
    };
  } finally {
    clearTimeout(timeout);
  }
}

function summarizeModels(models) {
  const loaded = models.filter((model) => model.loaded || model.state === "loaded");
  return {
    count: models.length,
    loadedCount: loaded.length,
    loaded: loaded.slice(0, 8),
    items: models
  };
}

function configuredModelSummary(configuredModel, models) {
  const requested = String(configuredModel || "").trim();
  if (!requested) return { id: "", matchedId: "", available: false, loaded: false, state: "" };

  const modelIds = models.map((model) => model.id).filter(Boolean);
  const matchedId = matchConfiguredModel(requested, modelIds);
  const row = models.find((model) => model.id === matchedId);
  if (!row) {
    return {
      id: requested,
      matchedId: "",
      available: false,
      loaded: false,
      state: "missing"
    };
  }

  return {
    ...row,
    id: requested,
    matchedId: row.id,
    available: true,
    loaded: Boolean(row.loaded || row.state === "loaded"),
    state: row.state || (row.loaded ? "loaded" : "")
  };
}

function generationStatsFromReply(reply = {}) {
  const stats = reply.stats || {};
  const usage = reply.usage || {};
  return {
    endpoint: reply.endpoint || "",
    tokensPerSecond: Number(stats.tokens_per_second ?? stats.tokensPerSecond ?? 0) || null,
    timeToFirstToken: Number(stats.time_to_first_token ?? stats.timeToFirstToken ?? 0) || null,
    generationTime: Number(stats.generation_time ?? stats.generationTime ?? 0) || null,
    stopReason: stats.stop_reason || stats.stopReason || "",
    promptTokens: Number(usage.prompt_tokens ?? usage.promptTokens ?? 0) || null,
    completionTokens: Number(usage.completion_tokens ?? usage.completionTokens ?? 0) || null,
    totalTokens: Number(usage.total_tokens ?? usage.totalTokens ?? 0) || null,
    modelInfo: reply.modelInfo || null,
    runtime: reply.runtime || null
  };
}

function recordLlmGeneration(llm, reply, meta = {}) {
  const provider = normalizeLlmProvider(llm?.provider);
  const generation = {
    provider,
    providerLabel: providerLabel(provider),
    model: reply?.model || llm?.model || "",
    checkedAt: new Date().toISOString(),
    ...generationStatsFromReply(reply),
    ...meta
  };
  lastLlmGenerations.set(provider, generation);
  return generation;
}

function updateLlmRequest(id, patch) {
  const now = new Date().toISOString();
  const existing = llmRequests.get(id) || { id, startedAt: now };
  llmRequests.set(id, { ...existing, ...patch, updatedAt: now });
}

function finishLlmRequest(id, status = "completed", error = "") {
  const request = llmRequests.get(id);
  if (request) {
    lastLlmActivity = {
      ...request,
      status,
      error,
      finishedAt: new Date().toISOString()
    };
  }
  llmRequests.delete(id);
}

function readCpuPercent() {
  const cpus = os.cpus();
  const sample = cpus.reduce(
    (acc, cpu) => {
      const times = cpu.times;
      acc.idle += times.idle;
      acc.total += times.user + times.nice + times.sys + times.idle + times.irq;
      return acc;
    },
    { idle: 0, total: 0 }
  );

  if (!cpuUsageSample) {
    cpuUsageSample = sample;
    return 0;
  }

  const idleDelta = sample.idle - cpuUsageSample.idle;
  const totalDelta = sample.total - cpuUsageSample.total;
  cpuUsageSample = sample;

  if (totalDelta <= 0) return 0;
  return Math.max(0, Math.min(100, Math.round((1 - idleDelta / totalDelta) * 100)));
}

function parseTasklistCsv(stdout) {
  const rows = [];
  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("INFO:")) continue;

    const columns = [];
    let value = "";
    let quoted = false;
    for (let index = 0; index < line.length; index += 1) {
      const char = line[index];
      const next = line[index + 1];
      if (char === '"' && next === '"') {
        value += '"';
        index += 1;
      } else if (char === '"') {
        quoted = !quoted;
      } else if (char === "," && !quoted) {
        columns.push(value);
        value = "";
      } else {
        value += char;
      }
    }
    columns.push(value);
    rows.push(columns);
  }
  return rows;
}

async function readWindowsComputerUsage() {
  const totalMemoryMb = Math.round(os.totalmem() / 1024 / 1024);
  const freeMemoryMb = Math.round(os.freemem() / 1024 / 1024);
  const memoryPercent = Math.round(((os.totalmem() - os.freemem()) / os.totalmem()) * 100);
  const processes = [];

  try {
    const { stdout } = await execFileAsync("tasklist.exe", ["/FO", "CSV", "/NH"], {
      timeout: 2500,
      windowsHide: true,
      maxBuffer: 1024 * 1024 * 4
    });

    for (const row of parseTasklistCsv(stdout)) {
      const [name, pid, , , memory] = row;
      if (!/^(LM Studio|LMStudio|lmstudio|llama-server|llama\.cpp|lmlink)/i.test(name || "")) continue;
      const memoryKb = Number(String(memory || "").replace(/[^\d]/g, ""));
      processes.push({
        pid: Number(pid),
        name,
        cpuPercent: 0,
        memoryMb: memoryKb ? Math.round(memoryKb / 1024) : 0
      });
    }
  } catch {
    // Process telemetry is helpful, but the UI can still show system load without it.
  }

  return {
    platform: "win32",
    cpuPercent: readCpuPercent(),
    memoryPercent,
    totalMemoryMb,
    freeMemoryMb,
    processes
  };
}

async function readComputerUsage() {
  if (Date.now() - usageCache.at < 2500 && usageCache.payload) return usageCache.payload;

  let usage;
  try {
    usage = process.platform === "win32"
      ? await readWindowsComputerUsage()
      : {
          platform: process.platform,
          cpuPercent: 0,
          memoryPercent: Math.round(((os.totalmem() - os.freemem()) / os.totalmem()) * 100),
          totalMemoryMb: Math.round(os.totalmem() / 1024 / 1024),
          freeMemoryMb: Math.round(os.freemem() / 1024 / 1024),
          processes: []
        };
  } catch (error) {
    usage = {
      platform: process.platform,
      cpuPercent: 0,
      memoryPercent: Math.round(((os.totalmem() - os.freemem()) / os.totalmem()) * 100),
      totalMemoryMb: Math.round(os.totalmem() / 1024 / 1024),
      freeMemoryMb: Math.round(os.freemem() / 1024 / 1024),
      processes: [],
      error: error.message
    };
  }

  usageCache = { at: Date.now(), payload: usage };
  return usage;
}

app.get("/api/health", async (_req, res) => {
  res.json({ ok: true });
});

function scheduleBackendRestart() {
  const entry = path.resolve(process.argv[1] || path.join(projectRoot, "apps", "rag-api", "src", "server.js"));
  const helperScript = `
const { spawn } = require("node:child_process");
const entry = ${JSON.stringify(entry)};
const cwd = ${JSON.stringify(projectRoot)};
setTimeout(() => {
  const child = spawn(process.execPath, [entry], {
    cwd,
    env: process.env,
    detached: true,
    stdio: "ignore"
  });
  child.unref();
  setTimeout(() => process.exit(0), 500);
}, 1200);
`;
  const helper = spawn(process.execPath, ["-e", helperScript], {
    cwd: projectRoot,
    env: { ...process.env, LOCALAI_RESTART_HELPER: "1" },
    detached: true,
    stdio: "ignore"
  });
  helper.unref();
  setTimeout(() => process.exit(0), 250).unref?.();
}

function scheduleBackendStop() {
  setTimeout(() => process.exit(0), 250).unref?.();
}

function portalServiceResult(service, patch = {}) {
  return {
    service,
    state: patch.state || "unknown",
    running: Boolean(patch.running),
    stopped: Boolean(patch.stopped),
    skipped: Boolean(patch.skipped),
    manageable: patch.manageable !== false,
    reason: patch.reason || ""
  };
}

function abortPortalBackendWork() {
  const now = new Date().toISOString();
  let requested = 0;

  for (const [jobId, controller] of jobControllers.entries()) {
    const job = jobs.get(jobId);
    if (!job || job.status !== "running") continue;
    requested += 1;
    Object.assign(job, {
      phase: job.phase || "stopping",
      message: "Portal shutdown requested",
      stopRequestedAt: now,
      updatedAt: now
    });
    jobs.set(jobId, job);
    persistJob(job).catch(() => {});
    controller.abort(new Error("Portal shutdown requested"));
  }

  if (agentRunController && !agentRunController.signal.aborted) {
    requested += 1;
    agentRunController.abort(new Error("Portal shutdown requested"));
  }

  return portalServiceResult("backend-work", {
    state: requested ? "stopping" : "idle",
    stopped: requested > 0,
    skipped: requested === 0,
    reason: requested ? "abort_requested" : "not_running"
  });
}

async function stopManagedPortalProcess(service, statusFn, stopFn, settings) {
  try {
    const current = await statusFn(settings);
    if (!current.manageable) {
      return portalServiceResult(service, {
        state: current.state || (current.running ? "running" : "stopped"),
        running: Boolean(current.running),
        skipped: true,
        manageable: false,
        reason: "unmanaged"
      });
    }
    if (!current.running) {
      return portalServiceResult(service, {
        state: "stopped",
        stopped: true,
        skipped: true,
        reason: "not_running"
      });
    }

    const next = await stopFn(settings);
    return portalServiceResult(service, {
      state: next.state || (next.running ? "running" : "stopped"),
      running: Boolean(next.running),
      stopped: !next.running,
      reason: next.running ? "still_running" : ""
    });
  } catch {
    return portalServiceResult(service, {
      state: "error",
      running: true,
      stopped: false,
      reason: "stop_failed"
    });
  }
}

function configuredEnvValue(...names) {
  for (const name of names) {
    const value = String(process.env[name] || "").trim();
    if (value) return value;
  }
  return "";
}

function configuredPath(value = "") {
  const raw = String(value || "").trim();
  if (!raw) return "";
  return path.resolve(projectRoot, raw);
}

async function fileExists(filePath = "") {
  if (!filePath) return false;
  try {
    const stats = await fs.stat(filePath);
    return stats.isFile();
  } catch {
    return false;
  }
}

async function directoryExists(directoryPath = "") {
  if (!directoryPath) return false;
  try {
    const stats = await fs.stat(directoryPath);
    return stats.isDirectory();
  } catch {
    return false;
  }
}

async function findComposeFileInDirectory(directoryPath = "") {
  if (!(await directoryExists(directoryPath))) return "";
  for (const name of ["docker-compose.yaml", "docker-compose.yml", "compose.yaml", "compose.yml"]) {
    const candidate = path.join(directoryPath, name);
    if (await fileExists(candidate)) return candidate;
  }
  return "";
}

async function resolveDifyComposeFileFromEnv() {
  const explicitCompose = configuredPath(configuredEnvValue("LOCALAI_DIFY_COMPOSE_FILE"));
  if (await fileExists(explicitCompose)) return explicitCompose;

  const explicitDirectory = configuredPath(configuredEnvValue("LOCALAI_DIFY_DIR"));
  for (const candidate of [explicitDirectory, explicitDirectory ? path.join(explicitDirectory, "docker") : ""]) {
    const composeFile = await findComposeFileInDirectory(candidate);
    if (composeFile) return composeFile;
  }

  return "";
}

async function runDifyStopCommand(command) {
  const directory = configuredPath(configuredEnvValue("LOCALAI_DIFY_STOP_DIR", "LOCALAI_DIFY_START_DIR", "LOCALAI_DIFY_DIR")) || projectRoot;
  if (!(await directoryExists(directory))) {
    throw new Error("Dify stop directory was not found");
  }

  await execFileAsync("powershell.exe", [
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-Command",
    command
  ], {
    cwd: directory,
    env: process.env,
    windowsHide: true,
    timeout: 60000,
    maxBuffer: 1024 * 128
  });
}

async function runDifyComposeDown(composeFile) {
  const composeDirectory = path.dirname(composeFile);
  const composeName = path.basename(composeFile);
  await execFileAsync("docker", ["compose", "-f", composeName, "down"], {
    cwd: composeDirectory,
    env: process.env,
    windowsHide: true,
    timeout: 90000,
    maxBuffer: 1024 * 128
  });
}

async function waitForDifyStopped(timeoutMs = 20000) {
  const startedAt = Date.now();
  let status = await difyRuntimeStatus();
  if (!status.configured) return null;

  while (Date.now() - startedAt < timeoutMs) {
    if (!status.reachable) return status;
    await new Promise((resolve) => setTimeout(resolve, 1000));
    status = await difyRuntimeStatus();
  }

  return status;
}

async function stopDifyPortalProcess() {
  try {
    const current = await difyRuntimeStatus();
    const stopCommand = configuredEnvValue("LOCALAI_DIFY_STOP_COMMAND");
    const composeFile = await resolveDifyComposeFileFromEnv();

    if (!stopCommand && !composeFile) {
      return portalServiceResult("dify", {
        state: current.reachable ? "running" : "stopped",
        running: Boolean(current.reachable),
        stopped: !current.reachable,
        skipped: true,
        manageable: false,
        reason: current.configured ? "unmanaged" : "not_configured"
      });
    }

    if (stopCommand) {
      await runDifyStopCommand(stopCommand);
    } else {
      await runDifyComposeDown(composeFile);
    }

    const next = await waitForDifyStopped();
    const running = next ? Boolean(next.reachable) : false;
    return portalServiceResult("dify", {
      state: running ? "running" : "stopped",
      running,
      stopped: !running,
      reason: running ? "still_running" : ""
    });
  } catch {
    return portalServiceResult("dify", {
      state: "error",
      running: true,
      stopped: false,
      reason: "stop_failed"
    });
  }
}

async function stopPortalBackgroundProcesses() {
  let settings = {};
  let settingsResult = null;
  try {
    settings = await readSettings();
  } catch {
    settingsResult = portalServiceResult("settings", {
      state: "error",
      skipped: true,
      manageable: false,
      reason: "read_failed"
    });
  }

  const services = [
    abortPortalBackendWork(),
    ...(settingsResult ? [settingsResult] : [])
  ];

  const stopped = await Promise.all([
    stopManagedPortalProcess("reranker", managedRerankerStatus, stopManagedReranker, settings.reranker),
    stopManagedPortalProcess("qdrant", managedQdrantStatus, stopManagedQdrant, settings.vectorStore),
    stopDifyPortalProcess()
  ]);

  return services.concat(stopped);
}

app.get("/api/system/backend/status", async (_req, res) => {
  res.json({
    ok: true,
    running: true,
    state: "running",
    manageable: true
  });
});

app.post("/api/system/backend/start", async (_req, res) => {
  res.json({
    ok: true,
    running: true,
    state: "running",
    alreadyRunning: true,
    manageable: true
  });
});

app.post("/api/system/backend/stop", async (_req, res, next) => {
  try {
    res.status(202).json({
      ok: true,
      running: false,
      state: "stopping",
      stopping: true,
      manageable: true
    });
    scheduleBackendStop();
  } catch (error) {
    next(error);
  }
});

app.post("/api/system/portal/stop", async (_req, res, next) => {
  try {
    const services = await stopPortalBackgroundProcesses();
    res.status(202).json({
      ok: true,
      running: false,
      state: "stopping",
      stopping: true,
      manageable: true,
      services
    });
    scheduleBackendStop();
  } catch (error) {
    next(error);
  }
});

app.post("/api/system/restart", async (_req, res, next) => {
  try {
    res.status(202).json({
      ok: true,
      restarting: true,
      message: "Backend restart scheduled"
    });
    scheduleBackendRestart();
  } catch (error) {
    next(error);
  }
});

app.post("/api/system/backend/restart", async (_req, res, next) => {
  try {
    res.status(202).json({
      ok: true,
      restarting: true,
      message: "Backend restart scheduled"
    });
    scheduleBackendRestart();
  } catch (error) {
    next(error);
  }
});

app.get("/api/system/reranker/status", async (_req, res, next) => {
  try {
    const settings = await readSettings();
    res.json(await managedRerankerStatus(settings.reranker));
  } catch (error) {
    next(error);
  }
});

app.post("/api/system/reranker/start", async (_req, res, next) => {
  try {
    const settings = await readSettings();
    res.status(202).json(await startManagedReranker(settings.reranker));
  } catch (error) {
    next(error);
  }
});

app.post("/api/system/reranker/stop", async (_req, res, next) => {
  try {
    const settings = await readSettings();
    res.status(202).json(await stopManagedReranker(settings.reranker));
  } catch (error) {
    next(error);
  }
});

app.post("/api/system/reranker/restart", async (_req, res, next) => {
  try {
    const settings = await readSettings();
    res.status(202).json(await restartManagedReranker(settings.reranker));
  } catch (error) {
    next(error);
  }
});

app.get("/api/system/qdrant/status", async (_req, res, next) => {
  try {
    const settings = await readSettings();
    res.json(await managedQdrantStatus(settings.vectorStore));
  } catch (error) {
    next(error);
  }
});

app.post("/api/system/qdrant/start", async (_req, res, next) => {
  try {
    const settings = await readSettings();
    res.status(202).json(await startManagedQdrant(settings.vectorStore));
  } catch (error) {
    next(error);
  }
});

app.post("/api/system/qdrant/stop", async (_req, res, next) => {
  try {
    const settings = await readSettings();
    res.status(202).json(await stopManagedQdrant(settings.vectorStore));
  } catch (error) {
    next(error);
  }
});

app.post("/api/system/qdrant/restart", async (_req, res, next) => {
  try {
    const settings = await readSettings();
    res.status(202).json(await restartManagedQdrant(settings.vectorStore));
  } catch (error) {
    next(error);
  }
});

app.get("/api/settings", async (_req, res, next) => {
  try {
    res.json(publicSettings(await readSettings()));
  } catch (error) {
    next(error);
  }
});

app.put("/api/settings", async (req, res, next) => {
  try {
    res.json(publicSettings(await writeSettings({
      dataDir: req.body.dataDir,
      llm: req.body.llm,
      embeddings: req.body.embeddings,
      vectorStore: req.body.vectorStore,
      reranker: req.body.reranker,
      search: req.body.search
    })));
  } catch (error) {
    next(error);
  }
});

app.get("/api/vector-store/status", async (_req, res, next) => {
  try {
    const settings = await readSettings();
    res.json(await qdrantStatus(settings.vectorStore));
  } catch (error) {
    next(error);
  }
});

app.get("/api/index/status", async (_req, res, next) => {
  try {
    const [sources, persistedJobs, manifest, settings] = await Promise.all([
      readSources(),
      readJobs(),
      readManifest(),
      readSettings()
    ]);
    res.json(buildIndexOverview({
      sources,
      persistedJobs,
      manifest,
      vectorStore: await safeQdrantStatus(settings)
    }));
  } catch (error) {
    next(error);
  }
});

app.post("/api/index/refresh", async (_req, res, next) => {
  try {
    res.json(await refreshExistingIndexState());
  } catch (error) {
    next(error);
  }
});

app.get("/api/integrations/status", async (_req, res, next) => {
  try {
    const settings = await readSettings();
    res.json({
      vectorStore: await qdrantStatus(settings.vectorStore),
      reranker: rerankerStatus(settings.reranker),
      pdf: converterStatus(),
      googleAuth: googleAuthPublicStatus()
    });
  } catch (error) {
    next(error);
  }
});

app.get("/api/google/auth/status", async (_req, res, next) => {
  try {
    res.json(googleAuthPublicStatus());
  } catch (error) {
    next(error);
  }
});

app.post("/api/google/auth/start", async (_req, res, next) => {
  try {
    res.status(202).json(startGoogleAuth());
  } catch (error) {
    next(error);
  }
});

app.post("/api/google/auth/logout", async (_req, res, next) => {
  try {
    res.json(clearGoogleAuth());
  } catch (error) {
    next(error);
  }
});

app.get("/api/google/auth/callback", async (req, res, next) => {
  try {
    if (req.query.error) throw new Error(`Google OAuth denied access: ${req.query.error}`);
    await completeGoogleAuth({
      code: String(req.query.code || ""),
      state: String(req.query.state || "")
    });
    res.type("html").send(`<!doctype html>
<html lang="ru">
  <head><meta charset="utf-8"><title>Google login complete</title></head>
  <body>
    <h1>Google login complete</h1>
    <p>Return to LocalAI and refresh integrations status.</p>
    <script>window.close();</script>
  </body>
</html>`);
  } catch (error) {
    next(error);
  }
});

app.get("/api/vector-store/backfill/sources", async (_req, res, next) => {
  try {
    const [sources, chunks, vectors, settings] = await Promise.all([readSources(), readChunks(), readVectors(), readSettings()]);
    const rows = await vectorBackfillRowsForState({ sources, chunks, vectors, settings });
    res.json({ sources: rows });
  } catch (error) {
    next(error);
  }
});

app.post("/api/vector-store/backfill", async (req, res, next) => {
  try {
    const requestedSourceId = String(req.body?.sourceId || "").trim();
    if (!requestedSourceId) return res.status(400).json({ error: "sourceId is required" });

    const [sources, chunks, vectors, settings] = await Promise.all([readSources(), readChunks(), readVectors(), readSettings()]);
    const rows = await vectorBackfillRowsForState({ sources, chunks, vectors, settings });
    const row = rows.find((item) => item.id === requestedSourceId);
    if (!row) return res.status(404).json({ error: "source not found" });
    if (!row.chunks) return res.status(400).json({ error: "source has no chunks; index it first" });
    if (row.ready) {
      const job = buildCompletedVectorBackfillJob({
        row,
        id: crypto.randomUUID()
      });
      jobs.set(job.id, job);
      await persistJob(job);
      return res.status(200).json(publicJobStatus(job));
    }
    if (!settings.embeddings?.enabled) return res.status(400).json({ error: "embeddings are disabled in settings" });

    const existing = Array.from(jobs.values()).find((job) =>
      job.type === "vector_backfill"
      && job.sourceId === row.id
      && job.status === "running"
    );
    if (existing) return res.status(202).json(publicJobStatus(existing));

    const sourceChunks = chunks.filter((chunk) => chunk.sourceId === row.id);
    const job = {
      id: crypto.randomUUID(),
      type: "vector_backfill",
      sourceId: row.id,
      sourceTitle: row.title,
      status: "running",
      phase: "queued",
      message: "Векторизация в Qdrant",
      vectorsTotal: sourceChunks.length,
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
      qdrantError: row.qdrantError,
      warning: row.warning,
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };

    jobs.set(job.id, job);
    await persistJob(job);
    res.status(202).json(publicJobStatus(job));

    ensureChunkEmbeddings({
      sourceId: row.id,
      chunks: sourceChunks,
      onProgress: (progress) => {
        Object.assign(job, progress, {
          type: "vector_backfill",
          status: "running",
          sourceId: row.id,
          sourceTitle: row.title,
          updatedAt: new Date().toISOString()
        });
        jobs.set(job.id, job);
        persistJob(job).catch(() => {});
      }
    })
      .then((result) => {
        const completedVectorCount = optionalNumber(result.vectorCount)
          ?? optionalNumber(result.qdrantPoints)
          ?? optionalNumber(result.vectorsTotal)
          ?? job.storedVectors
          ?? 0;
        const vectorProviderUsed = result.vectorProviderUsed || job.vectorProviderUsed || "";
        const completedTotal = Number(result.vectorsTotal || job.vectorsTotal || 0);
        Object.assign(job, result, {
          type: "vector_backfill",
          status: "completed",
          phase: "done",
          jsonVectors: vectorProviderUsed === "json" ? completedVectorCount : job.jsonVectors,
          qdrantVectors: vectorProviderUsed === "qdrant" ? completedVectorCount : job.qdrantVectors,
          storedVectors: completedVectorCount,
          ready: completedTotal > 0 && completedVectorCount >= completedTotal,
          message: "Готово",
          updatedAt: new Date().toISOString(),
          finishedAt: new Date().toISOString()
        });
        jobs.set(job.id, job);
        return persistJob(job);
      })
      .catch((error) => {
        Object.assign(job, {
          type: "vector_backfill",
          status: "failed",
          phase: "error",
          message: error.message,
          qdrantError: error.message,
          updatedAt: new Date().toISOString(),
          finishedAt: new Date().toISOString()
        });
        jobs.set(job.id, job);
        return persistJob(job);
      });
  } catch (error) {
    next(error);
  }
});

app.get("/api/llm/models", async (req, res, next) => {
  try {
    const settings = await readSettings();
    const provider = normalizeLlmProvider(req.query.provider, settings.llm?.provider);
    const llm = selectedLlmSettings(settings, provider);
    if (llm.missingBaseUrl) throw new Error(`${providerLabel(provider)}: baseUrl is required`);
    if (llm.missingApiKey) throw new Error(`${providerLabel(provider)}: token is required`);
    const models = await listLlmModels(llm);
    res.json({
      models,
      provider: llm.provider,
      llm: publicLlmSettings(llm, { maskApiKey: true }),
      embeddings: publicEmbeddingSettings(settings.embeddings || {}),
      vectorStore: publicVectorStoreSettings(settings.vectorStore || {})
    });
  } catch (error) {
    next(error);
  }
});

app.get("/api/llm/status", async (req, res) => {
  const settings = await readSettings();
  const provider = normalizeLlmProvider(req.query.provider, settings.llm?.provider);
  const llm = selectedLlmSettings(settings, provider);
  const embeddings = settings.embeddings || {};
  const embeddingChecked = llm.provider === "local";

  try {
    if (llm.missingBaseUrl) throw new Error(`${providerLabel(provider)}: baseUrl is required`);
    if (llm.missingApiKey) throw new Error(`${providerLabel(provider)}: token is required`);
    const models = await listLlmModels({ ...llm, timeoutSeconds: 5 });
    const configuredChatModel = llm.model || "";
    const matchedChatModel = matchConfiguredModel(configuredChatModel, models);
    const chatModel = matchedChatModel || configuredChatModel || models.find((model) => !/embed|embedding/i.test(model)) || "";
    const embeddingModel = embeddings.model || models.find((model) => /embed|embedding/i.test(model)) || "";
    const embeddingModelAvailable = embeddingChecked
      ? Boolean(embeddingModel && models.includes(embeddingModel))
      : true;

    res.json({
      online: true,
      checkedAt: new Date().toISOString(),
      provider: llm.provider,
      providerLabel: providerLabel(llm.provider),
      activeProvider: normalizeLlmProvider(settings.llm?.provider),
      baseUrl: llm.baseUrl,
      modelsCount: models.length,
      chatModel,
      configuredChatModel,
      resolvedChatModel: matchedChatModel && matchedChatModel !== configuredChatModel ? matchedChatModel : "",
      embeddingModel,
      embeddingChecked,
      chatModelAvailable: Boolean(chatModel && matchConfiguredModel(chatModel, models)),
      embeddingModelAvailable,
      activeRequests: activeLlmRequests()
    });
  } catch (error) {
    res.json({
      online: false,
      checkedAt: new Date().toISOString(),
      provider: llm.provider,
      providerLabel: providerLabel(llm.provider),
      activeProvider: normalizeLlmProvider(settings.llm?.provider),
      baseUrl: llm.baseUrl,
      error: error.message,
      activeRequests: activeLlmRequests()
    });
  }
});

app.get("/api/llm/diagnostics", async (req, res) => {
  const settings = await readSettings();
  const requestedProvider = String(req.query.provider || "token").trim().toLowerCase();
  const provider = requestedProvider === "local" ? "local" : "token";
  const llm = selectedLlmSettings(settings, provider);
  const activeRequests = activeLlmRequestsForProvider(llm.provider);
  const basePayload = {
    checkedAt: new Date().toISOString(),
    provider: llm.provider,
    providerLabel: providerLabel(llm.provider),
    activeProvider: normalizeLlmProvider(settings.llm?.provider),
    baseUrl: llm.baseUrl,
    remoteRuntime: llm.provider === "remote" ? normalizeRemoteRuntime(llm.runtime) : "",
    nativeBaseUrl: lmStudioNativeBaseUrl(llm.baseUrl),
    configured: !(llm.missingBaseUrl || llm.missingApiKey),
    activeRequests,
    activeRequestsCount: activeRequests.length,
    busy: activeRequests.length > 0,
    lastGeneration: lastLlmGenerations.get(llm.provider) || null
  };

  if (llm.missingBaseUrl || llm.missingApiKey) {
    return res.json({
      ...basePayload,
      online: false,
      error: llm.missingBaseUrl
        ? `${providerLabel(llm.provider)}: baseUrl is required`
        : `${providerLabel(llm.provider)}: token is required`,
      openai: null,
      nativeRest: null,
      configuredModel: configuredModelSummary(llm.model, []),
      models: summarizeModels([])
    });
  }

  if (llm.provider === "remote" && !isLmStudioRuntime(llm)) {
    const openai = await timedJsonRequest(`${llm.baseUrl}/models`, llm, 6);
    const openaiModels = modelRowsFromPayload(openai.payload);
    return res.json({
      ...basePayload,
      online: openai.ok,
      latencyMs: openai.latencyMs,
      openai: {
        ok: openai.ok,
        status: openai.status,
        latencyMs: openai.latencyMs,
        modelsCount: openaiModels.length,
        error: openai.error
      },
      nativeRest: {
        available: false,
        skipped: true,
        reason: "openai-compatible runtime"
      },
      configuredModel: configuredModelSummary(llm.model, openaiModels),
      models: summarizeModels(openaiModels)
    });
  }

  const nativeBaseUrl = lmStudioNativeBaseUrl(llm.baseUrl);
  const [openai, nativeV1, nativeV0] = await Promise.all([
    timedJsonRequest(`${llm.baseUrl}/models`, llm, 6),
    timedJsonRequest(`${nativeBaseUrl}/api/v1/models`, llm, 6),
    timedJsonRequest(`${nativeBaseUrl}/api/v0/models`, llm, 6)
  ]);

  const openaiModels = modelRowsFromPayload(openai.payload);
  const nativeV1Models = modelRowsFromPayload(nativeV1.payload);
  const nativeV0Models = modelRowsFromPayload(nativeV0.payload);
  const nativeModels = mergeModelRows(
    nativeV1.ok ? nativeV1Models : [],
    nativeV0.ok ? nativeV0Models : []
  );
  const nativePreferred = nativeV1.ok && nativeV1Models.length
    ? "v1"
    : nativeV0.ok
      ? "v0"
      : nativeV1.ok
        ? "v1"
        : "";
  const models = nativeModels.length ? mergeModelRows(nativeModels, openaiModels) : openaiModels;
  const okLatencies = [openai, nativeV1, nativeV0].filter((item) => item.ok).map((item) => item.latencyMs);

  res.json({
    ...basePayload,
    online: openai.ok || nativeV1.ok || nativeV0.ok,
    latencyMs: okLatencies.length ? Math.min(...okLatencies) : openai.latencyMs,
    openai: {
      ok: openai.ok,
      status: openai.status,
      latencyMs: openai.latencyMs,
      modelsCount: openaiModels.length,
      error: openai.error
    },
    nativeRest: {
      available: nativeV1.ok || nativeV0.ok,
      preferred: nativePreferred,
      v1: {
        ok: nativeV1.ok,
        status: nativeV1.status,
        latencyMs: nativeV1.latencyMs,
        models: summarizeModels(nativeV1Models),
        error: nativeV1.error
      },
      v0: {
        ok: nativeV0.ok,
        status: nativeV0.status,
        latencyMs: nativeV0.latencyMs,
        models: summarizeModels(nativeV0Models),
        error: nativeV0.error
      }
    },
    configuredModel: configuredModelSummary(llm.model, models),
    models: summarizeModels(models)
  });
});

app.get("/api/llm/usage", async (_req, res) => {
  const usage = await readComputerUsage();
  res.json({
    checkedAt: new Date().toISOString(),
    activeRequests: activeLlmRequests(),
    activeRequestsCount: llmRequests.size,
    busy: llmRequests.size > 0,
    lastActivity: lastLlmActivity,
    computer: usage
  });
});

app.get("/api/fs/roots", async (_req, res, next) => {
  try {
    res.json({ roots: await listRoots() });
  } catch (error) {
    next(error);
  }
});

app.get("/api/fs/folders", async (req, res, next) => {
  try {
    const folderPath = String(req.query.path || "").trim();
    if (!folderPath) return res.status(400).json({ error: "path is required" });
    res.json(await listFolders(folderPath));
  } catch (error) {
    next(error);
  }
});

app.post("/api/dialog/folder", async (req, res, next) => {
  try {
    const selected = await chooseFolderWithExplorer({
      title: req.body.title || "Выберите папку",
      initialPath: req.body.initialPath || ""
    });
    res.json({ path: selected, canceled: !selected });
  } catch (error) {
    next(error);
  }
});

app.get("/api/sources", async (_req, res, next) => {
  try {
    const sources = await readSources();
    const [persistedJobs, manifest, sourceSummaries] = await Promise.all([
      readJobs(),
      readManifest(),
      readSourceSummaries()
    ]);
    res.json(sources.map((source) => publicSource(
      source,
      persistedJobs,
      manifest,
      sourceSummaries.summaries?.[source.id] || null,
      sources
    )));
  } catch (error) {
    next(error);
  }
});

app.get("/api/sources/match", async (req, res, next) => {
  try {
    const query = String(req.query.q || "").trim();
    const sources = await readSources();
    const match = matchSourceForQuestion(query, contractSources(sources));
    res.json({
      query,
      confident: match.confident,
      matchedSource: match.source ? publicMatchedSource(match.source, { autoSelected: true, score: match.score }) : null,
      matchedTokens: match.matchedTokens || [],
      candidates: match.candidates || []
    });
  } catch (error) {
    next(error);
  }
});

app.post("/api/tenders/sync", async (req, res, next) => {
  try {
    const apply = req.query.apply === "true" || req.body?.apply === true;
    const prune = req.query.prune === "true" || req.body?.prune === true;
    const scope = req.query.scope || req.body?.scope || "all";
    const excludedAutoLinks = Array.isArray(req.body?.excludedAutoLinks) ? req.body.excludedAutoLinks : [];
    const selectedTenderLinks = Array.isArray(req.body?.selectedTenderLinks) ? req.body.selectedTenderLinks : [];
    const summary = await runTenderSourceSync({ apply, prune, scope, selectedTenderLinks, excludedAutoLinks });

    if (!apply) return res.json(summary);

    const [sources, persistedJobs, manifest, sourceSummaries] = await Promise.all([
      readSources(),
      readJobs(),
      readManifest(),
      readSourceSummaries()
    ]);
    res.json({
      ...summary,
      sources: sources.map((source) => publicSource(
        source,
        persistedJobs,
        manifest,
        sourceSummaries.summaries?.[source.id] || null,
        sources
      ))
    });
  } catch (error) {
    next(error);
  }
});

app.post("/api/tenders/:id/price-audit", async (req, res, next) => {
  try {
    const dryRun = req.query.dryRun === "true"
      || req.body?.dryRun === true
      || req.query["dry-run"] === "true";
    const tolerancePercent = Number(req.query.tolerance || req.body?.tolerance || 1);
    const adapter = dryRun
      ? (await import("./hubtender-adapter.js")).createMockHubTenderAdapter()
      : createHubTenderAdapterFromEnv(process.env);
    const report = await runTenderPriceAudit({
      sourceId: req.params.id,
      tenderNumber: req.query.tenderNumber || req.body?.tenderNumber || "",
      hubTenderId: req.query.hubTenderId || req.body?.hubTenderId || "",
      tolerancePercent,
      adapter
    });
    res.json(report);
  } catch (error) {
    next(error);
  }
});

app.post("/api/tenders/audit/global", async (req, res, next) => {
  try {
    const dryRun = req.query.dryRun === "true"
      || req.body?.dryRun === true
      || req.query["dry-run"] === "true";
    const adapter = dryRun
      ? (await import("./hubtender-adapter.js")).createMockHubTenderAdapter()
      : createHubTenderAdapterFromEnv(process.env);
    const run = await startGlobalTenderAudit({
      resumeRunId: req.query.resumeRunId || req.body?.resumeRunId || "",
      includeArchived: req.query.includeArchived === "true" || req.body?.includeArchived === true,
      maxTenders: Number(req.query.maxTenders || req.body?.maxTenders || 0),
      tenderIds: Array.isArray(req.body?.tenderIds) ? req.body.tenderIds : [],
      tolerancePercent: Number(req.query.tolerance || req.body?.tolerance || 1),
      adapter,
      runInBackground: req.query.sync !== "true" && req.body?.sync !== true
    });
    res.status(202).json(run);
  } catch (error) {
    next(error);
  }
});

app.get("/api/tenders/audit/runs/:id", async (req, res, next) => {
  try {
    const run = await getGlobalTenderAuditRun(req.params.id);
    if (!run) return res.status(404).json({ error: "audit run not found" });
    res.json(run);
  } catch (error) {
    next(error);
  }
});

app.get("/api/sources/:id/indexed-files", async (req, res, next) => {
  try {
    const sources = await readSources();
    const source = sources.find((item) => item.id === req.params.id);
    if (!source) return res.status(404).json({ error: "source not found" });

    const manifest = await readManifest();

    const scopeSourceIds = searchScopeSourceIds(source, sources);
    const scopeSources = sources.filter((item) => scopeSourceIds.includes(item.id));
    const currentSourceIds = new Set(sources.map((item) => item?.id).filter(Boolean));
    const scopeEntries = [];
    const seenFileIds = new Set();
    for (const scopeSource of scopeSources) {
      for (const entry of indexedEntriesForSource(scopeSource, manifest, { currentSourceIds })) {
        const key = entry?.fileId || `${entry?.sourceId || ""}:${entry?.path || ""}`;
        if (seenFileIds.has(key)) continue;
        seenFileIds.add(key);
        scopeEntries.push(entry);
      }
    }
    const files = scopeEntries
      .map((entry) => publicIndexedFile(sourceForIndexEntry(scopeSources, entry, source), entry))
      .sort((a, b) => a.relativePath.localeCompare(b.relativePath, "ru", { sensitivity: "base", numeric: true }));

    res.json({
      sourceId: source.id,
      sourceTitle: source.title,
      root: source.path,
      total: files.length,
      searchable: files.filter((file) => file.chunks > 0).length,
      chunks: files.reduce((sum, file) => sum + (file.chunks || 0), 0),
      quality: indexedQualitySummary(files),
      files
    });
  } catch (error) {
    next(error);
  }
});

app.put("/api/sources/:id", async (req, res, next) => {
  try {
    const sources = await readSources();
    const result = applySourcePatch(sources, req.params.id, req.body || {});
    await writeSources(result.sources);

    const [persistedJobs, manifest, sourceSummaries] = await Promise.all([
      readJobs(),
      readManifest(),
      readSourceSummaries()
    ]);
    res.json(publicSource(
      result.source,
      persistedJobs,
      manifest,
      sourceSummaries.summaries?.[result.source.id] || null,
      result.sources
    ));
  } catch (error) {
    if (error.statusCode) return res.status(error.statusCode).json({ error: error.message });
    next(error);
  }
});

app.post("/api/sources", async (req, res, next) => {
  try {
    const folderPath = String(req.body.path || "").trim();
    if (!folderPath) return res.status(400).json({ error: "path is required" });
    const sourceType = normalizeSourceType({ sourceType: req.body.sourceType });

    const stat = await fs.stat(folderPath);
    if (!stat.isDirectory()) return res.status(400).json({ error: "path must be a directory" });

    const sources = await readSources();
    const existing = sources.find((source) => source.path.toLowerCase() === folderPath.toLowerCase());
    if (existing) return res.json(publicSource(existing));

    const title = String(req.body.title || path.basename(folderPath) || folderPath).trim();
    const existingTemporarySource = findExistingTemporarySourceByTitle(sources, title, folderPath);
    if (existingTemporarySource) return res.json(publicSource(existingTemporarySource));

    const baseId = sourceIdForPath(folderPath);
    let id = baseId;
    let counter = 2;
    while (sources.some((source) => source.id === id)) {
      id = `${baseId}-${counter}`;
      counter += 1;
    }

    const now = new Date().toISOString();
    const source = {
      id,
      title,
      path: folderPath,
      sourceType,
      include: ["**/*.pdf", "**/*.txt", "**/*.md", "**/*.csv", "**/*.docx", "**/*.xlsx", "**/*.xlsm", "**/*.xls"],
      exclude: ["~$", "thumbs.db", ".ds_store"],
      createdAt: now,
      updatedAt: now
    };

    sources.push(source);
    await writeSources(sources);
    res.status(201).json(publicSource(source));
  } catch (error) {
    next(error);
  }
});

app.delete("/api/sources", async (req, res, next) => {
  try {
    const ids = Array.isArray(req.body?.ids) ? req.body.ids : [];
    if (!ids.length) return res.status(400).json({ error: "ids are required" });
    const result = await deleteSourcesByIds(ids);
    if (!result.targets.length) return res.status(404).json({ error: "source not found" });
    res.json({
      deletedSourceIds: result.targets.map((source) => source.id),
      cleanupStarted: true,
      sources: result.sources.map((source) => publicSource(source))
    });
  } catch (error) {
    if (error.statusCode) return res.status(error.statusCode).json({ error: error.message });
    next(error);
  }
});

app.delete("/api/sources/:id", async (req, res, next) => {
  try {
    const result = await deleteSourcesByIds([req.params.id]);
    if (!result.targets.length) return res.status(404).json({ error: "source not found" });
    res.json({
      deletedSourceId: result.targets[0].id,
      cleanupStarted: true,
      sources: result.sources.map((source) => publicSource(source))
    });
  } catch (error) {
    if (error.statusCode) return res.status(error.statusCode).json({ error: error.message });
    next(error);
  }
});

app.post("/api/sources/:id/context-links", async (req, res, next) => {
  try {
    const sources = await readSources();
    const source = sources.find((item) => item.id === req.params.id);
    if (!source) return res.status(404).json({ error: "source not found" });

    const existingLinks = publicContextLinks(source);
    const linkInput = await resolveContextLinkTitle(req.body);
    const link = normalizeContextLink(linkInput);
    let id = link.id;
    let counter = 2;
    while (existingLinks.some((item) => item.id === id)) {
      id = `${link.id}-${counter}`;
      counter += 1;
    }

    const now = new Date().toISOString();
    source.contextLinks = [...existingLinks, { ...link, id, createdAt: now, updatedAt: now }];
    source.updatedAt = now;
    await writeSources(sources);

    const persistedJobs = await readJobs();
    res.status(201).json(publicSource(source, persistedJobs));
  } catch (error) {
    next(error);
  }
});

app.delete("/api/sources/:id/context-links/:linkId", async (req, res, next) => {
  try {
    const sources = await readSources();
    const source = sources.find((item) => item.id === req.params.id);
    if (!source) return res.status(404).json({ error: "source not found" });

    const links = publicContextLinks(source);
    const nextLinks = links.filter((link) => link.id !== req.params.linkId);
    if (nextLinks.length === links.length) return res.status(404).json({ error: "context link not found" });

    source.contextLinks = nextLinks;
    source.updatedAt = new Date().toISOString();
    await writeSources(sources);

    const persistedJobs = await readJobs();
    res.json(publicSource(source, persistedJobs));
  } catch (error) {
    next(error);
  }
});

app.post("/api/sources/:id/index", async (req, res, next) => {
  try {
    const sources = await readSources();
    const source = sources.find((item) => item.id === req.params.id);
    if (!source) return res.status(404).json({ error: "source not found" });

    const force = Boolean(req.body?.force);
    const existing = Array.from(jobs.values()).find((job) => job.sourceId === source.id && job.status === "running");
    if (existing) return res.json(publicJobStatus(existing));

    const controller = new AbortController();
    const now = new Date().toISOString();
    const job = {
      id: crypto.randomUUID(),
      sourceId: source.id,
      sourceTitle: source.title,
      force,
      status: "running",
      phase: "queued",
      message: force ? "Принудительная переиндексация в очереди" : "В очереди",
      processed: 0,
      total: 0,
      startedAt: now,
      updatedAt: now
    };

    jobs.set(job.id, job);
    jobControllers.set(job.id, controller);
    await persistJob(job);
    res.status(202).json(publicJobStatus(job));

    indexSource(source, (progress) => {
      Object.assign(job, progress, { updatedAt: new Date().toISOString() });
      jobs.set(job.id, job);
      persistJob(job).catch(() => {});
    }, { force, signal: controller.signal })
      .then((result) => {
        Object.assign(job, result, {
          status: "completed",
          phase: "done",
          message: "Готово",
          updatedAt: new Date().toISOString()
        });
        jobs.set(job.id, job);
        return persistJob(job);
      })
      .catch((error) => {
        const failedPhase = job.phase && job.phase !== "queued" ? job.phase : "error";
        if (isAbortError(error) || controller.signal.aborted) {
          Object.assign(job, {
            status: "cancelled",
            phase: failedPhase,
            message: "Индексация остановлена",
            finishedAt: new Date().toISOString(),
            updatedAt: new Date().toISOString()
          });
        } else {
          Object.assign(job, {
            status: "failed",
            phase: failedPhase,
            message: error.message,
            updatedAt: new Date().toISOString()
          });
        }
        jobs.set(job.id, job);
        return persistJob(job);
      })
      .finally(() => {
        jobControllers.delete(job.id);
      });
  } catch (error) {
    next(error);
  }
});

app.post("/api/index/stop", async (_req, res, next) => {
  try {
    let requested = 0;
    const now = new Date().toISOString();

    for (const [jobId, controller] of jobControllers.entries()) {
      const job = jobs.get(jobId);
      if (!job || job.status !== "running") continue;
      requested += 1;
      Object.assign(job, {
        status: "running",
        phase: job.phase || "stopping",
        message: "Останавливаю индексацию...",
        stopRequestedAt: now,
        updatedAt: now
      });
      jobs.set(jobId, job);
      persistJob(job).catch(() => {});
      controller.abort(new Error("Индексация остановлена"));
    }

    if (agentRunController && !agentRunController.signal.aborted) {
      requested += 1;
      agentRunController.abort(new Error("Индексация остановлена"));
    }

    res.status(202).json({
      status: requested ? "stopping" : "idle",
      stopRequested: requested
    });
  } catch (error) {
    next(error);
  }
});

app.get("/api/sources/:id/skipped", async (req, res, next) => {
  try {
    const sources = await readSources();
    const source = sources.find((item) => item.id === req.params.id);
    if (!source) return res.status(404).json({ error: "source not found" });
    res.json(await scanSkippedFiles(source));
  } catch (error) {
    next(error);
  }
});

app.get("/api/jobs/:id", async (req, res, next) => {
  try {
    if (jobs.has(req.params.id)) return res.json(publicJobStatus(jobs.get(req.params.id)));
    const persisted = await readJobs();
    const job = persisted[req.params.id];
    if (!job) return res.status(404).json({ error: "job not found" });
    res.json(publicJobStatus(job));
  } catch (error) {
    next(error);
  }
});

app.get("/api/agent/runs", async (_req, res, next) => {
  try {
    const [runs, lockStatus] = await Promise.all([
      readDailyAgentRuns(),
      dailyAgentLockStatus()
    ]);
    res.json(Object.values(runs)
      .sort((left, right) => String(right.startedAt || "").localeCompare(String(left.startedAt || "")))
      .slice(0, 20)
      .map((run) => publicDailyAgentRun(run, {
        active: agentRunInProcess,
        lockStatus
      })));
  } catch (error) {
    next(error);
  }
});

app.post("/api/agent/run", async (req, res, next) => {
  try {
    if (agentRunInProcess) {
      return res.status(202).json({
        status: "running",
        message: "Daily agent is already running."
      });
    }

    const force = Boolean(req.body?.force);
    const controller = new AbortController();
    agentRunInProcess = true;
    agentRunController = controller;
    runDailyIndexAgent({
      trigger: "ui",
      force,
      signal: controller.signal,
      onProgress: () => {}
    })
      .catch((error) => {
        if (!isAbortError(error)) console.error("Daily agent failed:", error);
      })
      .finally(() => {
        agentRunInProcess = false;
        if (agentRunController === controller) agentRunController = null;
      });

    res.status(202).json({
      status: "started",
      force,
      startedAt: new Date().toISOString()
    });
  } catch (error) {
    next(error);
  }
});

function difyAdapterDiagnosticHtml() {
  const adapterTokenConfigured = Boolean(String(process.env.LOCALAI_DIFY_ADAPTER_TOKEN || "").trim());
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>LOCAL_RAG Dify adapter</title>
  <style>
    :root { color-scheme: light dark; font-family: system-ui, -apple-system, Segoe UI, sans-serif; }
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: Canvas; color: CanvasText; }
    main { width: min(840px, calc(100vw - 32px)); border: 1px solid color-mix(in srgb, CanvasText 18%, transparent); border-radius: 8px; padding: 24px; }
    h1 { margin: 0 0 16px; font-size: 24px; letter-spacing: 0; }
    .status-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; margin: 0 0 20px; }
    .status-card { border: 1px solid color-mix(in srgb, CanvasText 16%, transparent); border-radius: 8px; padding: 16px; background: color-mix(in srgb, CanvasText 4%, Canvas); }
    .status-label { display: flex; align-items: center; gap: 8px; margin: 0 0 8px; color: color-mix(in srgb, CanvasText 68%, transparent); font-size: 13px; }
    .status-value { margin: 0; font-size: 24px; font-weight: 750; letter-spacing: 0; }
    .status-detail { margin: 8px 0 0; color: color-mix(in srgb, CanvasText 62%, transparent); font-size: 13px; overflow-wrap: anywhere; }
    .dot { width: 11px; height: 11px; border-radius: 999px; background: #b45309; box-shadow: 0 0 0 0 color-mix(in srgb, #b45309 38%, transparent); }
    .dot.ok { background: #16a34a; animation: pulse-ok 1.6s ease-out infinite; }
    .dot.warn { background: #b45309; }
    .dot.err { background: #dc2626; }
    @keyframes pulse-ok { 0% { box-shadow: 0 0 0 0 color-mix(in srgb, #16a34a 45%, transparent); } 70% { box-shadow: 0 0 0 9px transparent; } 100% { box-shadow: 0 0 0 0 transparent; } }
    dl { display: grid; grid-template-columns: minmax(140px, 0.36fr) 1fr; gap: 10px 16px; margin: 0; }
    dt { color: color-mix(in srgb, CanvasText 62%, transparent); }
    dd { margin: 0; font-weight: 600; overflow-wrap: anywhere; }
    code { font-family: ui-monospace, SFMono-Regular, Consolas, monospace; font-size: 0.95em; }
    .ok { color: #15803d; }
    .warn { color: #b45309; }
    .err { color: #dc2626; }
    @media (max-width: 680px) { .status-grid { grid-template-columns: 1fr; } dl { grid-template-columns: 1fr; } }
  </style>
</head>
<body>
  <main>
    <h1>LOCAL_RAG Dify adapter</h1>
    <section class="status-grid" aria-label="Dify status">
      <article class="status-card">
        <p class="status-label"><span class="dot ${adapterTokenConfigured ? "ok" : "warn"}"></span>LOCAL_RAG adapter</p>
        <p class="status-value ${adapterTokenConfigured ? "ok" : "warn"}">${adapterTokenConfigured ? "Ready" : "Token missing"}</p>
        <p class="status-detail">${adapterTokenConfigured ? "Adapter token is configured. Token value is hidden." : "Set LOCALAI_DIFY_ADAPTER_TOKEN and restart backend."}</p>
      </article>
      <article class="status-card">
        <p class="status-label"><span id="dify-dot" class="dot warn"></span>Dify self-host</p>
        <p id="dify-state" class="status-value warn">Checking...</p>
        <p id="dify-detail" class="status-detail">Status is checked through LOCALAI_DIFY_URL without exposing the URL value.</p>
      </article>
    </section>
    <dl>
      <dt>External Knowledge base</dt><dd><code>http://127.0.0.1:8787/api/dify</code></dd>
      <dt>Endpoint</dt><dd><code>POST /api/dify/retrieval</code></dd>
      <dt>Browser GET</dt><dd class="ok">diagnostic page is installed for <code>/api/dify</code> and <code>/api/dify/retrieval</code></dd>
      <dt>Adapter token</dt><dd class="${adapterTokenConfigured ? "ok" : "warn"}">${adapterTokenConfigured ? "configured" : "missing: set LOCALAI_DIFY_ADAPTER_TOKEN and restart backend"}</dd>
      <dt>HTTP tool URL</dt><dd><code>http://127.0.0.1:8787/api/dify/retrieval</code></dd>
      <dt>Expected success</dt><dd><code>200</code> with <code>records</code>, <code>privacy</code>, <code>warnings</code></dd>
      <dt>Auth failures</dt><dd><code>401</code> wrong/missing adapter token, <code>503</code> token missing in backend env</dd>
    </dl>
  </main>
  <script>
    const stateEl = document.getElementById("dify-state");
    const detailEl = document.getElementById("dify-detail");
    const dotEl = document.getElementById("dify-dot");
    function setDifyState(kind, label, detail) {
      dotEl.className = "dot " + kind;
      stateEl.className = "status-value " + kind;
      stateEl.textContent = label;
      detailEl.textContent = detail;
    }
    async function refreshDifyState() {
      try {
        const response = await fetch("/api/dify/status", { cache: "no-store" });
        if (!response.ok) throw new Error("status " + response.status);
        const status = await response.json();
        if (!status.configured) {
          setDifyState("warn", "Not configured", "Set LOCALAI_DIFY_URL to show live Dify reachability.");
        } else if (status.reachable) {
          setDifyState("ok", "Running", "Dify responded from " + status.urlLabel + ".");
        } else {
          setDifyState("err", "Not reachable", status.error || "Configured Dify endpoint did not respond.");
        }
      } catch {
        setDifyState("warn", "Unknown", "Could not read LOCAL_RAG Dify status endpoint.");
      }
    }
    refreshDifyState();
    setInterval(refreshDifyState, 10000);
  </script>
</body>
</html>`;
}

function isLoopbackHostName(hostname = "") {
  const value = String(hostname || "").toLowerCase();
  return value === "localhost" || value === "::1" || value.startsWith("127.");
}

function publicDifyUrlLabel(url = "") {
  try {
    const parsed = new URL(url);
    if (isLoopbackHostName(parsed.hostname)) return parsed.origin;
    return "configured non-loopback URL";
  } catch {
    return "configured URL";
  }
}

async function fetchDifyReachability(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 2500);
  try {
    const response = await fetch(url, {
      method: "GET",
      redirect: "follow",
      signal: controller.signal
    });
    return {
      reachable: true,
      statusCode: response.status
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function difyRuntimeStatus() {
  const url = String(process.env.LOCALAI_DIFY_URL || "").trim();
  const adapterTokenConfigured = Boolean(String(process.env.LOCALAI_DIFY_ADAPTER_TOKEN || "").trim());
  if (!url) {
    return {
      configured: false,
      reachable: false,
      adapterTokenConfigured,
      urlLabel: "",
      checkedAt: new Date().toISOString()
    };
  }

  try {
    const reachability = await fetchDifyReachability(url);
    return {
      configured: true,
      reachable: reachability.reachable,
      statusCode: reachability.statusCode,
      adapterTokenConfigured,
      urlLabel: publicDifyUrlLabel(url),
      checkedAt: new Date().toISOString()
    };
  } catch {
    return {
      configured: true,
      reachable: false,
      adapterTokenConfigured,
      urlLabel: publicDifyUrlLabel(url),
      error: "Configured Dify endpoint is not reachable.",
      checkedAt: new Date().toISOString()
    };
  }
}

app.get("/api/dify", (_req, res) => {
  res.type("html").send(difyAdapterDiagnosticHtml());
});

app.get("/api/dify/retrieval", (_req, res) => {
  res.type("html").send(difyAdapterDiagnosticHtml());
});

app.get("/api/dify/status", async (_req, res, next) => {
  try {
    res.json(await difyRuntimeStatus());
  } catch (error) {
    next(error);
  }
});

app.post("/api/dify/retrieval", async (req, res, next) => {
  try {
    const auth = authorizeDifyAdapterRequest(req.headers.authorization);
    if (!auth.ok) {
      if (auth.authenticate) res.set("WWW-Authenticate", "Bearer");
      return res.status(auth.status).json({ error: auth.error });
    }

    const [sources, settings, manifest] = await Promise.all([readSources(), readSettings(), readManifest()]);
    const result = await runDifyRetrieval({
      body: req.body,
      sources,
      settings,
      manifest,
      searchChunks: searchChunksWithMetadata
    });
    return res.status(result.status).json(result.payload);
  } catch (error) {
    next(error);
  }
});

app.get("/api/search", async (req, res, next) => {
  try {
    const query = String(req.query.q || "").trim();
    const sourceId = String(req.query.sourceId || "").trim();
    const limit = Math.min(Number(req.query.limit || 10), 30);
    let sourceIds = null;
    if (sourceId) {
      const [sources, manifest] = await Promise.all([readSources(), readManifest()]);
      const source = sources.find((item) => item.id === sourceId);
      if (source) sourceIds = indexSourceIdsForSources([source], manifest);
    }
    const { results, metadata } = await searchChunksWithMetadata({ query, sourceId, sourceIds, limit });
    res.json({ query, results, metadata });
  } catch (error) {
    next(error);
  }
});

app.post("/api/files/system-open", async (req, res, next) => {
  try {
    const action = String(req.body?.action || "open").trim();
    const sourceId = String(req.body?.sourceId || "").trim();
    const filePath = String(req.body?.path || "").trim();
    const fileId = String(req.body?.fileId || "").trim();
    if (!["open", "reveal"].includes(action)) {
      return res.status(400).json({ error: "unsupported file action" });
    }
    if (!sourceId || (!filePath && !fileId)) {
      return res.status(400).json({ error: "sourceId and path or fileId are required" });
    }

    const [sources, manifest] = await Promise.all([readSources(), readManifest()]);
    const source = findKnownSource(sources, sourceId);
    if (!source) return res.status(404).json({ error: "source not found" });

    const target = await resolvePreviewTarget({
      source,
      manifest,
      filePath,
      fileId
    });
    if (target.status !== 200 || !target.entry) {
      return res.status(target.status || 404).json({
        error: target.error || "indexed file not found",
        targetMatched: false,
        sourceId: source.id
      });
    }

    const result = action === "reveal"
      ? await revealFileInSystem(target.entry.path)
      : await openFileInSystem(target.entry.path);

    res.json({
      ok: true,
      action,
      sourceId: source.id,
      fileId: target.entry.fileId || "",
      path: result.path,
      title: path.basename(target.entry.path)
    });
  } catch (error) {
    if (error?.statusCode) {
      return res.status(error.statusCode).json({ error: error.message });
    }
    next(error);
  }
});

app.get("/api/files/preview", async (req, res, next) => {
  try {
    const sourceId = String(req.query.sourceId || "").trim();
    const filePath = String(req.query.path || "").trim();
    const fileId = String(req.query.fileId || "").trim();
    const chunkId = String(req.query.chunkId || "").trim();
    const focusText = String(req.query.focusText || "").trim().slice(0, 900);
    if (!sourceId || (!filePath && !fileId && !chunkId)) {
      return res.status(400).json({ error: "sourceId and path, fileId, or chunkId are required" });
    }

    const [sources, manifest] = await Promise.all([readSources(), readManifest()]);
    const source = findKnownSource(sources, sourceId);
    if (!source) return res.status(404).json({ error: "source not found" });

    const target = await resolvePreviewTarget({
      source,
      manifest,
      filePath,
      fileId,
      chunkId,
      findChunkById: (id, knownSourceId) => findChunk((item) => item.id === id && item.sourceId === knownSourceId)
    });
    if (target.status !== 200) {
      return res.status(target.status).json({
        error: target.error,
        targetMatched: false,
        sourceId: source.id,
        chunkId: target.chunkId || chunkId || "",
        fallbackReason: target.fallbackReason || ""
      });
    }

    const { entry, chunk } = target;
    const chunkText = String(chunk?.text || "");
    const chunkFocus = chunk && focusText ? findEvidenceRange(chunkText, focusText) : null;
    const targetPreview = chunkFocus
      ? previewWindowAroundRange(chunkText, chunkFocus)
      : {
          text: chunkText,
          focus: { found: false },
          truncatedBefore: false,
          truncatedAfter: false
        };

    if (!entry && chunk) {
      return res.json({
        targetMatched: true,
        sourceId: source.id,
        chunkId: chunk.id,
        chunkIndex: chunk.chunkIndex,
        fileId: chunk.fileId || "",
        path: chunk.path || "",
        title: chunk.title || path.basename(chunk.path || "source"),
        label: formatCitationLabel(chunk),
        markdown: targetPreview.text,
        text: chunkText,
        excerpt: targetPreview.text,
        focus: targetPreview.focus,
        evidenceMatched: Boolean(chunkFocus),
        fallbackReason: "manifest entry not found",
        ...chunkPreviewMetadata(chunk),
        truncated: targetPreview.truncatedBefore || targetPreview.truncatedAfter,
        truncatedBefore: targetPreview.truncatedBefore,
        truncatedAfter: targetPreview.truncatedAfter
      });
    }

    const cacheFile = entry.cacheFile || (entry.fileId ? `${entry.fileId}.md` : "");
    let safeCacheFile;
    try {
      safeCacheFile = resolveMarkdownCachePath(markdownCacheDir(), source.id, cacheFile);
    } catch {
      return res.status(403).json({ error: "unsafe preview cache path" });
    }
    const fullMarkdown = stripFrontMatter(await fs.readFile(safeCacheFile, "utf8"));
    const maxChars = 220000;
    let focus = null;

    if (chunk) {
      focus = findFocusRange(fullMarkdown, chunk?.text);
    }

    let windowStart = 0;
    if (focus && fullMarkdown.length > maxChars) {
      windowStart = Math.max(0, focus.start - 70000);
    }

    const windowEnd = Math.min(fullMarkdown.length, windowStart + maxChars);
    const markdown = fullMarkdown.slice(windowStart, windowEnd);
    const relativeFocus = focus
      ? {
          found: focus.start >= windowStart && focus.end <= windowEnd,
          start: focus.start - windowStart,
          end: focus.end - windowStart,
          text: focus.text
        }
      : { found: false };

    res.json({
      targetMatched: Boolean(chunk),
      sourceId: source.id,
      chunkId: chunk?.id || "",
      chunkIndex: chunk?.chunkIndex,
      fileId: entry.fileId || chunk?.fileId || "",
      fallbackReason: chunk ? "" : (target.fallbackReason || "legacy file preview"),
      path: entry.path,
      title: entry.title || path.basename(entry.path),
      label: chunk ? formatCitationLabel(chunk) : (entry.title || path.basename(entry.path)),
      text: chunkText,
      excerpt: chunk ? targetPreview.text : "",
      markdown,
      focus: chunk ? targetPreview.focus : relativeFocus,
      evidenceMatched: Boolean(chunkFocus),
      ...(chunk ? chunkPreviewMetadata(chunk) : {}),
      truncated: fullMarkdown.length > markdown.length,
      truncatedBefore: windowStart > 0,
      truncatedAfter: windowEnd < fullMarkdown.length
    });
  } catch (error) {
    next(error);
  }
});

app.post("/api/chat/title", async (req, res, next) => {
  const requestController = new AbortController();
  let clientAborted = false;
  res.on("close", () => {
    if (!res.writableEnded) {
      clientAborted = true;
      requestController.abort();
    }
  });

  try {
    const settings = await readSettings();
    const sourceTitle = String(req.body.sourceTitle || "").trim();
    const title = await generateChatTitle({
      settings,
      question: String(req.body.question || ""),
      answer: String(req.body.answer || ""),
      sourceTitle,
      signal: requestController.signal
    });
    res.json(title);
  } catch (error) {
    if (clientAborted || (error.name === "AbortError" && requestController.signal.aborted)) {
      if (!res.headersSent) res.status(499).json({ error: "request cancelled" });
      return;
    }
    next(error);
  }
});

app.post("/api/chat", async (req, res, next) => {
  let clientAborted = false;
  const requestController = new AbortController();
  res.on("close", () => {
    if (!res.writableEnded) {
      clientAborted = true;
      requestController.abort();
    }
  });

  try {
    const totalStartedAt = Date.now();
    const question = String(req.body.question || "").trim();
    const requestedSourceId = String(req.body.sourceId || "").trim();
    const contextSourceId = String(req.body.contextSourceId || "").trim();
    const sources = await readSources();
    const settings = await readSettings();
    const chatScope = resolveChatSourceScope({ question, requestedSourceId, contextSourceId, sources });
    const { source, sourceId, searchSourceIds, autoMatch, searchAllSources } = chatScope;
    const broadAnswer = hasBroadAnswerIntent(question);
    const retrievalQuery = expandedChatRetrievalQuery(question);

    if (chatScope.requestedSourceMissing) {
      const candidates = autoMatch?.candidates || [];
      const candidatesText = candidates.length
        ? `\n\nПохожие проекты: ${candidates.map((candidate) => candidate.title).join("; ")}.`
        : "";
      const answer = `Не понял, к какому проекту относится вопрос. Добавьте в запрос название или адрес проекта, например: «Балчуг, Садовническая — какие основные условия договора?».${candidatesText}`;
      return res.json({
        answer,
        sources: [],
        matchedSource: null,
        projectCandidates: candidates,
        metadata: ragDebugMetadata({
          routeMetadata: emptyRouteMetadata(settings),
          answer,
          totalMs: Date.now() - totalStartedAt
        })
      });
    }

    const matchedSource = source ? publicMatchedSource(source, {
      autoSelected: !requestedSourceId || chatScope.contextSourceUsed,
      score: autoMatch?.score || 0
    }) : null;
    const searchLimit = chatSearchLimit({ searchAllSources, broadAnswer });
    let effectiveSearchSourceIds = searchAllSources ? null : searchSourceIds;
    if (!searchAllSources && searchSourceIds.length) {
      const manifest = await readManifest();
      const scopedSources = sources.filter((item) => searchSourceIds.includes(item.id));
      effectiveSearchSourceIds = indexSourceIdsForSources(scopedSources, manifest);
    }
    const searchResult = await searchChunksWithMetadata({
      query: retrievalQuery,
      sourceId,
      sourceIds: effectiveSearchSourceIds,
      limit: searchLimit
    });
    const results = searchResult.results;
    const searchMetadata = searchResult.metadata;
    const llmCandidates = chatLlmCandidates(settings);
    const llm = llmCandidates[0];
    const initialMetadata = (answer = "", overrides = {}) => ragDebugMetadata({
      routeMetadata: llmRouteMetadata(llm),
      searchMetadata,
      matchedSource,
      finalSourceCount: results.length,
      answer,
      totalMs: Date.now() - totalStartedAt,
      ...overrides
    });

    if (!results.length) {
      if (searchAllSources) {
        const manifest = await readManifest();
        const answer = allSourcesNoResultsAnswer(manifest);
        return res.json({
          answer,
          matchedSource,
          sources: [],
          metadata: initialMetadata(answer)
        });
      }

      const [manifest, persistedJobs] = await Promise.all([readManifest(), readJobs()]);
      const currentSourceIds = new Set(sources.map((item) => item?.id).filter(Boolean));
      const indexedChunks = indexedSnapshotForSource(source, manifest, { currentSourceIds }).chunks;
      const latestJob = latestJobForSource(sourceId, persistedJobs);
      if (!indexedChunks) {
        const status = publicJobStatus(latestJob);
        const progress = status.status === "running" && status.total
          ? ` Сейчас идет индексация: ${status.processed || 0}/${status.total}.`
          : "";
        const answer = `По проекту «${source.title}» пока нет готового индекса.${progress} Запустите агента или дождитесь завершения индексации, затем повторите вопрос.`;
        return res.json({
          answer,
          matchedSource,
          sources: [],
          metadata: initialMetadata(answer)
        });
      }

      const answer = "По готовому индексу ничего не найдено. Попробуйте уточнить формулировку или выберите другой проект.";
      return res.json({
        answer,
        matchedSource,
        sources: [],
        metadata: initialMetadata(answer)
      });
    }

    if (!llm.enabled) {
      const answer = "LLM выключен в настройках. Ниже самые релевантные фрагменты.";
      return res.json({
        answer,
        matchedSource,
        sources: results,
        metadata: initialMetadata(answer)
      });
    }

    const {
      reply,
      usedLlm,
      lastLlmError,
      promptChars,
      llmMs
    } = await runChatLlm({
      llmCandidates,
      results,
      question,
      sourceId,
      broadAnswer,
      signal: requestController.signal
    });

    if (!reply) {
      const failedLlm = llmCandidates[0] || llm;
      const answer = llmErrorAnswer(lastLlmError || new Error("LLM response is empty"), results, question);
      return res.json({
        answer,
        model: failedLlm?.model || "",
        provider: failedLlm?.provider,
        providerLabel: providerLabel(failedLlm?.provider),
        selectedBy: failedLlm?.selectedBy,
        fallbackReason: "llm_failed",
        matchedSource,
        sources: results,
        metadata: ragDebugMetadata({
          routeMetadata: llmRouteMetadata(failedLlm),
          searchMetadata,
          matchedSource,
          finalSourceCount: results.length,
          promptChars,
          answer,
          llmMs,
          totalMs: Date.now() - totalStartedAt
        })
      });
    }

    const answer = withFallbackSources(reply.text, results.length);
    const metadata = ragDebugMetadata({
      routeMetadata: llmRouteMetadata(usedLlm, { fallbackUsed: usedLlm?.fallbackUsed }),
      searchMetadata,
      matchedSource,
      finalSourceCount: results.length,
      promptChars,
      answer,
      llmMs,
      totalMs: Date.now() - totalStartedAt
    });
    res.json({
      answer,
      model: reply.model,
      provider: usedLlm?.provider,
      providerLabel: providerLabel(usedLlm?.provider),
      selectedBy: usedLlm?.selectedBy,
      fallbackReason: usedLlm?.autoFallbackReason || "",
      matchedSource,
      sources: results,
      metadata
    });
  } catch (error) {
    if (clientAborted || (error.name === "AbortError" && requestController.signal.aborted)) {
      if (!res.headersSent) res.status(499).json({ error: "request cancelled" });
      return;
    }
    next(error);
  }
});

function streamChatPayload(res, payload, options = {}) {
  if (options.emitAnswerToken !== false && payload.answer) {
    writeSseEvent(res, "token", { text: payload.answer });
  }
  writeSseEvent(res, "sources", { sources: payload.sources || [] });
  writeSseEvent(res, "meta", {
    model: payload.model || "",
    provider: payload.provider,
    providerLabel: payload.providerLabel,
    selectedBy: payload.selectedBy,
    fallbackReason: payload.fallbackReason || "",
    matchedSource: payload.matchedSource || null,
    projectCandidates: payload.projectCandidates || [],
    metadata: payload.metadata || {}
  });
  writeSseEvent(res, "done", payload);
  res.end();
}

app.post("/api/chat/stream", async (req, res) => {
  let clientAborted = false;
  const requestController = new AbortController();
  res.on("close", () => {
    if (!res.writableEnded) {
      clientAborted = true;
      requestController.abort();
    }
  });

  startSseResponse(res);

  try {
    const totalStartedAt = Date.now();
    const question = String(req.body.question || "").trim();
    const requestedSourceId = String(req.body.sourceId || "").trim();
    const contextSourceId = String(req.body.contextSourceId || "").trim();
    writeSseEvent(res, "status", { status: "retrieval_started" });

    const sources = await readSources();
    const settings = await readSettings();
    const chatScope = resolveChatSourceScope({ question, requestedSourceId, contextSourceId, sources });
    const { source, sourceId, searchSourceIds, autoMatch, searchAllSources } = chatScope;
    const broadAnswer = hasBroadAnswerIntent(question);
    const retrievalQuery = expandedChatRetrievalQuery(question);

    if (chatScope.requestedSourceMissing) {
      const candidates = autoMatch?.candidates || [];
      const candidatesText = candidates.length
        ? `\n\nПохожие проекты: ${candidates.map((candidate) => candidate.title).join("; ")}.`
        : "";
      const answer = `Не понял, к какому проекту относится вопрос. Добавьте в запрос название или адрес проекта, например: «Балчуг, Садовническая — какие основные условия договора?».${candidatesText}`;
      writeSseEvent(res, "status", { status: "retrieval_done", matched: false });
      return streamChatPayload(res, {
        answer,
        sources: [],
        matchedSource: null,
        projectCandidates: candidates,
        metadata: ragDebugMetadata({
          routeMetadata: emptyRouteMetadata(settings),
          answer,
          totalMs: Date.now() - totalStartedAt
        })
      });
    }

    const matchedSource = source ? publicMatchedSource(source, {
      autoSelected: !requestedSourceId || chatScope.contextSourceUsed,
      score: autoMatch?.score || 0
    }) : null;
    const searchLimit = chatSearchLimit({ searchAllSources, broadAnswer });
    let effectiveSearchSourceIds = searchAllSources ? null : searchSourceIds;
    if (!searchAllSources && searchSourceIds.length) {
      const manifest = await readManifest();
      const scopedSources = sources.filter((item) => searchSourceIds.includes(item.id));
      effectiveSearchSourceIds = indexSourceIdsForSources(scopedSources, manifest);
    }
    const searchResult = await searchChunksWithMetadata({
      query: retrievalQuery,
      sourceId,
      sourceIds: effectiveSearchSourceIds,
      limit: searchLimit
    });
    const results = searchResult.results;
    const searchMetadata = searchResult.metadata;
    const llmCandidates = chatLlmCandidates(settings);
    const llm = llmCandidates[0];
    const initialMetadata = (answer = "", overrides = {}) => ragDebugMetadata({
      routeMetadata: llmRouteMetadata(llm),
      searchMetadata,
      matchedSource,
      finalSourceCount: results.length,
      answer,
      totalMs: Date.now() - totalStartedAt,
      ...overrides
    });

    writeSseEvent(res, "status", {
      status: "retrieval_done",
      matched: Boolean(source),
      sourceId,
      searchAllSources,
      resultCount: results.length,
      metadata: searchMetadata
    });

    if (!results.length) {
      if (searchAllSources) {
        const manifest = await readManifest();
        const answer = allSourcesNoResultsAnswer(manifest);
        return streamChatPayload(res, {
          answer,
          matchedSource,
          sources: [],
          metadata: initialMetadata(answer)
        });
      }

      const [manifest, persistedJobs] = await Promise.all([readManifest(), readJobs()]);
      const currentSourceIds = new Set(sources.map((item) => item?.id).filter(Boolean));
      const indexedChunks = indexedSnapshotForSource(source, manifest, { currentSourceIds }).chunks;
      const latestJob = latestJobForSource(sourceId, persistedJobs);
      if (!indexedChunks) {
        const status = publicJobStatus(latestJob);
        const progress = status.status === "running" && status.total
          ? ` Сейчас идет индексация: ${status.processed || 0}/${status.total}.`
          : "";
        const answer = `По проекту «${source.title}» пока нет готового индекса.${progress} Запустите агента или дождитесь завершения индексации, затем повторите вопрос.`;
        return streamChatPayload(res, {
          answer,
          matchedSource,
          sources: [],
          metadata: initialMetadata(answer)
        });
      }

      const answer = "По готовому индексу ничего не найдено. Попробуйте уточнить формулировку или выберите другой проект.";
      return streamChatPayload(res, {
        answer,
        matchedSource,
        sources: [],
        metadata: initialMetadata(answer)
      });
    }

    if (!llm.enabled) {
      const answer = "LLM выключен в настройках. Ниже самые релевантные фрагменты.";
      return streamChatPayload(res, {
        answer,
        matchedSource,
        sources: results,
        metadata: initialMetadata(answer)
      });
    }

    writeSseEvent(res, "status", {
      status: "llm_started",
      provider: llm.provider,
      providerLabel: providerLabel(llm.provider),
      model: llm.model || ""
    });

    let streamedAnswer = "";
    const {
      reply,
      usedLlm,
      lastLlmError,
      promptChars,
      llmMs
    } = await runChatLlm({
      llmCandidates,
      results,
      question,
      sourceId,
      broadAnswer,
      signal: requestController.signal,
      stream: true,
      onToken: (token) => {
        streamedAnswer += token;
        writeSseEvent(res, "token", { text: token });
      }
    });

    if (!reply) {
      const failedLlm = llmCandidates[0] || llm;
      const answer = llmErrorAnswer(lastLlmError || new Error("LLM response is empty"), results, question);
      return streamChatPayload(res, {
        answer,
        model: failedLlm?.model || "",
        provider: failedLlm?.provider,
        providerLabel: providerLabel(failedLlm?.provider),
        selectedBy: failedLlm?.selectedBy,
        fallbackReason: "llm_failed",
        matchedSource,
        sources: results,
        metadata: ragDebugMetadata({
          routeMetadata: llmRouteMetadata(failedLlm),
          searchMetadata,
          matchedSource,
          finalSourceCount: results.length,
          promptChars,
          answer,
          llmMs,
          totalMs: Date.now() - totalStartedAt
        })
      }, { emitAnswerToken: !streamedAnswer });
    }

    const answer = withFallbackSources(reply.text, results.length);
    const suffix = answer.startsWith(streamedAnswer) ? answer.slice(streamedAnswer.length) : "";
    if (suffix) writeSseEvent(res, "token", { text: suffix });

    const payload = {
      answer,
      model: reply.model,
      provider: usedLlm?.provider,
      providerLabel: providerLabel(usedLlm?.provider),
      selectedBy: usedLlm?.selectedBy,
      fallbackReason: usedLlm?.autoFallbackReason || "",
      matchedSource,
      sources: results,
      metadata: ragDebugMetadata({
        routeMetadata: llmRouteMetadata(usedLlm, { fallbackUsed: usedLlm?.fallbackUsed }),
        searchMetadata,
        matchedSource,
        finalSourceCount: results.length,
        promptChars,
        answer,
        llmMs,
        totalMs: Date.now() - totalStartedAt
      })
    };
    return streamChatPayload(res, payload, { emitAnswerToken: false });
  } catch (error) {
    if (clientAborted || (error.name === "AbortError" && requestController.signal.aborted)) {
      if (!res.writableEnded) res.end();
      return;
    }
    writeSseEvent(res, "error", { error: error.message || "Internal error" });
    res.end();
  }
});

app.get(/^\/(?:chat|settings(?:\/(?:general|sources|llm|indexes|audit))?)\/?$/, (_req, res) => {
  res.sendFile(path.join(projectRoot, "apps", "rag-ui", "index.html"));
});

app.use((error, _req, res, _next) => {
  console.error(error);
  const status = Number(error?.statusCode || error?.status || 500);
  const safeStatus = status >= 400 && status < 600 ? status : 500;
  const payload = { error: error.message || "Internal error" };
  if (error?.tenderSync) payload.tenderSync = error.tenderSync;
  res.status(safeStatus).json(payload);
});

await ensureStorage();

const host = process.env.RAG_HOST || "127.0.0.1";
const port = Number(process.env.RAG_PORT || 8787);
warnIfUnsafeNetworkBinding(host, apiSecurity);
app.listen(port, host, () => {
  console.log(`Locus listening at http://${host}:${port}`);
});

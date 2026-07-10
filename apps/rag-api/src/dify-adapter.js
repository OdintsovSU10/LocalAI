import crypto from "node:crypto";

import { hasAllSourcesIntent } from "./chat-scope.js";
import { indexSourceIdsForSources } from "./index-status.js";
import { matchSourceForQuestion } from "./source-match.js";
import { contractSources, searchScopeSourceIds } from "./source-scope.js";

const DEFAULT_TOP_K = 8;
const MAX_TOP_K = 30;
const DEFAULT_SCORE_THRESHOLD = 0.15;
const MAX_RECORD_CONTENT_CHARS = 1200;

function stringValue(value) {
  return String(value || "").trim();
}

function objectValue(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function optionalBoolean(value, fallback = false) {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value === "boolean") return value;
  const normalized = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return fallback;
}

function clampedNumber(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}

function clampedInteger(value, fallback, min, max) {
  return Math.trunc(clampedNumber(value, fallback, min, max));
}

function compactText(value, maxChars = MAX_RECORD_CONTENT_CHARS) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxChars);
}

function pathBaseName(value) {
  return String(value || "").split(/[\\/]/).filter(Boolean).pop() || "";
}

function urlPathBaseName(value) {
  try {
    return pathBaseName(new URL(String(value || "")).pathname);
  } catch {
    return "";
  }
}

function isAbsoluteOrPrivatePath(value) {
  const text = String(value || "").trim();
  return /^[a-z]:[\\/]/i.test(text)
    || text.startsWith("\\\\")
    || text.startsWith("//")
    || /^https?:\/\//i.test(text);
}

function publicDisplayValue(value, fallback = "source") {
  const text = stringValue(value);
  if (!text) return fallback;
  if (/^https?:\/\//i.test(text)) return urlPathBaseName(text) || fallback;
  if (isAbsoluteOrPrivatePath(text)) return pathBaseName(text) || fallback;
  return text.replace(/\\/g, "/");
}

function publicDisplayPath(result = {}) {
  const candidates = [
    result.relativePath,
    result.pathLabel,
    result.fileLabel,
    result.title,
    result.path
  ].map(stringValue).filter(Boolean);

  for (const candidate of candidates) {
    const publicValue = publicDisplayValue(candidate, "");
    if (publicValue) return publicValue;
  }

  return "source";
}

function numberOrUndefined(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

function nonEmptyObject(entries) {
  return Object.fromEntries(
    Object.entries(entries).filter(([, value]) => value !== undefined && value !== null && value !== "")
  );
}

function normalizedLookupKey(value) {
  return String(value || "")
    .trim()
    .replace(/\\/g, "/")
    .toLowerCase();
}

function findSourceByIdentifier(identifier, sources = []) {
  const value = stringValue(identifier);
  if (!value) return null;

  const exact = sources.find((source) => source?.id === value);
  if (exact) return exact;

  const lookup = normalizedLookupKey(value);
  return sources.find((source) => {
    const title = normalizedLookupKey(source?.title);
    const base = normalizedLookupKey(pathBaseName(source?.path));
    return title === lookup || base === lookup;
  }) || null;
}

function bearerTokenFromHeader(header) {
  const match = String(header || "").match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : "";
}

function constantTimeEqual(left, right) {
  const leftBuffer = Buffer.from(String(left || ""));
  const rightBuffer = Buffer.from(String(right || ""));
  return leftBuffer.length === rightBuffer.length && crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

export function authorizeDifyAdapterRequest(authorizationHeader, env = process.env) {
  const expectedToken = stringValue(env.LOCALAI_DIFY_ADAPTER_TOKEN);
  if (!expectedToken) {
    return {
      ok: false,
      status: 503,
      error: "Dify adapter token is not configured"
    };
  }

  const incomingToken = bearerTokenFromHeader(authorizationHeader);
  if (!incomingToken || !constantTimeEqual(incomingToken, expectedToken)) {
    return {
      ok: false,
      status: 401,
      authenticate: true,
      error: "Dify adapter token is required"
    };
  }

  return { ok: true };
}

export function normalizeDifyRetrievalRequest(body = {}) {
  const hints = objectValue(body.hints);
  const privacy = objectValue(body.privacy);
  const retrievalSetting = objectValue(body.retrieval_setting || body.retrievalSetting);
  const metadataCondition = objectValue(body.metadata_condition || body.metadataCondition);

  return {
    query: stringValue(body.query || body.q || body.question),
    knowledgeId: stringValue(body.knowledge_id || body.knowledgeId),
    sourceId: stringValue(body.sourceId || body.source_id),
    topK: clampedInteger(
      body.top_k ?? body.topK ?? body.limit ?? retrievalSetting.top_k ?? retrievalSetting.topK,
      DEFAULT_TOP_K,
      1,
      MAX_TOP_K
    ),
    scoreThreshold: clampedNumber(
      body.score_threshold ?? body.scoreThreshold ?? retrievalSetting.score_threshold ?? retrievalSetting.scoreThreshold,
      DEFAULT_SCORE_THRESHOLD,
      0,
      1
    ),
    metadataCondition,
    hints: {
      project: stringValue(hints.project),
      questionLanguage: stringValue(hints.questionLanguage || hints.language),
      needFreshIndex: optionalBoolean(hints.needFreshIndex, false)
    },
    privacy: {
      allowRemoteContext: optionalBoolean(privacy.allowRemoteContext, false),
      requestedBy: stringValue(privacy.requestedBy)
    }
  };
}

export function resolveDifySource(request = {}, sources = []) {
  const explicitIdentifier = request.sourceId || request.knowledgeId;
  if (explicitIdentifier) {
    const source = findSourceByIdentifier(explicitIdentifier, sources);
    return {
      source,
      explicitSourceMissing: !source,
      matchedAutomatically: false,
      searchAllSources: false,
      score: source ? 100 : 0,
      candidates: []
    };
  }

  const autoQuery = [request.hints?.project, request.query].map(stringValue).filter(Boolean).join(" ");
  const autoMatch = matchSourceForQuestion(autoQuery, contractSources(sources));
  const source = autoMatch.source || null;
  const searchAllSources = hasAllSourcesIntent(request.query) || !source;

  return {
    source,
    explicitSourceMissing: false,
    matchedAutomatically: Boolean(source),
    searchAllSources,
    score: Number(autoMatch.score || 0),
    candidates: autoMatch.candidates || []
  };
}

export function difyPrivacyMetadata(settings = {}, request = {}) {
  const localPolicyAllowsRemote = Boolean(settings.llm?.allowRemoteContext ?? settings.llm?.remote?.enabled);
  const requesterAllowsRemote = Boolean(request.privacy?.allowRemoteContext);
  return {
    localFirst: true,
    remoteContextAllowed: Boolean(localPolicyAllowsRemote && requesterAllowsRemote),
    policySource: "LOCAL_RAG"
  };
}

function difySourceMetadata(source, sourceResolution = {}) {
  if (!source) return null;
  return {
    sourceId: source.id,
    title: source.title || "",
    matchedAutomatically: Boolean(sourceResolution.matchedAutomatically),
    score: Number(sourceResolution.score || 0)
  };
}

function difyRecord(result = {}, index = 0) {
  const citationLabel = `[${index + 1}]`;
  const documentLabel = publicDisplayValue(
    result.citationLabel || result.citationTarget?.label || result.title || result.fileLabel,
    ""
  );
  return {
    content: compactText(result.snippet || result.text),
    score: Number(result.score || 0),
    title: publicDisplayValue(result.title || result.fileLabel, ""),
    metadata: nonEmptyObject({
      sourceId: result.sourceId,
      chunkId: result.chunkId || result.id,
      fileId: result.fileId,
      path: publicDisplayPath(result),
      citationLabel,
      documentLabel,
      page: numberOrUndefined(result.pageStart),
      pageStart: numberOrUndefined(result.pageStart),
      pageEnd: numberOrUndefined(result.pageEnd),
      sheetName: result.sheetName,
      rowStart: numberOrUndefined(result.rowStart),
      rowEnd: numberOrUndefined(result.rowEnd),
      sectionTitle: result.sectionTitle,
      documentType: result.documentType
    })
  };
}

function buildWarnings({ request, sourceResolution, privacy, searchMetadata, recordCount }) {
  const warnings = [];
  if (request.hints?.needFreshIndex) {
    warnings.push("needFreshIndex was requested; adapter searched the current LOCAL_RAG index");
  }
  if (Object.keys(request.metadataCondition || {}).length) {
    warnings.push("metadata_condition was received; LOCAL_RAG adapter only applies source/project scope in this POC");
  }
  if (sourceResolution.searchAllSources && !hasAllSourcesIntent(request.query)) {
    warnings.push("source auto-match was not confident; searched all indexed sources");
  }
  if (request.privacy?.allowRemoteContext && !privacy.remoteContextAllowed) {
    warnings.push("remote context was denied by LOCAL_RAG privacy policy");
  }
  if (searchMetadata?.vectorStoreWarning) {
    warnings.push("vector store warning: " + searchMetadata.vectorStoreWarning);
  }
  if (!recordCount) {
    warnings.push("no records above score threshold");
  }
  return warnings;
}

export async function runDifyRetrieval({ body = {}, sources = [], settings = {}, manifest = null, searchChunks }) {
  const request = normalizeDifyRetrievalRequest(body);
  if (!request.query) {
    return {
      status: 400,
      payload: { error: "query is required" }
    };
  }

  if (typeof searchChunks !== "function") {
    throw new Error("searchChunks function is required");
  }

  const sourceResolution = resolveDifySource(request, sources);
  if (sourceResolution.explicitSourceMissing) {
    return {
      status: 404,
      payload: { error: "source was not found" }
    };
  }

  const sourceIds = sourceResolution.source
    ? searchScopeSourceIds(sourceResolution.source, sources)
    : null;
  const scopedSources = sourceIds
    ? sources.filter((source) => sourceIds.includes(source.id))
    : [];
  const expandedSourceIds = sourceIds && manifest
    ? indexSourceIdsForSources(scopedSources, manifest)
    : sourceIds;
  const searchResult = await searchChunks({
    query: request.query,
    sourceId: sourceResolution.source?.id || "",
    sourceIds: expandedSourceIds,
    limit: request.topK
  });
  const results = Array.isArray(searchResult?.results) ? searchResult.results : [];
  const filteredResults = results.filter((result) => Number(result.score || 0) >= request.scoreThreshold);
  const records = filteredResults.slice(0, request.topK).map(difyRecord);
  const privacy = difyPrivacyMetadata(settings, request);

  return {
    status: 200,
    payload: {
      query: request.query,
      source: difySourceMetadata(sourceResolution.source, sourceResolution),
      records,
      privacy,
      warnings: buildWarnings({
        request,
        sourceResolution,
        privacy,
        searchMetadata: searchResult?.metadata || {},
        recordCount: records.length
      })
    }
  };
}

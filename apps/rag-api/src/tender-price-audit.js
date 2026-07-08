import { buildCitationTarget, formatCitationLabel } from "./citations.js";
import { summarizeDbRecords } from "./hubtender-adapter.js";
import { compareMoney } from "./money.js";
import { isTenderSource } from "./source-scope.js";
import { readChunks, readSources } from "./store.js";

const DEFAULT_TOLERANCE_PERCENT = 1;

const PRICE_NUMBER_PATTERN = /(\d[\d\s]{0,15}(?:[,.]\d{1,6})?)\s*(?:₽|руб\.?|рубл\p{L}*)?/giu;
const LABELED_PRICE_PATTERN = /(?:цена|стоимость|итого|сумма|расценк\p{L}*)\s*[:\-]?\s*(\d[\d\s]{0,15}(?:[,.]\d{1,6})?)/giu;

function chunkMeta(chunk = {}) {
  return { ...chunk, ...(chunk.metadata || {}) };
}

export function isCommercialProposalChunk(chunk = {}) {
  const meta = chunkMeta(chunk);
  if (meta.sourceType !== "tender") return false;
  const isCommercial = meta.tenderCommercialProposal === true
    || meta.tenderDocumentType === "commercial_proposal";
  return isCommercial && meta.tenderHasPriceSignals === true;
}

export function filterCommercialProposalChunks(chunks = []) {
  return chunks.filter((chunk) => isCommercialProposalChunk(chunk));
}

export function findTenderSource(sources = [], {
  sourceId = "",
  tenderNumber = "",
  hubTenderId = ""
} = {}) {
  const id = String(sourceId || "").trim();
  if (id) {
    const byId = sources.find((source) => source.id === id && isTenderSource(source));
    if (byId) return byId;
  }

  const number = String(tenderNumber || "").trim();
  if (number) {
    const byNumber = sources.find((source) => {
      if (!isTenderSource(source)) return false;
      const title = String(source.title || "");
      return title === number
        || title.startsWith(`${number}.`)
        || title.startsWith(`${number} `)
        || title.includes(number);
    });
    if (byNumber) return byNumber;
  }

  const htId = String(hubTenderId || "").trim();
  if (htId) {
    const byLinked = sources.find((source) => (
      isTenderSource(source)
      && String(source.linkedContractId || "").trim() === htId
    ));
    if (byLinked) return byLinked;
  }

  return null;
}

function normalizeLabel(value = "") {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function basename(value = "") {
  return String(value || "").split(/[\\/]/).filter(Boolean).pop() || "";
}

export function extractPriceCandidatesFromText(text = "", context = {}) {
  const candidates = [];
  const source = String(text || "");
  if (!source.trim()) return candidates;

  const pushCandidate = (rawAmount, label, patternId, index) => {
    const amount = String(rawAmount || "").replace(/\s+/g, "").replace(",", ".");
    if (!/^\d+(?:\.\d+)?$/.test(amount)) return;
    const numeric = Number(amount);
    if (!Number.isFinite(numeric) || numeric <= 0) return;
    candidates.push({
      amount,
      label: String(label || "").trim(),
      supplier: String(context.supplier || "").trim(),
      patternId,
      index
    });
  };

  for (const match of source.matchAll(LABELED_PRICE_PATTERN)) {
    const start = Math.max(0, match.index - 80);
    const label = source.slice(start, match.index).split(/\n/).pop();
    pushCandidate(match[1], label, "labeled_price", match.index);
  }

  for (const match of source.matchAll(PRICE_NUMBER_PATTERN)) {
    const start = Math.max(0, match.index - 100);
    const label = source.slice(start, match.index).split(/\n/).pop();
    pushCandidate(match[1], label, "currency_number", match.index);
  }

  const seen = new Set();
  return candidates.filter((item) => {
    const key = `${item.amount}|${normalizeLabel(item.label)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function extractPriceCandidatesFromChunk(chunk = {}) {
  const meta = chunkMeta(chunk);
  const supplier = basename(meta.relativePath || chunk.path || chunk.title || "");
  return extractPriceCandidatesFromText(chunk.text || "", { supplier }).map((item) => ({
    ...item,
    chunkId: chunk.id || "",
    fileId: chunk.fileId || meta.fileId || "",
    sourceId: chunk.sourceId || meta.sourceId || "",
    path: chunk.path || meta.relativePath || "",
    title: chunk.title || basename(chunk.path || meta.relativePath || "")
  }));
}

export function buildAuditEvidence(chunk = {}, snippet = "") {
  const meta = chunkMeta(chunk);
  const item = {
    ...chunk,
    ...meta,
    snippet: snippet || String(chunk.text || "").slice(0, 400)
  };
  const citation = buildCitationTarget({
    ...item,
    citationLabel: formatCitationLabel(item)
  });

  return {
    sourceId: citation.sourceId || "",
    fileId: citation.fileId || "",
    chunkId: citation.chunkId || "",
    title: citation.fileLabel || "",
    path: item.path || meta.relativePath || "",
    citationLabel: citation.label || formatCitationLabel(item),
    snippet: citation.snippet || ""
  };
}

function recordComparableValues(record = {}) {
  return [
    { field: "totalCommercialMaterialCost", value: record.totalCommercialMaterialCost },
    { field: "totalCommercialWorkCost", value: record.totalCommercialWorkCost },
    { field: "materialCostPerUnit", value: record.materialCostPerUnit },
    { field: "workCostPerUnit", value: record.workCostPerUnit }
  ].filter((item) => item.value && item.value !== "0");
}

function quoteLinkMatchesRecord(record = {}, candidate = {}) {
  const quoteLink = normalizeLabel(record.quoteLink);
  if (!quoteLink) return false;
  const haystack = [
    candidate.title,
    candidate.path,
    candidate.supplier,
    candidate.label
  ].map(normalizeLabel).join(" ");
  const needle = normalizeLabel(basename(record.quoteLink));
  return haystack.includes(needle) || quoteLink.includes(normalizeLabel(candidate.supplier));
}

function positionMatchesCandidate(record = {}, candidate = {}) {
  const positionName = normalizeLabel(record.positionName);
  const label = normalizeLabel(candidate.label);
  if (!positionName || !label) return false;
  return label.includes(positionName) || positionName.includes(label.slice(0, Math.min(24, label.length)));
}

function chooseBestCandidate(record = {}, candidates = []) {
  const linked = candidates.filter((candidate) => quoteLinkMatchesRecord(record, candidate));
  const positioned = candidates.filter((candidate) => positionMatchesCandidate(record, candidate));
  const pool = linked.length ? linked : (positioned.length ? positioned : candidates);
  if (!pool.length) return null;

  let best = null;
  let bestScore = -1;
  for (const candidate of pool) {
    let score = 0;
    if (quoteLinkMatchesRecord(record, candidate)) score += 50;
    if (positionMatchesCandidate(record, candidate)) score += 30;
    if (record.supplier && normalizeLabel(record.supplier) === normalizeLabel(candidate.supplier)) score += 20;
    if (score > bestScore) {
      best = candidate;
      bestScore = score;
    }
  }
  return best;
}

export function compareRecordWithCandidates(record = {}, candidates = [], {
  tolerancePercent = DEFAULT_TOLERANCE_PERCENT,
  chunkById = new Map()
} = {}) {
  const findings = [];
  const comparable = recordComparableValues(record);
  if (!comparable.length) {
    findings.push({
      severity: "needs_review",
      field: "record",
      dbValue: null,
      expectedValue: null,
      delta: null,
      confidence: 0.2,
      rationale: "DB record has no comparable commercial price fields.",
      evidence: []
    });
    return findings;
  }

  const candidate = chooseBestCandidate(record, candidates);
  if (!candidate) {
    findings.push({
      severity: "needs_review",
      field: comparable[0].field,
      dbValue: comparable[0].value,
      expectedValue: null,
      delta: null,
      confidence: 0.25,
      rationale: "No KP price candidate matched supplier, quote_link, or position.",
      evidence: []
    });
    return findings;
  }

  const chunk = chunkById.get(candidate.chunkId) || {};
  const evidence = [buildAuditEvidence(chunk, candidate.label)];

  for (const item of comparable) {
    const comparison = compareMoney(item.value, candidate.amount, tolerancePercent);
    if (comparison.match) continue;

    const confidence = quoteLinkMatchesRecord(record, candidate)
      ? 0.9
      : (positionMatchesCandidate(record, candidate) ? 0.75 : 0.55);
    const severity = confidence >= 0.8 ? "error" : "warning";

    findings.push({
      severity,
      field: item.field,
      dbValue: comparison.leftNormalized,
      expectedValue: comparison.rightNormalized,
      delta: comparison.delta,
      confidence,
      rationale: `KP amount differs from DB ${item.field} beyond ${tolerancePercent}% tolerance.`,
      evidence
    });
  }

  return findings;
}

function aggregateStatus(findings = [], { hasDbRecords = true, hasCpChunks = true } = {}) {
  if (!hasCpChunks || !hasDbRecords) return "needs_review";
  if (findings.some((item) => item.severity === "error")) return "error";
  if (findings.some((item) => item.severity === "warning")) return "warning";
  if (findings.some((item) => item.severity === "needs_review")) return "needs_review";
  return "ok";
}

export async function runTenderPriceAudit({
  sourceId = "",
  tenderNumber = "",
  hubTenderId = "",
  tolerancePercent = DEFAULT_TOLERANCE_PERCENT,
  adapter = null,
  readSourcesFn = readSources,
  readChunksFn = readChunks
} = {}) {
  const checkedAt = new Date().toISOString();
  const sources = await readSourcesFn();
  const tenderSource = findTenderSource(sources, { sourceId, tenderNumber, hubTenderId });

  if (!tenderSource) {
    return {
      tenderId: sourceId || tenderNumber || hubTenderId || "",
      tenderTitle: "",
      checkedAt,
      status: "needs_review",
      dbRecord: null,
      findings: [{
        severity: "needs_review",
        field: "tenderSource",
        dbValue: null,
        expectedValue: null,
        delta: null,
        confidence: 0,
        rationale: "Tender source was not found in LocalAI sources.",
        evidence: []
      }],
      meta: { cpChunkCount: 0, dbRecordCount: 0 }
    };
  }

  const allChunks = await readChunksFn();
  const cpChunks = filterCommercialProposalChunks(
    allChunks.filter((chunk) => {
      const meta = chunkMeta(chunk);
      return (chunk.sourceId || meta.sourceId || meta.tenderSourceId) === tenderSource.id;
    })
  );

  const candidates = cpChunks.flatMap((chunk) => extractPriceCandidatesFromChunk(chunk));
  const chunkById = new Map(cpChunks.map((chunk) => [chunk.id, chunk]));

  const dbAdapter = adapter;
  let tenderSummary = null;
  if (hubTenderId) {
    tenderSummary = await dbAdapter.findTenderById(hubTenderId);
  }
  if (!tenderSummary && tenderNumber) {
    tenderSummary = await dbAdapter.findTenderByNumber(tenderNumber);
  }

  const resolvedTenderId = tenderSummary?.id || hubTenderId || "";
  const dbRecords = resolvedTenderId
    ? await dbAdapter.getPriceRecords(resolvedTenderId)
    : [];

  const findings = dbRecords.flatMap((record) => compareRecordWithCandidates(record, candidates, {
    tolerancePercent,
    chunkById
  }));

  if (!dbRecords.length) {
    findings.push({
      severity: "needs_review",
      field: "dbRecord",
      dbValue: null,
      expectedValue: null,
      delta: null,
      confidence: 0.1,
      rationale: resolvedTenderId
        ? "No HubTender price records were returned for this tender."
        : "HubTender tender id/number was not resolved; connect adapter or pass hubTenderId.",
      evidence: cpChunks.slice(0, 3).map((chunk) => buildAuditEvidence(chunk))
    });
  }

  if (!cpChunks.length) {
    findings.push({
      severity: "needs_review",
      field: "ragEvidence",
      dbValue: null,
      expectedValue: null,
      delta: null,
      confidence: 0.1,
      rationale: "No indexed commercial proposal chunks with price signals were found.",
      evidence: []
    });
  }

  const status = aggregateStatus(findings, {
    hasDbRecords: dbRecords.length > 0,
    hasCpChunks: cpChunks.length > 0
  });

  return {
    tenderId: tenderSource.id,
    tenderTitle: tenderSource.title || "",
    hubTenderId: tenderSummary?.id || "",
    hubTenderNumber: tenderSummary?.tenderNumber || tenderNumber || "",
    checkedAt,
    status,
    dbRecord: tenderSummary
      ? {
        ...publicTenderSummarySafe(tenderSummary),
        ...summarizeDbRecords(dbRecords)
      }
      : null,
    findings,
    meta: {
      cpChunkCount: cpChunks.length,
      priceCandidateCount: candidates.length,
      dbRecordCount: dbRecords.length,
      tolerancePercent
    }
  };
}

function publicTenderSummarySafe(summary = {}) {
  return {
    id: summary.id || "",
    tenderNumber: summary.tenderNumber || "",
    title: summary.title || "",
    version: summary.version || "",
    clientName: summary.clientName || ""
  };
}

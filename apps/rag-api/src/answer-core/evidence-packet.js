import { buildCitationTarget, formatCitationLabel } from "../citations.js";
import { prepareSearchQuery } from "../search-query.js";
import { tokenize } from "../text.js";

// Retrieval 2.0 (Product V2, Stage 06): turns ranked index chunks into a bounded evidence packet of
// Stage 04 evidence spans. BM25 + vectors + RRF + reranker stay the candidate generator; this layer adds
// structured fact hits for the planned entities, exact span selection inside chunks (precise
// section/sheet/row/page), version awareness, clause-neighbour expansion, source diversity and dedup.

export const PACKET_VERSION = "evidence/1";
export const MAX_ITEM_CHARS = 1400;

// Broad "main terms" questions cover these conditions through facts instead of a larger top-K,
// most material first (money, advance, warranty, liability), parties and VAT last.
export const OVERVIEW_FACT_TYPES = [
  "contract_price",
  "advance_percent",
  "warranty_period",
  "penalty_rate",
  "retention_percent",
  "retention_return_term",
  "work_start_date",
  "work_end_date",
  "advance_term",
  "vat_rate",
  "party_customer",
  "party_contractor"
];

// Up to this many spans per retrieved chunk, when they score close to the chunk's best span.
const MAX_SPANS_PER_CHUNK = 3;
const SPAN_SCORE_RATIO = 0.6;
const NEIGHBOUR_MAX_CHARS = 400;
const NEIGHBOUR_TOP_ITEMS = 3;
const NUMBER_TOKEN = /^\d+(?:[.,]\d+)?$/;

function stem(token) {
  return token.length >= 5 ? token.slice(0, 5) : token;
}

function queryProfile(question) {
  const { queryTerms } = prepareSearchQuery(question);
  const terms = new Set(queryTerms.map((term) => stem(String(term).toLowerCase())));
  const numbers = new Set((String(question).match(/\d+(?:[.,]\d+)?/g) || []).map((value) => value.replace(",", ".")));
  return { terms, numbers };
}

// Lexical score of one span against the question: shared word stems, exact numbers weigh more.
export function spanScore(span, profile) {
  const tokens = new Set(tokenize(span.text).map((token) => (NUMBER_TOKEN.test(token) ? token.replace(",", ".") : stem(token))));
  let score = 0;
  for (const term of profile.terms) if (tokens.has(term)) score += 1;
  for (const number of profile.numbers) if (tokens.has(number)) score += 2;
  return score;
}

const isCurrent = (fact) => fact.status === "active" || fact.status === "conflict";
const byNewest = (left, right) => String(right.validFrom || "").localeCompare(String(left.validFrom || ""));
const byOldest = (left, right) => String(left.validFrom || "").localeCompare(String(right.validFrom || ""));

/**
 * Facts for the planned entities, grouped by fact type in plan order. Within a type:
 * - current policy: current values first, each followed by the values it replaced (history, labelled
 *   superseded) — the answer can state the change instead of silently dropping the old clause;
 * - historical: superseded values first; all: chronological.
 */
function factsForPlan(plan, provider, sourceIds) {
  const overview = plan.intent === "overview";
  const factTypes = plan.entities?.length ? plan.entities : (overview ? OVERVIEW_FACT_TYPES : []);
  if (!factTypes.length) return [];
  const facts = provider.factsForSources({ sourceIds, factTypes });
  const ordered = [];
  for (const factType of factTypes) {
    const ofType = facts.filter((fact) => fact.factType === factType);
    if (plan.versionPolicy === "all") {
      ordered.push(...[...ofType].sort(byOldest));
      continue;
    }
    const current = ofType.filter(isCurrent).sort(byNewest);
    const superseded = ofType.filter((fact) => !isCurrent(fact)).sort(byNewest);
    if (plan.versionPolicy === "historical") {
      ordered.push(...superseded, ...current);
      continue;
    }
    for (const fact of current) {
      ordered.push(fact);
      ordered.push(...superseded.filter((old) => old.supersededByFactId === fact.factId));
    }
    ordered.push(...superseded.filter((old) => !ordered.includes(old)));
  }
  return ordered;
}

function interleaveBySource(items) {
  const bySource = new Map();
  for (const item of items) {
    if (!bySource.has(item.span.sourceId)) bySource.set(item.span.sourceId, []);
    bySource.get(item.span.sourceId).push(item);
  }
  const queues = [...bySource.values()];
  const result = [];
  while (queues.some((queue) => queue.length)) {
    for (const queue of queues) if (queue.length) result.push(queue.shift());
  }
  return result;
}

function toResult(item, index, context) {
  const { span } = item;
  const chunk = context.chunkById.get(span.chunkId) || context.chunkByFile.get(span.fileId) || null;
  const document = context.documentById.get(span.documentId) || null;
  const fileLabel = chunk?.title || document?.fileLabel || span.fileId;
  const text = [span.text, item.neighbour?.text].filter(Boolean).join("\n\n").slice(0, MAX_ITEM_CHARS);
  const result = {
    id: span.chunkId || span.evidenceId,
    chunkId: span.chunkId || "",
    evidenceId: span.evidenceId,
    fileId: span.fileId,
    score: Number(item.score.toFixed(3)),
    searchMode: chunk?.searchMode || "evidence",
    sourceId: span.sourceId,
    sourceTitle: chunk?.sourceTitle || context.sourceTitleById.get(span.sourceId) || "",
    sourceType: chunk?.sourceType || "",
    title: fileLabel,
    fileLabel,
    path: chunk?.path || fileLabel,
    pathLabel: fileLabel,
    documentType: chunk?.documentType || "",
    pageStart: span.pageStart ?? undefined,
    pageEnd: span.pageEnd ?? undefined,
    sheetName: span.sheetName || "",
    rowStart: span.rowStart ?? undefined,
    rowEnd: span.rowEnd ?? undefined,
    sectionTitle: span.sectionTitle || "",
    relativePath: chunk?.relativePath || "",
    metadata: chunk?.metadata || {},
    chunkIndex: chunk?.chunkIndex,
    retrievalReason: item.reason,
    citationEvidence: span.text.slice(0, 900),
    snippet: span.text.slice(0, 300),
    text
  };
  result.citationLabel = formatCitationLabel(result);
  result.citationTarget = buildCitationTarget(result, index);
  return result;
}

/**
 * @param {object} input
 * @param {object} input.plan          query plan (intent, entities, versionPolicy)
 * @param {string} input.question      question used for retrieval
 * @param {Array}  input.chunkResults  ranked results of searchChunksWithMetadata
 * @param {Array|null} input.sourceIds search scope (null = all sources)
 * @param {object} input.provider      evidence provider (store or memory)
 * @param {number} input.limit         maximum number of packet items
 * @returns {{ results: Array, diagnostics: object }}
 */
export function buildEvidencePacket({ plan = {}, question = "", chunkResults = [], sourceIds = null, provider, limit = 12, sources = [] }) {
  const profile = queryProfile(question);
  const versionPolicy = plan.versionPolicy || "current";
  const chunkById = new Map(chunkResults.map((chunk) => [chunk.chunkId || chunk.id, chunk]));
  const chunkByFile = new Map();
  for (const chunk of chunkResults) if (chunk.fileId && !chunkByFile.has(chunk.fileId)) chunkByFile.set(chunk.fileId, chunk);

  // 1. Structured fact hits for the planned entities.
  const facts = factsForPlan(plan, provider, sourceIds);
  const factSpanIds = facts.flatMap((fact) => fact.evidenceIds.slice(0, 1));
  const spanById = new Map(provider.spansByIds(factSpanIds).map((span) => [span.evidenceId, span]));
  const factItems = facts
    .map((fact) => ({ span: spanById.get(fact.evidenceIds[0]), reason: `fact:${fact.factType}:${fact.status}`, score: 100, fact }))
    .filter((item) => item.span);

  // 2. Exact spans inside the retrieved chunks, in chunk rank order.
  const chunkSpans = provider.spansForChunks([...chunkById.keys()]);
  const spansByChunk = new Map();
  for (const span of chunkSpans) {
    if (!spansByChunk.has(span.chunkId)) spansByChunk.set(span.chunkId, []);
    spansByChunk.get(span.chunkId).push(span);
  }
  // Spans already taken as fact evidence are not re-picked, so a chunk still contributes its other
  // relevant spans (e.g. the "Бетон B30" row next to the already cited "Итого" row).
  const factSpanSet = new Set(factItems.map((item) => item.span.evidenceId));
  const chunkItems = [];
  const fallbackChunks = [];
  chunkResults.forEach((chunk, rank) => {
    const spans = spansByChunk.get(chunk.chunkId || chunk.id) || [];
    if (!spans.length) {
      fallbackChunks.push(chunk);
      return;
    }
    const scored = spans
      .filter((span) => !factSpanSet.has(span.evidenceId))
      .map((span) => ({ span, score: spanScore(span, profile) }))
      .filter((item) => item.score > 0)
      .sort((left, right) => right.score - left.score || left.span.ordinal - right.span.ordinal);
    const best = scored[0]?.score || 0;
    scored
      .filter((item) => item.score >= best * SPAN_SCORE_RATIO)
      .slice(0, MAX_SPANS_PER_CHUNK)
      .forEach((item) => chunkItems.push({ ...item, reason: `chunk:${rank + 1}`, chunkRank: rank + 1 }));
  });

  // 3. Version awareness: spans that only evidence a superseded fact go below current evidence.
  const supersededSpanIds = new Set(
    (versionPolicy === "current" ? provider.factsForSources({ sourceIds, factTypes: null, statuses: ["superseded"] }) : [])
      .flatMap((fact) => fact.evidenceIds)
  );
  const currentSpanIds = new Set(facts.filter((fact) => fact.status !== "superseded").flatMap((fact) => fact.evidenceIds));
  const isStale = (item) => versionPolicy === "current" && supersededSpanIds.has(item.span.evidenceId) && !currentSpanIds.has(item.span.evidenceId);

  // 4. Merge, dedup (same span, or same text within one project), stale evidence last. Identical clauses
  // of different projects are separate evidence: an aggregate answer must see every project.
  const seenSpans = new Set();
  const seenTexts = new Set();
  const merged = [];
  let demoted = 0;
  const ordered = [...factItems, ...chunkItems.filter((item) => !isStale(item))];
  const stale = chunkItems.filter(isStale);
  demoted = stale.length;
  for (const item of [...ordered, ...stale]) {
    const textKey = `${item.span.sourceId}|${item.span.text.replace(/\s+/g, " ").trim().toLowerCase()}`;
    if (seenSpans.has(item.span.evidenceId) || seenTexts.has(textKey)) continue;
    seenSpans.add(item.span.evidenceId);
    seenTexts.add(textKey);
    merged.push(stale.includes(item) ? { ...item, reason: `${item.reason}:superseded` } : item);
  }

  // 5. Aggregate/compare questions must not be monopolised by one source.
  const diversified = plan.intent === "aggregate" || plan.intent === "compare" ? interleaveBySource(merged) : merged;
  const bounded = diversified.slice(0, limit);

  // 6. Clause expansion: a short top span brings the next paragraph of the same section (e.g. 5.1 + 5.2).
  bounded.slice(0, NEIGHBOUR_TOP_ITEMS).forEach((item) => {
    if (item.span.kind !== "paragraph" || item.span.text.length > NEIGHBOUR_MAX_CHARS) return;
    const neighbour = provider.neighborSpan(item.span.documentId, item.span.ordinal + 1);
    if (neighbour && neighbour.kind === "paragraph" && neighbour.sectionTitle && neighbour.sectionTitle === item.span.sectionTitle
      && !seenSpans.has(neighbour.evidenceId)) {
      item.neighbour = neighbour;
    }
  });

  const documentIds = [...new Set(bounded.map((item) => item.span.documentId))];
  const context = {
    chunkById,
    chunkByFile,
    documentById: new Map(provider.documentsByIds(documentIds).map((document) => [document.documentId, document])),
    sourceTitleById: new Map(sources.map((source) => [source.id, source.title]))
  };
  const spanResults = bounded.map((item, index) => toResult(item, index, context));
  // Chunks without evidence spans (evidence not built yet) keep their original result form.
  const results = [...spanResults, ...fallbackChunks].slice(0, limit);

  return {
    results,
    diagnostics: {
      packetVersion: PACKET_VERSION,
      versionPolicy,
      intent: plan.intent || "",
      candidates: { chunks: chunkResults.length, chunkSpans: chunkSpans.length, facts: facts.length },
      demotedSuperseded: demoted,
      fallbackChunks: fallbackChunks.length,
      items: results.map((result, index) => ({
        rank: index + 1,
        evidenceId: result.evidenceId || "",
        chunkId: result.chunkId || result.id || "",
        reason: result.retrievalReason || "chunk:fallback"
      }))
    }
  };
}

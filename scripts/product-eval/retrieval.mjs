import { buildCitationTarget, formatCitationLabel } from "../../apps/rag-api/src/citations.js";
import { expandedChatRetrievalQuery } from "../../apps/rag-api/src/chat-intent.js";
import { resolveChatSourceScope } from "../../apps/rag-api/src/chat-scope.js";
import { buildEvidencePacket } from "../../apps/rag-api/src/answer-core/evidence-packet.js";
import { planQuery } from "../../apps/rag-api/src/answer-core/query-planner.js";
import { prepareSearchQuery } from "../../apps/rag-api/src/search-query.js";
import {
  buildLexicalCandidates,
  filterChunksBySource,
  scoreSearchChunks
} from "../../apps/rag-api/src/search-pipeline.js";

export const RETRIEVAL_TOP_K = 10;
export const RETRIEVAL_MODES = ["v2", "legacy"];

function toEvalResult(item, index) {
  return {
    rank: index + 1,
    id: item.id,
    chunkId: item.chunkId || item.id,
    evidenceId: item.evidenceId || "",
    fileId: item.fileId || "",
    sourceId: item.sourceId,
    path: item.path,
    title: item.title,
    text: item.text,
    score: Number(Number(item.score || 0).toFixed(4)),
    retrievalReason: item.retrievalReason || "",
    citationLabel: item.citationLabel || formatCitationLabel(item),
    citationTarget: item.citationTarget || buildCitationTarget(item, index)
  };
}

// Offline mirror of the /api/chat retrieval path: same scope resolution and query expansion,
// BM25 + hybrid scoring without embeddings/Qdrant/reranker (those need live services).
function searchChunks({ query, chunks, searchSourceIds, searchAllSources }) {
  const { originalTerms, queryTerms, phrase } = prepareSearchQuery(query);
  const scopedChunks = searchAllSources ? chunks : filterChunksBySource(chunks, "", searchSourceIds);
  const lexicalCandidates = buildLexicalCandidates({
    chunks: scopedChunks,
    queryTerms,
    phrase,
    lexicalMode: "bm25",
    topK: 200
  });
  const lexicalScoreById = new Map(lexicalCandidates.map((candidate) => [candidate.chunkId, Number(candidate.score || 0)]));

  return scoreSearchChunks({
    chunks: lexicalCandidates.map((candidate) => candidate.chunk),
    originalTerms,
    queryTerms,
    phrase,
    lexicalMode: "bm25",
    lexicalScoreById
  })
    .filter((chunk) => chunk.score > 0)
    .sort((left, right) => right.score - left.score)
    .slice(0, RETRIEVAL_TOP_K)
    .map((chunk) => ({ ...chunk, chunkId: chunk.id }));
}

// The web UI sends the previous session's project as contextSourceId; follow-up cases replay that.
function contextSourceIdFromHistory(testCase, sources) {
  if (testCase.request.contextSourceId) return testCase.request.contextSourceId;
  let contextSourceId = "";
  for (const turn of testCase.history) {
    const scope = resolveChatSourceScope({ question: turn.question, contextSourceId, sources });
    if (scope.sourceId) contextSourceId = scope.sourceId;
  }
  return contextSourceId;
}

/**
 * Runs one eval case. mode "legacy" = chunk results as /api/chat used them before Stage 06;
 * mode "v2" = the same chunks turned into an evidence packet (Retrieval 2.0) with the corpus evidence.
 */
export function runRetrievalCase(testCase, { sources, chunks, evidenceProvider = null, mode = "v2" }) {
  const contextSourceId = contextSourceIdFromHistory(testCase, sources);
  const scope = resolveChatSourceScope({
    question: testCase.question,
    requestedSourceId: testCase.request.sourceId,
    contextSourceId,
    sources
  });

  // /api/chat answers with a clarification and does not search when the requested project is missing
  // or when the query planner finds several equally matching projects (Stage 05).
  const plan = planQuery({
    question: testCase.question,
    requestedSourceId: testCase.request.sourceId,
    contextSourceId,
    sources
  });
  const clarificationPredicted = Boolean(scope.requestedSourceMissing || plan.needsClarification);
  let results = [];
  let packetDiagnostics = null;
  if (!clarificationPredicted) {
    const chunkResults = searchChunks({
      query: expandedChatRetrievalQuery(testCase.question),
      chunks,
      searchSourceIds: scope.searchSourceIds,
      searchAllSources: scope.searchAllSources
    });
    if (mode === "v2" && evidenceProvider) {
      const packet = buildEvidencePacket({
        plan,
        question: testCase.question,
        chunkResults,
        sourceIds: scope.searchAllSources ? null : scope.searchSourceIds,
        provider: evidenceProvider,
        limit: RETRIEVAL_TOP_K,
        sources
      });
      results = packet.results.map(toEvalResult);
      packetDiagnostics = packet.diagnostics;
    } else {
      results = chunkResults.map(toEvalResult);
    }
  }

  return {
    scope: {
      sourceId: scope.sourceId,
      searchAllSources: scope.searchAllSources,
      contextSourceId,
      contextSourceUsed: scope.contextSourceUsed,
      autoMatchCandidates: (scope.autoMatch?.candidates || []).map((candidate) => candidate.id)
    },
    plan: { intent: plan.intent, entities: plan.entities, versionPolicy: plan.versionPolicy },
    clarificationPredicted,
    packetDiagnostics,
    results
  };
}

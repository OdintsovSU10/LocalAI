import { buildCitationTarget, formatCitationLabel } from "../../apps/rag-api/src/citations.js";
import { expandedChatRetrievalQuery } from "../../apps/rag-api/src/chat-intent.js";
import { resolveChatSourceScope } from "../../apps/rag-api/src/chat-scope.js";
import { planQuery } from "../../apps/rag-api/src/answer-core/query-planner.js";
import { prepareSearchQuery } from "../../apps/rag-api/src/search-query.js";
import {
  buildLexicalCandidates,
  filterChunksBySource,
  scoreSearchChunks
} from "../../apps/rag-api/src/search-pipeline.js";

export const RETRIEVAL_TOP_K = 10;

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
    .map((chunk, index) => ({
      rank: index + 1,
      id: chunk.id,
      sourceId: chunk.sourceId,
      path: chunk.path,
      title: chunk.title,
      text: chunk.text,
      score: Number(Number(chunk.score || 0).toFixed(4)),
      citationLabel: formatCitationLabel(chunk),
      citationTarget: buildCitationTarget(chunk, index)
    }));
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

export function runRetrievalCase(testCase, { sources, chunks }) {
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
  const results = clarificationPredicted
    ? []
    : searchChunks({
        query: expandedChatRetrievalQuery(testCase.question),
        chunks,
        searchSourceIds: scope.searchSourceIds,
        searchAllSources: scope.searchAllSources
      });

  return {
    scope: {
      sourceId: scope.sourceId,
      searchAllSources: scope.searchAllSources,
      contextSourceId,
      contextSourceUsed: scope.contextSourceUsed,
      autoMatchCandidates: (scope.autoMatch?.candidates || []).map((candidate) => candidate.id)
    },
    clarificationPredicted,
    results
  };
}

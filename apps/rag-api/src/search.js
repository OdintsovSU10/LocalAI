import fs from "node:fs/promises";
import { chunksPath, vectorsPath } from "./paths.js";
import { buildCitationTarget, formatCitationLabel } from "./citations.js";
import { embedQuery } from "./embeddings.js";
import { rerankSearchResults } from "./reranker.js";
import { readChunks, readSettings } from "./store.js";
import { snippet } from "./text.js";
import { prepareSearchQuery } from "./search-query.js";
import {
  buildLexicalCandidates,
  buildVectorCandidates,
  filterChunksBySource,
  rrfMergeCandidates,
  scoreSearchChunks
} from "./search-pipeline.js";
import { searchQdrantVectors } from "./vector-store.js";

export { buildBm25Index, bm25Idf, searchBm25 } from "./search-bm25.js";
export { expandQueryTerms, prepareSearchQuery, tokenize, tokenizeQuery } from "./search-query.js";
export {
  HYBRID_LEXICAL_WEIGHT,
  HYBRID_VECTOR_WEIGHT,
  mergeVectorLexicalScore,
  normalizeLexicalScore,
  phraseRerankBoost,
  scoreChunk
} from "./search-scoring.js";
export {
  buildLexicalCandidates,
  buildVectorCandidates,
  filterChunksBySource,
  lexicalScoresForChunks,
  rrfMergeCandidates,
  scoreSearchChunks,
  vectorScoreForChunk
} from "./search-pipeline.js";

const jsonCache = new Map();

function emptySearchMetadata(overrides = {}) {
  return {
    vectorCandidateCount: 0,
    lexicalCandidateCount: 0,
    mergedCandidateCount: 0,
    rerankerUsed: false,
    qdrantUsed: false,
    vectorProviderUsed: "json",
    vectorStoreWarning: "",
    timings: {
      retrievalMs: 0,
      rerankMs: 0
    },
    ...overrides
  };
}

async function readCachedJson(filePath, fallback) {
  try {
    const stat = await fs.stat(filePath);
    const cached = jsonCache.get(filePath);
    if (cached && cached.mtimeMs === stat.mtimeMs) return cached.data;

    const data = JSON.parse(await fs.readFile(filePath, "utf8"));
    jsonCache.set(filePath, { mtimeMs: stat.mtimeMs, data });
    return data;
  } catch {
    return fallback;
  }
}

function normalizeCandidateSettings(settings = {}) {
  const search = settings.search || {};
  return {
    lexicalMode: search.lexicalMode || "bm25",
    vectorCandidates: Number(search.vectorCandidates || 200),
    lexicalCandidates: Number(search.lexicalCandidates || 200),
    finalCandidates: Number(search.finalCandidates || 60),
    rerankCandidates: Number(search.rerankCandidates || 30)
  };
}

function qdrantVectorCandidates(matches = [], chunksById = new Map(), limit = 200) {
  return matches
    .map((match) => ({
      chunk: chunksById.get(match.chunkId),
      chunkId: match.chunkId,
      score: Number(match.score || 0)
    }))
    .filter((candidate) => candidate.chunk && candidate.score > 0)
    .slice(0, Math.max(0, Number(limit || 0)));
}

function candidateScoreMap(candidates = []) {
  return new Map(candidates.map((candidate) => [candidate.chunkId, Number(candidate.score || 0)]));
}

function formatSearchResults(chunks, query, rerankerError) {
  return chunks.map((chunk, index) => {
    const citationLabel = formatCitationLabel(chunk);
    const result = {
      id: chunk.id,
      chunkId: chunk.id,
      fileId: chunk.fileId || chunk.metadata?.fileId || "",
      score: Number(chunk.score.toFixed(3)),
      lexicalScore: Number(chunk.lexicalScore.toFixed(3)),
      vectorScore: Number(chunk.vectorScore.toFixed(3)),
      rerankBoost: Number(chunk.rerankBoost.toFixed(3)),
      rerankScore: Number((chunk.rerankScore || 0).toFixed(3)),
      searchMode: chunk.searchMode,
      vectorError: chunk.vectorError,
      rerankerError,
      sourceId: chunk.sourceId,
      sourceTitle: chunk.sourceTitle,
      sourceType: chunk.sourceType || chunk.metadata?.sourceType || "",
      title: chunk.title,
      fileLabel: chunk.title || "",
      path: chunk.path,
      pathLabel: chunk.title || "",
      citationLabel,
      documentType: chunk.documentType || chunk.metadata?.documentType || "",
      pageStart: chunk.pageStart ?? chunk.metadata?.pageStart,
      pageEnd: chunk.pageEnd ?? chunk.metadata?.pageEnd,
      totalPages: chunk.totalPages ?? chunk.metadata?.totalPages,
      sheetName: chunk.sheetName || chunk.metadata?.sheetName || "",
      rowStart: chunk.rowStart ?? chunk.metadata?.rowStart,
      rowEnd: chunk.rowEnd ?? chunk.metadata?.rowEnd,
      sectionTitle: chunk.sectionTitle || chunk.metadata?.sectionTitle || "",
      relativePath: chunk.relativePath || chunk.metadata?.relativePath || "",
      tenderDocumentType: chunk.tenderDocumentType || chunk.metadata?.tenderDocumentType || "",
      tenderCommercialProposal: Boolean(chunk.tenderCommercialProposal ?? chunk.metadata?.tenderCommercialProposal),
      tenderHasPriceSignals: Boolean(chunk.tenderHasPriceSignals ?? chunk.metadata?.tenderHasPriceSignals),
      tenderSignalScore: Number(chunk.tenderSignalScore ?? chunk.metadata?.tenderSignalScore ?? 0),
      metadata: chunk.metadata || {},
      chunkIndex: chunk.chunkIndex,
      snippet: snippet(chunk.text, query),
      text: chunk.text
    };
    return {
      ...result,
      citationTarget: buildCitationTarget(result, index)
    };
  });
}

export async function searchChunksWithMetadata({ query, sourceId, sourceIds = null, limit = 10 }) {
  const retrievalStartedAt = Date.now();
  const { originalTerms, queryTerms, phrase } = prepareSearchQuery(query);
  if (queryTerms.length === 0) {
    return { results: [], metadata: emptySearchMetadata() };
  }

  const settings = await readSettings();
  const candidateSettings = normalizeCandidateSettings(settings);
  const chunks = settings.storage?.metadataProvider === "sqlite"
    ? await readChunks()
    : await readCachedJson(chunksPath(), []);
  const filteredChunks = filterChunksBySource(chunks, sourceId, sourceIds);
  const chunksById = new Map(filteredChunks.map((chunk) => [chunk.id, chunk]));
  let queryVector = null;
  let embeddingModel = "";
  let vectorItems = {};
  let vectorError = "";
  let vectorSource = "json";
  let qdrantUsed = false;
  let vectorProviderUsed = "json";
  let vectorStoreWarning = "";
  let qdrantScores = new Map();
  let vectorCandidates = [];

  try {
    const embedded = await embedQuery(query, settings);
    if (embedded?.vector?.length) {
      queryVector = embedded.vector;
      embeddingModel = embedded.model;
      const qdrantResult = await searchQdrantVectors({
        vectorStore: settings.vectorStore,
        vector: queryVector,
        sourceId,
        sourceIds,
        limit: candidateSettings.vectorCandidates
      });

      if (qdrantResult.available) {
        vectorSource = "qdrant";
        qdrantUsed = true;
        vectorProviderUsed = qdrantResult.vectorProviderUsed || "qdrant";
        vectorCandidates = qdrantVectorCandidates(qdrantResult.matches, chunksById, candidateSettings.vectorCandidates);
        qdrantScores = candidateScoreMap(vectorCandidates);
      } else {
        vectorError = qdrantResult.error || "";
        vectorProviderUsed = qdrantResult.vectorProviderUsed || "json";
        vectorStoreWarning = qdrantResult.warning || "";
        vectorItems = (await readCachedJson(vectorsPath(), { version: 1, items: {} })).items || {};
        vectorCandidates = buildVectorCandidates({
          chunks: filteredChunks,
          queryVector,
          embeddingModel,
          vectorItems,
          vectorSource,
          topK: candidateSettings.vectorCandidates
        });
      }
    }
  } catch (error) {
    vectorError = error.message;
    vectorProviderUsed = settings.vectorStore?.provider === "qdrant" ? "qdrant" : vectorProviderUsed;
  }

  const lexicalCandidates = buildLexicalCandidates({
    chunks: filteredChunks,
    queryTerms,
    phrase,
    lexicalMode: candidateSettings.lexicalMode,
    topK: candidateSettings.lexicalCandidates
  });
  const mergedCandidates = rrfMergeCandidates({
    vectorCandidates,
    lexicalCandidates,
    finalCandidates: candidateSettings.finalCandidates
  });
  const lexicalScoreById = candidateScoreMap(lexicalCandidates);
  const vectorScoreById = qdrantUsed ? qdrantScores : candidateScoreMap(vectorCandidates);

  const withHybridScore = scoreSearchChunks({
    chunks: mergedCandidates.map((candidate) => candidate.chunk),
    originalTerms,
    queryTerms,
    phrase,
    lexicalMode: candidateSettings.lexicalMode,
    lexicalScoreById,
    queryVector,
    embeddingModel,
    vectorItems,
    vectorSource,
    qdrantScores: vectorScoreById,
    vectorError
  });

  const candidates = withHybridScore
    .filter((chunk) => chunk.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, Math.max(limit, candidateSettings.rerankCandidates));
  const retrievalMs = Date.now() - retrievalStartedAt;
  const rerankStartedAt = Date.now();
  const reranked = await rerankSearchResults({ query, chunks: candidates, limit, reranker: settings.reranker });
  const rerankMs = Date.now() - rerankStartedAt;
  const results = formatSearchResults(reranked.chunks.slice(0, limit), query, reranked.rerankerError);

  return {
    results,
    metadata: emptySearchMetadata({
    vectorCandidateCount: vectorCandidates.length,
    lexicalCandidateCount: lexicalCandidates.length,
    mergedCandidateCount: mergedCandidates.length,
    rerankerUsed: Boolean(reranked.rerankerUsed),
    qdrantUsed,
    vectorProviderUsed,
    vectorStoreWarning,
    timings: {
      retrievalMs,
        rerankMs
      }
    })
  };
}

export async function searchChunks(options) {
  const { results } = await searchChunksWithMetadata(options);
  return results;
}

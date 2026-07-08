import { mergeVectorLexicalScore, phraseRerankBoost, scoreChunk } from "./search-scoring.js";
import { buildBm25Index, searchBm25 } from "./search-bm25.js";

function dotProduct(a, b) {
  const length = Math.min(a?.length || 0, b?.length || 0);
  let sum = 0;
  for (let i = 0; i < length; i += 1) sum += a[i] * b[i];
  return sum;
}

export function filterChunksBySource(chunks = [], sourceId = "", sourceIds = null) {
  const scopedIds = Array.isArray(sourceIds)
    ? sourceIds.map((id) => String(id || "").trim()).filter(Boolean)
    : [];
  if (scopedIds.length) {
    const allowed = new Set(scopedIds);
    return chunks.filter((chunk) => allowed.has(chunk.sourceId));
  }
  return chunks.filter((chunk) => !sourceId || chunk.sourceId === sourceId);
}

export function vectorScoreForChunk(chunk, {
  queryVector = null,
  embeddingModel = "",
  vectorItems = {},
  vectorSource = "json",
  qdrantScores = new Map()
} = {}) {
  const vector = vectorItems[chunk.id];
  if (queryVector && vectorSource === "qdrant") {
    return qdrantScores.get(chunk.id) || 0;
  }
  if (queryVector && vector?.model === embeddingModel && Array.isArray(vector.vector)) {
    return dotProduct(queryVector, vector.vector);
  }
  return 0;
}

function normalizeLexicalMode(mode) {
  return String(mode || "").trim().toLowerCase() === "bm25" ? "bm25" : "simple";
}

function normalizeTopK(value, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(0, Math.floor(number));
}

export function lexicalScoresForChunks(chunks = [], queryTerms = [], phrase = "", lexicalMode = "simple") {
  const simpleScores = chunks.map((chunk) => scoreChunk(chunk, queryTerms, phrase));
  if (normalizeLexicalMode(lexicalMode) !== "bm25") return simpleScores;

  const bm25Results = searchBm25(buildBm25Index(chunks), queryTerms, chunks.length);
  if (!bm25Results.length) return simpleScores;

  const bm25Scores = new Map(bm25Results.map((result) => [result.chunkId, result.score]));
  return chunks.map((chunk, index) => bm25Scores.get(chunk.id) ?? simpleScores[index]);
}

export function buildLexicalCandidates({
  chunks = [],
  queryTerms = [],
  phrase = "",
  lexicalMode = "simple",
  topK = 200
} = {}) {
  const limit = normalizeTopK(topK, 200);
  if (!limit || !chunks.length || !queryTerms.length) return [];

  if (normalizeLexicalMode(lexicalMode) === "bm25") {
    const bm25Results = searchBm25(buildBm25Index(chunks), queryTerms, limit);
    if (bm25Results.length) return bm25Results;
  }

  return chunks
    .map((chunk) => ({
      chunk,
      chunkId: chunk.id,
      score: scoreChunk(chunk, queryTerms, phrase)
    }))
    .filter((candidate) => candidate.score > 0)
    .sort((left, right) => right.score - left.score)
    .slice(0, limit);
}

export function buildVectorCandidates({
  chunks = [],
  queryVector = null,
  embeddingModel = "",
  vectorItems = {},
  vectorSource = "json",
  qdrantScores = new Map(),
  topK = 200
} = {}) {
  const limit = normalizeTopK(topK, 200);
  if (!limit || !chunks.length || !queryVector) return [];

  return chunks
    .map((chunk) => ({
      chunk,
      chunkId: chunk.id,
      score: vectorScoreForChunk(chunk, {
        queryVector,
        embeddingModel,
        vectorItems,
        vectorSource,
        qdrantScores
      })
    }))
    .filter((candidate) => candidate.score > 0)
    .sort((left, right) => right.score - left.score)
    .slice(0, limit);
}

function addRankedCandidate(target, candidate, rank, source, rrfK) {
  if (!candidate?.chunkId || !candidate?.chunk) return;
  const existing = target.get(candidate.chunkId) || {
    chunkId: candidate.chunkId,
    chunk: candidate.chunk,
    vectorRank: null,
    lexicalRank: null,
    vectorScore: 0,
    lexicalScore: 0,
    existingScore: 0,
    rrfScore: 0
  };

  existing.rrfScore += 1 / (rrfK + rank);
  existing.existingScore += Number(candidate.score || 0);
  if (source === "vector") {
    existing.vectorRank = existing.vectorRank ?? rank;
    existing.vectorScore = Math.max(existing.vectorScore, Number(candidate.score || 0));
  } else {
    existing.lexicalRank = existing.lexicalRank ?? rank;
    existing.lexicalScore = Math.max(existing.lexicalScore, Number(candidate.score || 0));
  }
  target.set(candidate.chunkId, existing);
}

export function rrfMergeCandidates({
  vectorCandidates = [],
  lexicalCandidates = [],
  finalCandidates = 60,
  rrfK = 60
} = {}) {
  const merged = new Map();
  vectorCandidates.forEach((candidate, index) => addRankedCandidate(merged, candidate, index + 1, "vector", rrfK));
  lexicalCandidates.forEach((candidate, index) => addRankedCandidate(merged, candidate, index + 1, "lexical", rrfK));

  return Array.from(merged.values())
    .sort((left, right) => {
      if (right.rrfScore !== left.rrfScore) return right.rrfScore - left.rrfScore;
      return right.existingScore - left.existingScore;
    })
    .slice(0, normalizeTopK(finalCandidates, 60));
}

export function scoreSearchChunks({
  chunks = [],
  sourceId = "",
  originalTerms = [],
  queryTerms = [],
  phrase = "",
  lexicalMode = "simple",
  lexicalScoreById = null,
  queryVector = null,
  embeddingModel = "",
  vectorItems = {},
  vectorSource = "json",
  qdrantScores = new Map(),
  vectorError = ""
} = {}) {
  const filtered = filterChunksBySource(chunks, sourceId);
  const lexicalScores = lexicalScoreById
    ? filtered.map((chunk) => lexicalScoreById.get(chunk.id) ?? scoreChunk(chunk, queryTerms, phrase))
    : lexicalScoresForChunks(filtered, queryTerms, phrase, lexicalMode);
  const scored = filtered.map((chunk, index) => ({
    ...chunk,
    lexicalScore: lexicalScores[index] || 0,
    vectorScore: vectorScoreForChunk(chunk, {
      queryVector,
      embeddingModel,
      vectorItems,
      vectorSource,
      qdrantScores
    })
  }));

  const maxLexicalScore = Math.max(0, ...scored.map((chunk) => chunk.lexicalScore));
  return scored.map((chunk) => {
    const merged = mergeVectorLexicalScore({
      vectorScore: chunk.vectorScore,
      lexicalScore: chunk.lexicalScore,
      maxLexicalScore,
      hasQueryVector: Boolean(queryVector)
    });
    const rerankBoost = phraseRerankBoost(chunk.text, originalTerms);

    return {
      ...chunk,
      score: merged.scoreBase + rerankBoost,
      lexicalNormalized: merged.lexicalNormalized,
      vectorNormalized: merged.vectorNormalized,
      rerankBoost,
      searchMode: queryVector ? (vectorSource === "qdrant" ? "qdrant-hybrid" : "hybrid") : "keyword",
      vectorError
    };
  });
}

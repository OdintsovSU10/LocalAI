import { tokenize } from "./text.js";

const DEFAULT_OPTIONS = {
  k1: 1.2,
  b: 0.75,
  fieldBoosts: {
    text: 1,
    title: 2.2,
    path: 1.2,
    sourceTitle: 1.7
  }
};

function addTerms(termFreq, terms, boost = 1) {
  for (const term of terms || []) {
    if (!term) continue;
    termFreq.set(term, (termFreq.get(term) || 0) + boost);
  }
}

function chunkTextTerms(chunk) {
  return Array.isArray(chunk?.terms) && chunk.terms.length
    ? chunk.terms.map((term) => String(term || "").toLowerCase()).filter(Boolean)
    : tokenize(chunk?.text || "");
}

function metadataTerms(value) {
  return tokenize(value || "");
}

function buildDocument(chunk, options) {
  const boosts = options.fieldBoosts || DEFAULT_OPTIONS.fieldBoosts;
  const textTerms = chunkTextTerms(chunk);
  const titleTerms = metadataTerms(chunk?.title);
  const pathTerms = metadataTerms(chunk?.path);
  const sourceTitleTerms = metadataTerms(chunk?.sourceTitle);
  const termFreq = new Map();

  addTerms(termFreq, textTerms, boosts.text);
  addTerms(termFreq, titleTerms, boosts.title);
  addTerms(termFreq, pathTerms, boosts.path);
  addTerms(termFreq, sourceTitleTerms, boosts.sourceTitle);

  return {
    chunk,
    termFreq,
    length: Math.max(1, textTerms.length + titleTerms.length + pathTerms.length + sourceTitleTerms.length)
  };
}

export function buildBm25Index(chunks = [], options = {}) {
  const settings = {
    ...DEFAULT_OPTIONS,
    ...options,
    fieldBoosts: {
      ...DEFAULT_OPTIONS.fieldBoosts,
      ...(options.fieldBoosts || {})
    }
  };
  const documents = chunks.map((chunk) => buildDocument(chunk, settings));
  const documentFrequency = new Map();

  for (const document of documents) {
    for (const term of document.termFreq.keys()) {
      documentFrequency.set(term, (documentFrequency.get(term) || 0) + 1);
    }
  }

  const totalLength = documents.reduce((sum, document) => sum + document.length, 0);
  return {
    documents,
    documentFrequency,
    avgDocLength: documents.length ? totalLength / documents.length : 0,
    totalDocs: documents.length,
    k1: settings.k1,
    b: settings.b
  };
}

export function bm25Idf(index, term) {
  const totalDocs = index?.totalDocs || 0;
  if (!totalDocs) return 0;
  const documentFrequency = index.documentFrequency?.get(term) || 0;
  return Math.log(1 + ((totalDocs - documentFrequency + 0.5) / (documentFrequency + 0.5)));
}

function scoreDocument(index, document, queryTerms) {
  const avgDocLength = index.avgDocLength || 1;
  const lengthRatio = document.length / avgDocLength;
  const denominatorBase = index.k1 * (1 - index.b + (index.b * lengthRatio));
  let score = 0;

  for (const term of queryTerms) {
    const tf = document.termFreq.get(term) || 0;
    if (!tf) continue;
    const idf = bm25Idf(index, term);
    score += idf * ((tf * (index.k1 + 1)) / (tf + denominatorBase));
  }

  return score;
}

export function searchBm25(index, queryTerms = [], topK = 30) {
  const terms = Array.from(new Set((queryTerms || []).map((term) => String(term || "").toLowerCase()).filter(Boolean)));
  if (!index?.documents?.length || !terms.length) return [];

  return index.documents
    .map((document) => ({
      chunk: document.chunk,
      chunkId: document.chunk?.id,
      score: scoreDocument(index, document, terms)
    }))
    .filter((result) => result.score > 0)
    .sort((left, right) => right.score - left.score)
    .slice(0, Math.max(0, Number(topK || 0)));
}

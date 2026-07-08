import { tokenize } from "./text.js";
import { synonymGroups } from "./search-query.js";

export const HYBRID_VECTOR_WEIGHT = 0.82;
export const HYBRID_LEXICAL_WEIGHT = 0.18;

export function scoreChunk(chunk, queryTerms, phrase) {
  const text = chunk.text.toLowerCase();
  const termCounts = new Map();
  for (const term of chunk.terms || tokenize(chunk.text)) {
    termCounts.set(term, (termCounts.get(term) || 0) + 1);
  }

  let score = 0;
  for (const term of queryTerms) {
    const count = termCounts.get(term) || 0;
    if (count > 0) score += 2 + Math.log(1 + count);
  }

  if (phrase && text.includes(phrase)) score += 8;
  return score;
}

function hasAnyTerm(terms, group) {
  return terms.some((term) => group.includes(term));
}

export function phraseRerankBoost(text, originalTerms) {
  const hasCostIntent = hasAnyTerm(originalTerms, synonymGroups[0]);
  const hasContractIntent = hasAnyTerm(originalTerms, synonymGroups[1]);
  if (!hasCostIntent || !hasContractIntent) return 0;

  const lower = String(text || "").toLowerCase();
  let boost = 0;
  if (lower.includes("\u0446\u0435\u043d\u0430 \u0434\u043e\u0433\u043e\u0432\u043e\u0440\u0430")) boost += 0.08;
  if (lower.includes("\u0446\u0435\u043d\u0430 \u0440\u0430\u0431\u043e\u0442 \u043f\u043e \u0434\u043e\u0433\u043e\u0432\u043e\u0440\u0443") || lower.includes("\u0446\u0435\u043d\u0443 \u0440\u0430\u0431\u043e\u0442 \u043f\u043e \u0434\u043e\u0433\u043e\u0432\u043e\u0440\u0443")) boost += 0.04;
  if (lower.includes("\u0441\u043e\u0441\u0442\u0430\u0432\u043b\u044f\u0435\u0442") && /\d[\d\s\u00a0]{6,},\d{2}/.test(lower)) boost += 0.04;
  if (lower.includes("\u0441\u0442\u043e\u0438\u043c\u043e\u0441\u0442\u044c \u043f\u043e\u0434\u0433\u043e\u0442\u043e\u0432\u0438\u0442\u0435\u043b\u044c\u043d\u044b\u0445 \u0440\u0430\u0431\u043e\u0442")) boost -= 0.04;
  return boost;
}

export function clamp01(value) {
  return Math.max(0, Math.min(1, value));
}

export function normalizeLexicalScore(lexicalScore, maxLexicalScore) {
  return maxLexicalScore ? lexicalScore / maxLexicalScore : 0;
}

export function mergeVectorLexicalScore({
  vectorScore = 0,
  lexicalScore = 0,
  maxLexicalScore = 0,
  hasQueryVector = false,
  vectorWeight = HYBRID_VECTOR_WEIGHT,
  lexicalWeight = HYBRID_LEXICAL_WEIGHT
} = {}) {
  const lexicalNormalized = normalizeLexicalScore(lexicalScore, maxLexicalScore);
  const vectorNormalized = clamp01(vectorScore);
  const scoreBase = hasQueryVector
    ? (vectorNormalized * vectorWeight) + (lexicalNormalized * lexicalWeight)
    : lexicalNormalized;

  return {
    scoreBase,
    lexicalNormalized,
    vectorNormalized
  };
}

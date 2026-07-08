import { isTenderSource } from "./source-scope.js";

function normalize(value = "") {
  return String(value || "").trim().toLowerCase();
}

function tokenSet(value = "") {
  const parts = normalize(value).split(/[\s,./-]+/).filter((part) => part.length > 2);
  return new Set(parts);
}

function fuzzyScore(left = "", right = "") {
  const a = normalize(left);
  const b = normalize(right);
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (a.includes(b) || b.includes(a)) return 0.7;
  const at = tokenSet(a);
  const bt = tokenSet(b);
  if (!at.size || !bt.size) return 0;
  let inter = 0;
  for (const token of at) {
    if (bt.has(token)) inter += 1;
  }
  const union = at.size + bt.size - inter;
  return union ? inter / union : 0;
}

export function ragSourceFromLocalSource(source = {}) {
  return {
    id: String(source.id || ""),
    title: String(source.title || ""),
    tenderNumber: "",
    linkedContractId: String(source.linkedContractId || ""),
    objectAddress: "",
    hubTenderId: ""
  };
}

export function matchTenderToRagSource(tender = {}, sources = []) {
  const tenderSources = sources.filter((source) => isTenderSource(source));
  const tNum = normalize(tender.tenderNumber);
  const tTitle = normalize(tender.title);
  const tAddr = normalize(tender.objectAddress);

  for (const source of tenderSources) {
    if (source.hubTenderId && source.hubTenderId === tender.id) {
      return result(source, "exact", 1, "hubTenderId");
    }
  }
  for (const source of tenderSources) {
    if (tender.linkedContractId && source.linkedContractId === tender.linkedContractId) {
      return result(source, "high", 0.95, "linkedContractId");
    }
  }
  for (const source of tenderSources) {
    const title = normalize(source.title);
    if (tNum && (title === tNum || title.startsWith(`${tNum}.`) || title.startsWith(`${tNum} `))) {
      const score = tTitle && title.includes(tTitle) ? 0.92 : 0.85;
      return result(source, "high", score, "tenderNumber");
    }
  }

  let best = null;
  let bestScore = 0;
  for (const source of tenderSources) {
    let score = fuzzyScore(tTitle, source.title);
    if (tAddr) score = (score + fuzzyScore(tAddr, source.objectAddress || "")) / 2;
    if (score > bestScore) {
      best = source;
      bestScore = score;
    }
  }
  if (best && bestScore >= 0.55) {
    return result(best, bestScore >= 0.75 ? "high" : "medium", bestScore, "titleFuzzy");
  }

  return {
    ragSource: null,
    confidence: "none",
    score: 0,
    strategy: "unmatched",
    note: "RAG tender source not found by hubTenderId, contract link, number or fuzzy title"
  };
}

function result(source, confidence, score, strategy) {
  return {
    ragSource: source,
    confidence,
    score,
    strategy,
    note: ""
  };
}

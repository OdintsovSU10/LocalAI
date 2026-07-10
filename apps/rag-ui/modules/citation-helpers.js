export function compactSources(sources = []) {
  return sources.map((source) => ({
    id: source.id,
    chunkId: source.chunkId,
    fileId: source.fileId,
    sourceId: source.sourceId,
    sourceTitle: source.sourceTitle,
    title: source.title,
    fileLabel: source.fileLabel,
    path: source.path,
    pathLabel: source.pathLabel,
    citationLabel: source.citationLabel,
    citationTarget: source.citationTarget,
    documentType: source.documentType,
    pageStart: source.pageStart,
    pageEnd: source.pageEnd,
    totalPages: source.totalPages,
    sheetName: source.sheetName,
    rowStart: source.rowStart,
    rowEnd: source.rowEnd,
    sectionTitle: source.sectionTitle,
    metadata: source.metadata,
    score: source.score,
    sourceNumber: source.sourceNumber,
    citationNumbers: source.citationNumbers,
    citationEvidence: source.citationEvidence,
    citedRank: source.citedRank,
    references: source.references,
    snippet: source.snippet,
    text: source.text ? String(source.text).slice(0, 2600) : ""
  }));
}

export function fileName(filePath) {
  return String(filePath || "").split(/[\\/]/).filter(Boolean).pop() || "Файл";
}

export function citedSourceNumbers(answerText) {
  return Array.from(String(answerText || "").matchAll(/\[(\d+)\]/g), (match) => Number(match[1]))
    .filter((number) => Number.isInteger(number) && number > 0);
}

function lineBoundsForOffset(text, offset) {
  const start = text.lastIndexOf("\n", offset - 1) + 1;
  const nextBreak = text.indexOf("\n", offset);
  const end = nextBreak >= 0 ? nextBreak : text.length;
  return { start, end };
}

function cleanCitationEvidence(value) {
  const text = String(value || "")
    .replace(/\[(\d+)\]/g, " ")
    .replace(/^[\s\-–—*•\d.)]+/u, "")
    .replace(/\s+/g, " ")
    .trim();

  if (!text || /^источники\s*:/iu.test(text)) return "";
  return text.length > 700 ? `${text.slice(0, 700).trim()}...` : text;
}

export function citationEvidenceForNumber(answerText, sourceNumber) {
  const text = String(answerText || "");
  const target = Number(sourceNumber);
  if (!Number.isInteger(target) || target <= 0) return "";

  const citationPattern = /\[(\d+)\]/g;
  let match;
  while ((match = citationPattern.exec(text))) {
    if (Number(match[1]) !== target) continue;

    const { start, end } = lineBoundsForOffset(text, match.index);
    const lineEvidence = cleanCitationEvidence(text.slice(start, end));
    if (lineEvidence) return lineEvidence;

    const sentenceStart = Math.max(
      text.lastIndexOf(".", match.index - 1),
      text.lastIndexOf("!", match.index - 1),
      text.lastIndexOf("?", match.index - 1)
    ) + 1;
    const sentenceEndCandidates = [".", "!", "?"]
      .map((mark) => text.indexOf(mark, match.index + match[0].length))
      .filter((index) => index >= 0);
    const sentenceEnd = sentenceEndCandidates.length ? Math.min(...sentenceEndCandidates) + 1 : text.length;
    const sentenceEvidence = cleanCitationEvidence(text.slice(sentenceStart, sentenceEnd));
    if (sentenceEvidence) return sentenceEvidence;
  }

  return "";
}

export function uniqueSources(sources = []) {
  const byPath = new Map();
  for (const source of sources) {
    if (!source.path) continue;
    const stableId = source.chunkId || source.id || source.citationTarget?.chunkId || source.citationLabel || "";
    const key = `${source.sourceId || ""}:${source.path}:${stableId}`;
    const existing = byPath.get(key);
    const citationNumbers = Number.isInteger(source.sourceNumber) ? [source.sourceNumber] : [];
    if (!existing) {
      byPath.set(key, { ...source, references: 1, citationNumbers });
      continue;
    }

    const references = existing.references + 1;
    for (const sourceNumber of citationNumbers) {
      if (!existing.citationNumbers.includes(sourceNumber)) existing.citationNumbers.push(sourceNumber);
    }
    const sourceCited = Number.isInteger(source.citedRank);
    const existingCited = Number.isInteger(existing.citedRank);
    if ((sourceCited && !existingCited) || (sourceCited === existingCited && Number(source.score || 0) > Number(existing.score || 0))) {
      byPath.set(key, { ...source, references, citationNumbers: existing.citationNumbers });
    } else {
      existing.references = references;
    }
  }

  return Array.from(byPath.values()).sort((a, b) => {
    const aRank = Number.isInteger(a.citedRank) ? a.citedRank : 999;
    const bRank = Number.isInteger(b.citedRank) ? b.citedRank : 999;
    if (aRank !== bRank) return aRank - bRank;
    return Number(b.score || 0) - Number(a.score || 0);
  });
}

function sourceCitationNumbers(source = {}) {
  if (Array.isArray(source.citationNumbers) && source.citationNumbers.length) {
    return source.citationNumbers.map(Number).filter((number) => Number.isInteger(number) && number > 0);
  }
  const sourceNumber = Number(source.sourceNumber || 0);
  return Number.isInteger(sourceNumber) && sourceNumber > 0 ? [sourceNumber] : [];
}

export function displayedSourcesForAnswer(sources = [], answerText = "", options = {}) {
  const maxUncited = Math.max(1, Number(options.maxUncited || 8));
  const cited = citedSourceNumbers(answerText);
  if (!cited.length) return sources.slice(0, maxUncited);

  const citedSet = new Set(cited);
  return sources.filter((source) => sourceCitationNumbers(source).some((number) => citedSet.has(number)));
}

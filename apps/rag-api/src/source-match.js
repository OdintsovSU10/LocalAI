import path from "node:path";

const projectMatchStopWords = new Set([
  "где", "как", "какие", "какая", "какой", "какое", "что", "кто", "чем", "почему",
  "проект", "проекта", "проекту", "папка", "папке", "договор", "договора", "договору",
  "условия", "условие", "срок", "сроки", "сумма", "цена", "размер", "основные",
  "найди", "найти", "покажи", "скажи", "ответь", "прописано", "указано",
  "по", "на", "в", "во", "и", "или", "а", "к", "ко", "о", "об", "от", "для", "из", "с", "со",
  "жк", "жилой", "комплекс", "ооо", "зао", "пао", "ао"
]);

const projectMatchExtraStopWords = new Set([
  "договоре", "договоры", "договоров", "договорам", "договорами",
  "гарантийного", "гарантийный", "удержания", "удержание", "предусмотрен", "предусмотрено"
]);

function normalizeMatchText(value) {
  return String(value || "")
    .toLowerCase()
    .replaceAll("ё", "е")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const cyrillicToLatin = {
  а: "a",
  б: "b",
  в: "v",
  г: "g",
  д: "d",
  е: "e",
  ж: "zh",
  з: "z",
  и: "i",
  й: "y",
  к: "k",
  л: "l",
  м: "m",
  н: "n",
  о: "o",
  п: "p",
  р: "r",
  с: "s",
  т: "t",
  у: "u",
  ф: "f",
  х: "kh",
  ц: "ts",
  ч: "ch",
  ш: "sh",
  щ: "sch",
  ы: "y",
  э: "e",
  ю: "yu",
  я: "ya"
};

function transliterateCyrillicToken(token) {
  const value = String(token || "");
  if (!/[а-я]/u.test(value)) return "";
  return Array.from(value, (char) => cyrillicToLatin[char] ?? char).join("");
}

function relaxedLatinTokenVariants(token) {
  const latin = transliterateCyrillicToken(token);
  if (!latin) return [];

  const relaxed = new Set([latin]);
  relaxed.add(latin.replace(/iya/g, "ia"));
  relaxed.add(latin.replace(/iy/g, "i"));
  relaxed.add(latin.replace(/iu/g, "u"));
  relaxed.add(latin.replace(/yi/g, "i"));
  return Array.from(relaxed).filter((value) => value.length >= 2);
}

function matchTokens(value) {
  return normalizeMatchText(value)
    .split(" ")
    .map((token) => token.trim())
    .filter((token) => token.length >= 2 && !projectMatchStopWords.has(token) && !projectMatchExtraStopWords.has(token));
}

function uniqueTokens(value) {
  return Array.from(new Set(matchTokens(value)));
}

function tokenVariants(token) {
  const value = String(token || "").trim();
  const variants = new Set([value]);
  for (const relaxed of relaxedLatinTokenVariants(value)) variants.add(relaxed);
  const endings = [
    "иями", "ями", "ами", "ого", "его", "ому", "ему", "ыми", "ими",
    "ая", "яя", "ое", "ее", "ые", "ие", "ый", "ий", "ой", "ей",
    "ов", "ев", "ах", "ях", "ам", "ям", "ом", "ем", "ам", "ям",
    "а", "я", "у", "ю", "ы", "и", "е", "о"
  ];

  for (const ending of endings) {
    if (value.length - ending.length >= 4 && value.endsWith(ending)) {
      const withoutEnding = value.slice(0, -ending.length);
      variants.add(withoutEnding);
      for (const relaxed of relaxedLatinTokenVariants(withoutEnding)) variants.add(relaxed);
    }
  }

  return variants;
}

function expandedTokenSet(tokens) {
  const values = new Set();
  for (const token of tokens) {
    for (const variant of tokenVariants(token)) values.add(variant);
  }
  return values;
}

function hasAnyTokenVariant(token, tokenSet) {
  for (const variant of tokenVariants(token)) {
    if (tokenSet.has(variant)) return true;
  }
  return false;
}

function sourceMatchProfile(source) {
  const title = `${source.title || ""} ${path.basename(source.path || "")}`;
  const full = `${title} ${source.path || ""}`;
  const titleTokens = matchTokens(title);
  const fullTokens = matchTokens(full);
  return {
    titleText: normalizeMatchText(title),
    fullText: normalizeMatchText(full),
    titleTokens: new Set(titleTokens),
    fullTokens: new Set(fullTokens),
    titleTokenVariants: expandedTokenSet(titleTokens),
    fullTokenVariants: expandedTokenSet(fullTokens)
  };
}

function scoreSourceMatch(questionTokens, source) {
  const profile = sourceMatchProfile(source);
  let score = 0;
  const matchedTokens = [];

  for (const token of questionTokens) {
    let tokenScore = 0;
    if (profile.titleTokens.has(token)) tokenScore += 5;
    else if (hasAnyTokenVariant(token, profile.titleTokenVariants)) tokenScore += 4.5;
    else if (token.length >= 4 && profile.titleText.includes(token)) tokenScore += 3;

    if (profile.fullTokens.has(token)) tokenScore += 1.5;
    else if (hasAnyTokenVariant(token, profile.fullTokenVariants)) tokenScore += 1.25;
    else if (token.length >= 4 && profile.fullText.includes(token)) tokenScore += 0.75;

    if (tokenScore > 0) {
      score += tokenScore;
      matchedTokens.push(token);
    }
  }

  return { source, score, matchedTokens };
}

export function matchSourceForQuestion(question, sources = []) {
  const indexedSources = sources.filter((source) => source?.id && source?.path);
  if (indexedSources.length === 1) {
    return {
      source: indexedSources[0],
      score: 100,
      matchedTokens: [],
      confident: true,
      candidates: []
    };
  }

  const questionTokens = uniqueTokens(question);
  if (!questionTokens.length) {
    return { source: null, score: 0, matchedTokens: [], confident: false, candidates: [] };
  }

  const candidates = indexedSources
    .map((source) => scoreSourceMatch(questionTokens, source))
    .filter((candidate) => candidate.score > 0)
    .sort((a, b) => b.score - a.score || b.matchedTokens.length - a.matchedTokens.length);

  const best = candidates[0];
  if (!best) return { source: null, score: 0, matchedTokens: [], confident: false, candidates: [] };

  const runnerUp = candidates[1];
  const confident = best.score >= 5
    && best.matchedTokens.length >= 1
    && (!runnerUp || best.score >= runnerUp.score + 1.5 || best.matchedTokens.length > runnerUp.matchedTokens.length);

  return {
    source: confident ? best.source : null,
    score: best.score,
    matchedTokens: best.matchedTokens,
    confident,
    candidates: candidates.slice(0, 5).map((candidate) => ({
      id: candidate.source.id,
      title: candidate.source.title,
      score: Number(candidate.score.toFixed(2)),
      matchedTokens: candidate.matchedTokens
    }))
  };
}

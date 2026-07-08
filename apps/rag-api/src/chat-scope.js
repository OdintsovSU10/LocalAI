import { matchSourceForQuestion } from "./source-match.js";
import { contractSources, resolveSearchSourceIds } from "./source-scope.js";

const allSourcesIntentPatterns = [
  /\b(?:all|every)\s+(?:projects?|sources?|folders?)\b/i,
  /\bacross\s+(?:all\s+)?(?:projects?|sources?|folders?)\b/i,
  /(?:^|\s)(?:\u0432\u0441\u0435|\u0432\u0441\u0435\u0445|\u0432\u0441\u0435\u043c|\u0432\u0441\u0435\u043c\u0438)\s+(?:\u043f\u0440\u043e\u0435\u043a\u0442\p{L}*|\u0438\u0441\u0442\u043e\u0447\u043d\u0438\u043a\p{L}*|\u043f\u0430\u043f\u043a\p{L}*)(?:\s|$)/u,
  /(?:^|\s)\u043a\u0430\u0436\u0434\p{L}*\s+(?:\u043f\u0440\u043e\u0435\u043a\u0442\p{L}*|\u0438\u0441\u0442\u043e\u0447\u043d\u0438\u043a\p{L}*|\u043f\u0430\u043f\u043a\p{L}*)(?:\s|$)/u
];

export function hasAllSourcesIntent(question = "") {
  const text = String(question || "")
    .toLowerCase()
    .replaceAll("\u0451", "\u0435")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  return allSourcesIntentPatterns.some((pattern) => pattern.test(text));
}

export function resolveChatSourceScope({ question = "", requestedSourceId = "", sources = [] } = {}) {
  const contracts = contractSources(sources);
  const requested = String(requestedSourceId || "").trim();
  const allSourcesRequested = hasAllSourcesIntent(question);
  let source = requested && !allSourcesRequested ? (contracts.find((item) => item.id === requested) || null) : null;
  let autoMatch = null;

  if (!source && !requested && !allSourcesRequested) {
    autoMatch = matchSourceForQuestion(question, contracts);
    source = autoMatch.source;
  }

  const searchAllSources = allSourcesRequested || (!source && !requested);
  const searchSourceIds = resolveSearchSourceIds({ source, searchAllSources, sources });

  return {
    source,
    sourceId: source?.id || "",
    searchSourceIds,
    autoMatch,
    searchAllSources,
    requestedSourceMissing: Boolean(requested && !source && !allSourcesRequested)
  };
}

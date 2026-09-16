import { chatLlmCandidates, llmRouteMetadata } from "../llm-routing.js";

export function emptyRouteMetadata(settings = null) {
  return llmRouteMetadata(chatLlmCandidates(settings || {})[0]);
}

export function ragDebugMetadata({
  routeMetadata = {},
  searchMetadata = {},
  matchedSource = null,
  finalSourceCount = 0,
  promptChars = 0,
  answer = "",
  llmMs = 0,
  totalMs = 0
} = {}) {
  const searchTimings = searchMetadata.timings || {};
  return {
    ...routeMetadata,
    ...searchMetadata,
    matchedSource,
    finalSourceCount: Number(finalSourceCount || 0),
    promptChars: Number(promptChars || 0),
    answerChars: String(answer || "").length,
    timings: {
      retrievalMs: Number(searchTimings.retrievalMs || 0),
      rerankMs: Number(searchTimings.rerankMs || 0),
      llmMs: Number(llmMs || 0),
      totalMs: Number(totalMs || 0)
    }
  };
}

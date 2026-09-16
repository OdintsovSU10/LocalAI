import { expandedChatRetrievalQuery, hasBroadAnswerIntent } from "../chat-intent.js";
import { resolveChatSourceScope } from "../chat-scope.js";
import { indexedSnapshotForSource, indexSourceIdsForSources } from "../index-status.js";
import { chatLlmCandidates, llmRouteMetadata, providerLabel } from "../llm-routing.js";
import { chatSearchLimit, runChatLlm } from "./chat-llm.js";
import {
  LLM_DISABLED_ANSWER,
  NO_RESULTS_ANSWER,
  llmErrorAnswer,
  missingSourceAnswer,
  noIndexAnswer,
  withFallbackSources
} from "./fallback-answers.js";
import { emptyRouteMetadata, ragDebugMetadata } from "./rag-metadata.js";

/**
 * Events passed to onEvent (web SSE and future channels map them to their own protocol):
 *   { type: "status", phase: "retrieval" | "llm", payload: { status, ... } }
 *   { type: "token", text }
 *
 * @typedef {object} AnswerResult
 * @property {object} payload        response body of /api/chat (answer, sources, matchedSource, metadata, ...)
 * @property {boolean} answerStreamed true when the answer text already went out as token events
 */

/**
 * Single chat answer pipeline for /api/chat and /api/chat/stream.
 * Server state that is not a pure function of storage (in-memory jobs, the matched-source view,
 * LLM usage tracking) comes in through deps.
 *
 * @returns {Promise<AnswerResult>}
 */
export async function answerQuestion({
  question = "",
  requestedSourceId = "",
  contextSourceId = "",
  stream = false,
  signal,
  onEvent = () => {}
} = {}, deps) {
  const now = deps.now || Date.now;
  const totalStartedAt = now();
  const emitStatus = (phase, payload) => onEvent({ type: "status", phase, payload });
  const canned = (payload) => ({ payload, answerStreamed: false });

  emitStatus("retrieval", { status: "retrieval_started" });

  const sources = await deps.readSources();
  const settings = await deps.readSettings();
  const chatScope = resolveChatSourceScope({ question, requestedSourceId, contextSourceId, sources });
  const { source, sourceId, searchSourceIds, autoMatch, searchAllSources } = chatScope;
  const broadAnswer = hasBroadAnswerIntent(question);
  const retrievalQuery = expandedChatRetrievalQuery(question);

  if (chatScope.requestedSourceMissing) {
    const candidates = autoMatch?.candidates || [];
    const answer = missingSourceAnswer(candidates);
    emitStatus("retrieval", { status: "retrieval_done", matched: false });
    return canned({
      answer,
      sources: [],
      matchedSource: null,
      projectCandidates: candidates,
      metadata: ragDebugMetadata({
        routeMetadata: emptyRouteMetadata(settings),
        answer,
        totalMs: now() - totalStartedAt
      })
    });
  }

  const matchedSource = source ? deps.publicMatchedSource(source, {
    autoSelected: !requestedSourceId || chatScope.contextSourceUsed,
    score: autoMatch?.score || 0
  }) : null;
  const searchLimit = chatSearchLimit({ searchAllSources, broadAnswer });
  let effectiveSearchSourceIds = searchAllSources ? null : searchSourceIds;
  if (!searchAllSources && searchSourceIds.length) {
    const manifest = await deps.readManifest();
    const scopedSources = sources.filter((item) => searchSourceIds.includes(item.id));
    effectiveSearchSourceIds = indexSourceIdsForSources(scopedSources, manifest);
  }
  const searchResult = await deps.searchChunksWithMetadata({
    query: retrievalQuery,
    sourceId,
    sourceIds: effectiveSearchSourceIds,
    limit: searchLimit
  });
  const results = searchResult.results;
  const searchMetadata = searchResult.metadata;
  const llmCandidates = chatLlmCandidates(settings);
  const llm = llmCandidates[0];
  const initialMetadata = (answer = "", overrides = {}) => ragDebugMetadata({
    routeMetadata: llmRouteMetadata(llm),
    searchMetadata,
    matchedSource,
    finalSourceCount: results.length,
    answer,
    totalMs: now() - totalStartedAt,
    ...overrides
  });

  emitStatus("retrieval", {
    status: "retrieval_done",
    matched: Boolean(source),
    sourceId,
    searchAllSources,
    resultCount: results.length,
    metadata: searchMetadata
  });

  if (!results.length) {
    if (searchAllSources) {
      const manifest = await deps.readManifest();
      const answer = deps.allSourcesNoResultsAnswer(manifest);
      return canned({ answer, matchedSource, sources: [], metadata: initialMetadata(answer) });
    }

    const [manifest, persistedJobs] = await Promise.all([deps.readManifest(), deps.readJobs()]);
    const currentSourceIds = new Set(sources.map((item) => item?.id).filter(Boolean));
    const indexedChunks = indexedSnapshotForSource(source, manifest, { currentSourceIds }).chunks;
    const latestJob = deps.latestJobForSource(sourceId, persistedJobs);
    if (!indexedChunks) {
      const answer = noIndexAnswer(source.title, deps.publicJobStatus(latestJob));
      return canned({ answer, matchedSource, sources: [], metadata: initialMetadata(answer) });
    }

    const answer = NO_RESULTS_ANSWER;
    return canned({ answer, matchedSource, sources: [], metadata: initialMetadata(answer) });
  }

  if (!llm.enabled) {
    const answer = LLM_DISABLED_ANSWER;
    return canned({ answer, matchedSource, sources: results, metadata: initialMetadata(answer) });
  }

  emitStatus("llm", {
    status: "llm_started",
    provider: llm.provider,
    providerLabel: providerLabel(llm.provider),
    model: llm.model || ""
  });

  let streamedAnswer = "";
  const {
    reply,
    usedLlm,
    lastLlmError,
    promptChars,
    llmMs
  } = await runChatLlm({
    llmCandidates,
    results,
    question,
    sourceId,
    broadAnswer,
    signal,
    stream,
    onToken: (token) => {
      streamedAnswer += token;
      onEvent({ type: "token", text: token });
    },
    usageTracker: deps.usageTracker,
    ...(deps.chatCompletion ? { chatCompletion: deps.chatCompletion } : {}),
    ...(deps.chatCompletionStream ? { chatCompletionStream: deps.chatCompletionStream } : {})
  });

  if (!reply) {
    const failedLlm = llmCandidates[0] || llm;
    const answer = llmErrorAnswer(lastLlmError || new Error("LLM response is empty"), results, question);
    return {
      payload: {
        answer,
        model: failedLlm?.model || "",
        provider: failedLlm?.provider,
        providerLabel: providerLabel(failedLlm?.provider),
        selectedBy: failedLlm?.selectedBy,
        fallbackReason: "llm_failed",
        matchedSource,
        sources: results,
        metadata: ragDebugMetadata({
          routeMetadata: llmRouteMetadata(failedLlm),
          searchMetadata,
          matchedSource,
          finalSourceCount: results.length,
          promptChars,
          answer,
          llmMs,
          totalMs: now() - totalStartedAt
        })
      },
      answerStreamed: Boolean(streamedAnswer)
    };
  }

  const answer = withFallbackSources(reply.text, results.length);
  if (stream) {
    // The model streamed its text; withFallbackSources may have appended a sources line that still has to go out.
    const suffix = answer.startsWith(streamedAnswer) ? answer.slice(streamedAnswer.length) : "";
    if (suffix) onEvent({ type: "token", text: suffix });
  }

  return {
    payload: {
      answer,
      model: reply.model,
      provider: usedLlm?.provider,
      providerLabel: providerLabel(usedLlm?.provider),
      selectedBy: usedLlm?.selectedBy,
      fallbackReason: usedLlm?.autoFallbackReason || "",
      matchedSource,
      sources: results,
      metadata: ragDebugMetadata({
        routeMetadata: llmRouteMetadata(usedLlm, { fallbackUsed: usedLlm?.fallbackUsed }),
        searchMetadata,
        matchedSource,
        finalSourceCount: results.length,
        promptChars,
        answer,
        llmMs,
        totalMs: now() - totalStartedAt
      })
    },
    answerStreamed: stream
  };
}

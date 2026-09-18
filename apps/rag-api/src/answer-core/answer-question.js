import { expandedChatRetrievalQuery, hasBroadAnswerIntent } from "../chat-intent.js";
import { resolveChatSourceScope } from "../chat-scope.js";
import { indexedSnapshotForSource, indexSourceIdsForSources } from "../index-status.js";
import { chatLlmCandidates, llmRouteMetadata, providerLabel } from "../llm-routing.js";
import { chatSearchLimit, runChatLlm } from "./chat-llm.js";
import { followUpRetrievalQuery, historyMessages } from "./conversation-turns.js";
import { buildEvidencePacket } from "./evidence-packet.js";
import { planQuery as defaultPlanQuery } from "./query-planner.js";
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
 * @property {object} plan            query plan used for the turn (kept out of the payload; stored with the turn)
 */

/**
 * Retrieval 2.0: turns the ranked chunks into an evidence packet (exact spans, fact hits, version
 * awareness). Any problem with evidence (disabled, store unavailable, not built for these chunks)
 * keeps the legacy chunk results, so chat never depends on the evidence database.
 */
async function applyEvidencePacket({ settings, plan, question, results, sourceIds, sources, limit, deps }) {
  if (settings?.search?.retrievalV2 === false) return { results, diagnostics: { enabled: false, used: false, reason: "disabled" } };
  if (!deps.getEvidenceProvider) return { results, diagnostics: { enabled: true, used: false, reason: "no_provider" } };
  if (plan?.fallback) return { results, diagnostics: { enabled: true, used: false, reason: "plan_fallback" } };
  try {
    const provider = await deps.getEvidenceProvider();
    const packet = buildEvidencePacket({ plan, question, chunkResults: results, sourceIds, provider, limit, sources });
    if (!packet.results.some((result) => result.evidenceId)) {
      return { results, diagnostics: { enabled: true, used: false, reason: "no_evidence" } };
    }
    return { results: packet.results, diagnostics: { enabled: true, used: true, reason: "", ...packet.diagnostics } };
  } catch (error) {
    return { results, diagnostics: { enabled: true, used: false, reason: "error", error: String(error?.message || error).slice(0, 200) } };
  }
}

/**
 * Single chat answer pipeline for /api/chat and /api/chat/stream.
 * Server state that is not a pure function of storage (in-memory jobs, the matched-source view,
 * LLM usage tracking) comes in through deps.
 *
 * conversationContext ({ pinnedSourceId, turns }) is optional: without it the request behaves exactly
 * like a single-turn /api/chat call. The pinned project only applies when the question names none.
 *
 * The query planner runs before retrieval. When several projects match the question equally well it
 * returns a clarification instead of an answer; a later reply that picks an option resumes the original
 * question. If planning throws, the legacy scope resolution answers as before (deterministic fallback).
 *
 * @returns {Promise<AnswerResult>}
 */
export async function answerQuestion({
  question: rawQuestion = "",
  requestedSourceId: rawRequestedSourceId = "",
  contextSourceId = "",
  conversationContext = null,
  stream = false,
  signal,
  onEvent = () => {}
} = {}, deps) {
  const now = deps.now || Date.now;
  const totalStartedAt = now();
  const emitStatus = (phase, payload) => onEvent({ type: "status", phase, payload });
  let plan = null;
  const canned = (payload) => ({ payload, answerStreamed: false, plan });

  emitStatus("retrieval", { status: "retrieval_started" });

  const sources = await deps.readSources();
  const settings = await deps.readSettings();
  const turns = Array.isArray(conversationContext?.turns) ? conversationContext.turns : [];
  const effectiveContextSourceId = contextSourceId || conversationContext?.pinnedSourceId || "";
  try {
    plan = (deps.planQuery || defaultPlanQuery)({
      question: rawQuestion,
      requestedSourceId: rawRequestedSourceId,
      contextSourceId: effectiveContextSourceId,
      conversationContext,
      sources
    });
  } catch (error) {
    plan = { question: rawQuestion, requestedSourceId: rawRequestedSourceId, needsClarification: false, fallback: true, fallbackReason: error.message };
  }

  if (plan.needsClarification) {
    const { clarification } = plan;
    const answer = clarification.question;
    emitStatus("retrieval", { status: "retrieval_done", matched: false });
    return canned({
      answer,
      sources: [],
      matchedSource: null,
      projectCandidates: clarification.options.map((option) => ({ id: option.sourceId, title: option.title })),
      clarification,
      metadata: ragDebugMetadata({
        routeMetadata: emptyRouteMetadata(settings),
        answer,
        totalMs: now() - totalStartedAt
      })
    });
  }

  // After a clarification reply the original question is answered for the chosen project.
  const question = plan.question;
  const requestedSourceId = plan.requestedSourceId;
  const chatScope = resolveChatSourceScope({ question, requestedSourceId, contextSourceId: effectiveContextSourceId, sources });
  const { source, sourceId, searchSourceIds, autoMatch, searchAllSources } = chatScope;
  const broadAnswer = hasBroadAnswerIntent(question);
  const retrievalQuery = followUpRetrievalQuery(expandedChatRetrievalQuery(question), question, turns);

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
  const retrievalV2 = settings?.search?.retrievalV2 !== false;
  const packet = searchResult.results.length
    ? await applyEvidencePacket({
      settings,
      plan,
      question,
      results: searchResult.results,
      sourceIds: effectiveSearchSourceIds,
      sources,
      limit: searchLimit,
      deps
    })
    : { results: searchResult.results, diagnostics: { enabled: retrievalV2, used: false, reason: "no_results" } };
  const results = packet.results;
  // With Retrieval 2.0 switched off the metadata stays exactly as before Stage 06.
  const searchMetadata = retrievalV2 ? { ...searchResult.metadata, evidencePacket: packet.diagnostics } : searchResult.metadata;
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
    history: historyMessages(turns),
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
      answerStreamed: Boolean(streamedAnswer),
      plan
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
    answerStreamed: stream,
    plan
  };
}

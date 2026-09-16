import crypto from "node:crypto";

import { chatCompletion as defaultChatCompletion, chatCompletionStream as defaultChatCompletionStream } from "../llm.js";
import { chatLlmCandidates, providerLabel } from "../llm-routing.js";
import { buildChatMessages, buildChatTitleMessages, buildRagContext, fallbackChatTitle, sanitizeChatTitle } from "./chat-prompt.js";

export function isContextSizeError(error) {
  return /context size|context length|n_ctx|n_keep/i.test(String(error?.message || error || ""));
}

const chatContextProfiles = [
  { name: "compact", maxSources: 8, maxCharsPerSource: 1400 },
  { name: "tight", maxSources: 6, maxCharsPerSource: 900 }
];

const broadChatContextProfiles = [
  { name: "broad", maxSources: 14, maxCharsPerSource: 1200 },
  { name: "broad-tight", maxSources: 10, maxCharsPerSource: 900 }
];

const allSourcesChatContextProfiles = [
  { name: "all-sources-compact", maxSources: 16, maxCharsPerSource: 900 },
  { name: "all-sources-tight", maxSources: 12, maxCharsPerSource: 700 }
];

const allSourcesBroadChatContextProfiles = [
  { name: "all-sources-broad", maxSources: 20, maxCharsPerSource: 900 },
  { name: "all-sources-broad-tight", maxSources: 14, maxCharsPerSource: 700 }
];

export function chatContextProfilesForRequest({ sourceId = "", broadAnswer = false } = {}) {
  if (sourceId) return broadAnswer ? broadChatContextProfiles : chatContextProfiles;
  return broadAnswer ? allSourcesBroadChatContextProfiles : allSourcesChatContextProfiles;
}

export function chatSearchLimit({ searchAllSources = false, broadAnswer = false } = {}) {
  if (searchAllSources) return broadAnswer ? 36 : 24;
  return broadAnswer ? 20 : 12;
}

// Tries each routed LLM candidate; within a candidate, shrinks the RAG context profile on context-size errors.
export async function runChatLlm({
  llmCandidates,
  results,
  question,
  sourceId,
  broadAnswer = false,
  signal,
  stream = false,
  onToken = () => {},
  usageTracker,
  chatCompletion = defaultChatCompletion,
  chatCompletionStream = defaultChatCompletionStream
}) {
  let reply;
  let usedLlm = null;
  let lastLlmError = null;
  let promptChars = 0;
  const llmStartedAt = Date.now();
  const contextProfiles = chatContextProfilesForRequest({ sourceId, broadAnswer });

  for (let candidateIndex = 0; candidateIndex < llmCandidates.length; candidateIndex += 1) {
    const candidateLlm = llmCandidates[candidateIndex];
    if (candidateLlm.missingRemoteContext) {
      lastLlmError = new Error("Удаленный контекст выключен. Включите remote context в настройках LLM, чтобы отправлять RAG-контекст в удаленную LM Studio.");
      if (!candidateLlm.allowAutoFallback) break;
      continue;
    }

    if (candidateLlm.missingBaseUrl || candidateLlm.missingApiKey) {
      lastLlmError = new Error(`${providerLabel(candidateLlm.provider)} не настроен. Проверьте URL и токен в настройках LLM.`);
      if (!candidateLlm.allowAutoFallback) break;
      continue;
    }

    const llmRequestId = crypto.randomUUID();
    usageTracker.update(llmRequestId, {
      phase: "generating",
      model: candidateLlm.model,
      provider: candidateLlm.provider,
      selectedBy: candidateLlm.selectedBy || "",
      autoFallbackReason: candidateLlm.autoFallbackReason || "",
      timeoutSeconds: candidateLlm.timeoutSeconds,
      sourceId,
      sourcesCount: results.length,
      promptChars: 0
    });

    try {
      for (let attempt = 0; attempt < contextProfiles.length; attempt += 1) {
        const contextProfile = contextProfiles[attempt];
        const context = buildRagContext(results, contextProfile);
        usageTracker.update(llmRequestId, {
          phase: attempt > 0 ? "compacting_context" : "generating",
          promptChars: context.length,
          contextProfile: contextProfile.name
        });
        promptChars = context.length;

        try {
          const completionArgs = {
            llm: candidateLlm,
            signal,
            onProgress: (progress) => usageTracker.update(llmRequestId, progress),
            messages: buildChatMessages(question, context, { broadAnswer })
          };
          reply = stream
            ? await chatCompletionStream({ ...completionArgs, onToken })
            : await chatCompletion(completionArgs);
          break;
        } catch (error) {
          lastLlmError = error;
          if (!isContextSizeError(error) || attempt === contextProfiles.length - 1) throw error;
        }
      }

      if (!reply) throw lastLlmError || new Error("LLM response is empty");
      usedLlm = { ...candidateLlm, fallbackUsed: candidateIndex > 0 };
      usageTracker.recordGeneration(candidateLlm, reply, {
        selectedBy: candidateLlm.selectedBy || "",
        autoFallbackReason: candidateLlm.autoFallbackReason || "",
        sourceId,
        sourcesCount: results.length,
        promptChars: usageTracker.request(llmRequestId)?.promptChars || 0
      });
      usageTracker.finish(llmRequestId, "completed");
      break;
    } catch (error) {
      usageTracker.finish(llmRequestId, signal?.aborted ? "cancelled" : "failed", error.message);
      lastLlmError = error;
      if (signal?.aborted) throw error;
      if (!candidateLlm.allowAutoFallback) break;
    }
  }

  return {
    reply,
    usedLlm,
    lastLlmError,
    promptChars,
    llmMs: Date.now() - llmStartedAt
  };
}

export async function generateChatTitle({
  settings = {},
  question = "",
  answer = "",
  sourceTitle = "",
  signal,
  chatCompletion = defaultChatCompletion
} = {}) {
  const fallbackTitle = fallbackChatTitle(question);
  const candidates = chatLlmCandidates(settings).filter((llm) => llm.enabled !== false);
  if (!candidates.length) return { title: fallbackTitle, fallbackUsed: true };

  let lastError = null;
  for (const candidate of candidates) {
    if (candidate.missingRemoteContext || candidate.missingBaseUrl || candidate.missingApiKey) {
      lastError = new Error("LLM route is not configured for title generation");
      if (!candidate.allowAutoFallback) break;
      continue;
    }

    try {
      const reply = await chatCompletion({
        llm: candidate,
        signal,
        messages: buildChatTitleMessages({ question, answer, sourceTitle })
      });
      const title = sanitizeChatTitle(reply.text);
      if (title) {
        return {
          title,
          model: reply.model,
          provider: candidate.provider,
          fallbackUsed: false
        };
      }
    } catch (error) {
      lastError = error;
      if (signal?.aborted) throw error;
      if (!candidate.allowAutoFallback) break;
    }
  }

  return { title: fallbackTitle, fallbackUsed: true, error: lastError?.message || "" };
}

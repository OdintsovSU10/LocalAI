import { normalizeLlmProvider, providerLabel } from "../llm-routing.js";

function generationStatsFromReply(reply = {}) {
  const stats = reply.stats || {};
  const usage = reply.usage || {};
  return {
    endpoint: reply.endpoint || "",
    tokensPerSecond: Number(stats.tokens_per_second ?? stats.tokensPerSecond ?? 0) || null,
    timeToFirstToken: Number(stats.time_to_first_token ?? stats.timeToFirstToken ?? 0) || null,
    generationTime: Number(stats.generation_time ?? stats.generationTime ?? 0) || null,
    stopReason: stats.stop_reason || stats.stopReason || "",
    promptTokens: Number(usage.prompt_tokens ?? usage.promptTokens ?? 0) || null,
    completionTokens: Number(usage.completion_tokens ?? usage.completionTokens ?? 0) || null,
    totalTokens: Number(usage.total_tokens ?? usage.totalTokens ?? 0) || null,
    modelInfo: reply.modelInfo || null,
    runtime: reply.runtime || null
  };
}

// In-process state behind /api/llm/usage and /api/llm/diagnostics: requests in flight,
// the last finished request and the last generation stats per provider.
export function createLlmUsageTracker() {
  const requests = new Map();
  const lastGenerations = new Map();
  let lastActivity = null;

  return {
    update(id, patch) {
      const now = new Date().toISOString();
      const existing = requests.get(id) || { id, startedAt: now };
      requests.set(id, { ...existing, ...patch, updatedAt: now });
    },
    finish(id, status = "completed", error = "") {
      const request = requests.get(id);
      if (request) {
        lastActivity = {
          ...request,
          status,
          error,
          finishedAt: new Date().toISOString()
        };
      }
      requests.delete(id);
    },
    request(id) {
      return requests.get(id);
    },
    recordGeneration(llm, reply, meta = {}) {
      const provider = normalizeLlmProvider(llm?.provider);
      const generation = {
        provider,
        providerLabel: providerLabel(provider),
        model: reply?.model || llm?.model || "",
        checkedAt: new Date().toISOString(),
        ...generationStatsFromReply(reply),
        ...meta
      };
      lastGenerations.set(provider, generation);
      return generation;
    },
    lastGeneration(provider) {
      return lastGenerations.get(provider) || null;
    },
    lastActivity() {
      return lastActivity;
    },
    activeCount() {
      return requests.size;
    },
    activeRequests() {
      return Array.from(requests.values()).map((request) => ({
        id: request.id,
        phase: request.phase,
        model: request.model,
        modelState: request.modelState || "",
        modelLoaded: request.modelLoaded === undefined ? null : Boolean(request.modelLoaded),
        provider: request.provider,
        providerLabel: providerLabel(request.provider),
        selectedBy: request.selectedBy || "",
        autoFallbackReason: request.autoFallbackReason || "",
        timeoutSeconds: request.timeoutSeconds || 0,
        sourceId: request.sourceId,
        sourcesCount: request.sourcesCount || 0,
        promptChars: request.promptChars || 0,
        contextProfile: request.contextProfile || "",
        startedAt: request.startedAt,
        updatedAt: request.updatedAt
      }));
    }
  };
}

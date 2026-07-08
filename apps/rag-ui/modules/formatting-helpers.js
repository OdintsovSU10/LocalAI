export function folderName(folderPath) {
  return String(folderPath || "").split(/[\\/]/).filter(Boolean).pop() || "Источник";
}

export function formatHistoryTime(value) {
  const date = value ? new Date(value) : null;
  if (!date || Number.isNaN(date.getTime())) return "";
  return date.toLocaleString("ru-RU", {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  });
}

export function formatFileSize(bytes) {
  const value = Number(bytes || 0);
  if (!Number.isFinite(value) || value <= 0) return "";
  const units = ["Б", "КБ", "МБ", "ГБ"];
  let size = value;
  let unitIndex = 0;
  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex += 1;
  }
  return `${size >= 10 || unitIndex === 0 ? Math.round(size) : size.toFixed(1)} ${units[unitIndex]}`;
}

export function formatLatency(value) {
  const number = Number(value || 0);
  return number ? `${Math.round(number)} мс` : "";
}

export function formatSeconds(value) {
  const number = Number(value || 0);
  if (!number) return "";
  return `${number.toFixed(number >= 10 ? 1 : 2)} с`;
}

export function formatRouteWait(seconds) {
  const number = Math.max(0, Number(seconds || 0));
  if (!number) return "";
  if (number >= 60) return `${Math.round(number / 60)} мин`;
  return `${Math.round(number)} сек`;
}

export function formatGenerationStats(lastGeneration) {
  if (!lastGeneration) return "нет данных";
  const parts = [];
  if (lastGeneration.tokensPerSecond) parts.push(`${Number(lastGeneration.tokensPerSecond).toFixed(1)} tok/s`);
  if (lastGeneration.timeToFirstToken) parts.push(`TTFT ${formatSeconds(lastGeneration.timeToFirstToken)}`);
  if (lastGeneration.generationTime) parts.push(`gen ${formatSeconds(lastGeneration.generationTime)}`);
  if (!parts.length && lastGeneration.endpoint) parts.push(lastGeneration.endpoint);
  return parts.join(" · ") || "нет stats";
}

export function fallbackReasonText(reason) {
  if (reason === "remote_not_configured") return "удаленная LM Studio не настроена";
  if (reason === "remote_context_disabled") return "remote context выключен";
  if (reason === "local_failed") return "local не ответил";
  if (reason === "remote_failed") return "удаленная LM Studio не ответила";
  if (reason === "llm_failed") return "модель не ответила, показаны фрагменты индекса";
  return String(reason || "").trim();
}

export function formatResponseMeta(payload = {}) {
  const parts = [];
  if (payload.matchedSource?.title) {
    parts.push(`Проект: ${payload.matchedSource.title}${payload.matchedSource.autoSelected ? " (авто)" : ""}`);
  }
  const fallbackReason = fallbackReasonText(payload.fallbackReason);
  if (payload.selectedBy === "auto") {
    parts.push(fallbackReason ? `Auto fallback: ${fallbackReason}` : "Auto");
  }
  const metadata = payload.metadata || {};
  if (metadata.selectedProvider) {
    const providerText = metadata.selectedBaseUrlKind === "remote" ? "Provider: remote" : "Provider: local";
    parts.push(metadata.fallbackUsed ? `${providerText} (fallback)` : providerText);
  } else if (payload.providerLabel) {
    parts.push(payload.providerLabel);
  }
  if (metadata.selectedBaseUrlKind === "remote" && metadata.remoteContextAllowed) {
    parts.push("remote context");
  }
  if (payload.model) parts.push(payload.model);
  return parts.join(" · ");
}

export function compactRagDebug(payload = {}) {
  const metadata = payload.metadata || {};
  if (!metadata || !Object.keys(metadata).length) return null;
  return {
    matchedSource: metadata.matchedSource || payload.matchedSource || null,
    selectedProvider: metadata.selectedProvider || payload.provider || "",
    selectedBaseUrlKind: metadata.selectedBaseUrlKind || "",
    providerLabel: payload.providerLabel || "",
    model: payload.model || "",
    fallbackUsed: Boolean(metadata.fallbackUsed),
    qdrantUsed: Boolean(metadata.qdrantUsed),
    rerankerUsed: Boolean(metadata.rerankerUsed),
    vectorCandidateCount: Number(metadata.vectorCandidateCount || 0),
    lexicalCandidateCount: Number(metadata.lexicalCandidateCount || 0),
    mergedCandidateCount: Number(metadata.mergedCandidateCount || 0),
    finalSourceCount: Number(metadata.finalSourceCount || 0),
    promptChars: Number(metadata.promptChars || 0),
    answerChars: Number(metadata.answerChars || 0),
    timings: {
      retrievalMs: Number(metadata.timings?.retrievalMs || 0),
      rerankMs: Number(metadata.timings?.rerankMs || 0),
      llmMs: Number(metadata.timings?.llmMs || 0),
      totalMs: Number(metadata.timings?.totalMs || 0)
    }
  };
}

export function formatMs(value) {
  const number = Number(value || 0);
  if (!Number.isFinite(number) || number <= 0) return "0 ms";
  if (number < 1000) return `${Math.round(number)} ms`;
  return `${(number / 1000).toFixed(number < 10000 ? 1 : 0)} s`;
}

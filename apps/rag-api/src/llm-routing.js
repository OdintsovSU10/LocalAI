import { normalizeLlmSettings, normalizeRemoteRuntime } from "./llm.js";

const remoteAutoTimeoutSeconds = 300;

export function normalizeLlmProvider(provider, fallback = "local") {
  const value = String(provider || fallback || "local").trim().toLowerCase();
  if (value === "auto") return "auto";
  if (value === "remote" || value === "token") return "remote";
  return "local";
}

export function remoteContextAllowed(llm = {}) {
  return Boolean(llm.allowRemoteContext ?? llm.remote?.enabled);
}

export function providerLabel(provider) {
  const normalized = normalizeLlmProvider(provider);
  if (normalized === "auto") return "Авто";
  return normalized === "remote" ? "Удаленная LM Studio" : "Локальная LM Studio";
}

export function localLlmSettings(base) {
  return {
    ...base,
    provider: "local",
    selectedProvider: "local",
    selectedBaseUrlKind: "local",
    remoteContextAllowed: remoteContextAllowed(base),
    allowAutoFallback: false
  };
}

export function remoteLlmSettings(base) {
  const remote = base.remote || {};
  const baseUrl = String(remote.baseUrl || "").trim().replace(/\/$/, "");
  const apiKey = String(remote.apiKey || "").trim();
  const allowed = remoteContextAllowed(base);
  return {
    ...base,
    provider: "remote",
    selectedProvider: "remote",
    selectedBaseUrlKind: "remote",
    remoteContextAllowed: allowed,
    baseUrl,
    apiKey,
    model: String(remote.model || "").trim(),
    runtime: normalizeRemoteRuntime(remote.runtime),
    timeoutSeconds: Math.max(remoteAutoTimeoutSeconds, Number(remote.timeoutSeconds || base.timeoutSeconds || 120)),
    missingRemoteContext: !allowed,
    missingBaseUrl: !baseUrl,
    missingApiKey: !apiKey,
    allowAutoFallback: false
  };
}

function normalizedBase(settings) {
  return normalizeLlmSettings(settings?.llm || settings || {});
}

export function selectedLlmSettings(settings, provider = "active") {
  const base = normalizedBase(settings);
  const selectedProvider = normalizeLlmProvider(provider === "active" ? base.provider : provider, base.provider);

  if (selectedProvider === "remote") return remoteLlmSettings(base);
  return localLlmSettings(base);
}

export function chatLlmCandidates(settings) {
  const base = normalizedBase(settings);
  const activeProvider = normalizeLlmProvider(base.provider);
  const local = localLlmSettings(base);
  const remote = remoteLlmSettings(base);
  const remoteConfigured = !remote.missingBaseUrl && !remote.missingApiKey;

  if (activeProvider === "local") return [local];

  if (activeProvider === "remote") {
    if (base.fallbackToLocalOnRemoteError && !remote.missingRemoteContext) {
      return [
        { ...remote, allowAutoFallback: true },
        { ...local, selectedBy: "remote-fallback", autoFallbackReason: "remote_failed" }
      ];
    }
    return [remote];
  }

  if (remote.remoteContextAllowed && remoteConfigured) {
    return [
      { ...local, selectedBy: "auto", allowAutoFallback: true },
      { ...remote, selectedBy: "auto", autoFallbackReason: "local_failed" }
    ];
  }

  return [{
    ...local,
    selectedBy: "auto",
    autoFallbackReason: remote.remoteContextAllowed ? "remote_not_configured" : "remote_context_disabled"
  }];
}

export function llmRouteMetadata(llm, options = {}) {
  const provider = normalizeLlmProvider(llm?.selectedProvider || llm?.provider);
  const baseUrlKind = llm?.selectedBaseUrlKind || (provider === "remote" ? "remote" : "local");
  return {
    selectedProvider: provider,
    selectedBaseUrlKind: baseUrlKind === "remote" ? "remote" : "local",
    fallbackUsed: Boolean(options.fallbackUsed),
    remoteContextAllowed: Boolean(llm?.remoteContextAllowed),
    remoteRuntime: provider === "remote" ? normalizeRemoteRuntime(llm?.runtime || llm?.remote?.runtime) : ""
  };
}

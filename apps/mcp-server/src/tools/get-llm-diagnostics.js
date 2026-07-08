import { sanitizeValue } from "../sanitize/redact.js";

const BLOCKED_REMOTE_MESSAGE =
  "provider=token/remote is blocked in Phase 1. Use provider=local or enable remote diagnostics in a later phase.";

export async function getLlmDiagnostics(apiClient, args = {}) {
  const provider = String(args.provider || "local").trim().toLowerCase();
  if (provider !== "local") {
    throw new Error(BLOCKED_REMOTE_MESSAGE);
  }

  const payload = await apiClient.get("/api/llm/diagnostics", { provider: "local" });
  return sanitizeValue({
    online: Boolean(payload.online),
    provider: payload.provider || "local",
    providerLabel: payload.providerLabel || "",
    activeProvider: payload.activeProvider || "",
    baseUrl: payload.baseUrl || "",
    configured: Boolean(payload.configured),
    busy: Boolean(payload.busy),
    activeRequestsCount: Number(payload.activeRequestsCount || 0),
    latencyMs: payload.latencyMs,
    configuredModel: payload.configuredModel || null,
    models: payload.models || [],
    openai: payload.openai || null,
    nativeRest: payload.nativeRest || null,
    error: payload.error || ""
  });
}

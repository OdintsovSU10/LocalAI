// Client of the local portal API (Stage 08). The bot owns no RAG logic: it asks the same endpoints the
// web UI uses, so answers go through the same verified answer-core.

export function createLocalApi({ baseUrl, authToken = "", fetchImpl = fetch, timeoutSeconds = 600 }) {
  async function request(route, { method = "GET", body, signal, timeoutMs = timeoutSeconds * 1000 } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const onAbort = () => controller.abort();
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      const response = await fetchImpl(`${baseUrl}${route}`, {
        method,
        headers: {
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
          ...(authToken ? { Authorization: `Bearer ${authToken}` } : {})
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal
      });
      const text = await response.text();
      const payload = text ? JSON.parse(text) : null;
      if (!response.ok) {
        const error = new Error(payload?.error || `local API ${route} failed with ${response.status}`);
        error.status = response.status;
        throw error;
      }
      return payload;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }
  }

  return {
    request,
    health: () => request("/api/health"),
    // Only what the bot may show: titles and ids, never local paths.
    sources: async () => {
      const payload = await request("/api/sources");
      return (payload?.sources || []).map((source) => ({
        id: source.id,
        title: source.title || source.id,
        sourceType: source.sourceType || "",
        indexStatus: source.indexStatus?.status || "",
        indexedFiles: Number(source.indexStatus?.indexedFiles ?? source.indexedFiles ?? 0) || 0
      }));
    },
    // Named fields only: the settings payload also carries keys and paths that must never reach Telegram.
    status: async function status() {
      const [health, sources, settings] = await Promise.all([
        this.health().catch(() => ({ ok: false })),
        this.sources().catch(() => []),
        request("/api/settings").catch(() => null)
      ]);
      const verifier = settings?.verifier || {};
      const verifierLabel = verifier.mode === "off"
        ? "выключен"
        : verifier.mode === "same_model"
          ? "та же модель отдельным прогоном"
          : verifier.model ? `отдельная модель ${verifier.model}` : "не настроен: только автоматические проверки";
      return {
        ok: Boolean(health?.ok),
        projects: sources.length,
        verified: settings?.answering?.verified !== false,
        verifier: verifierLabel,
        model: String(settings?.llm?.model || "")
      };
    },

    // One Telegram chat keeps one server-side conversation; the legacy id makes it survive a restart.
    conversationForChat: async (chatId) => {
      const payload = await request("/api/conversations/import", {
        method: "POST",
        body: { sessions: [{ id: `tg-${chatId}`, title: "Telegram", messages: [] }] }
      });
      const result = payload?.results?.[0];
      if (!result?.conversationId) throw new Error(result?.error || "conversation was not created");
      return result.conversationId;
    },
    newConversation: async () => {
      const payload = await request("/api/conversations", { method: "POST", body: {} });
      return payload?.id;
    },
    archiveConversation: (conversationId) => request(`/api/conversations/${encodeURIComponent(conversationId)}`, {
      method: "PATCH",
      body: { archived: true }
    }).catch(() => null),
    ask: ({ question, conversationId, sourceId = "", signal }) => request("/api/chat", {
      method: "POST",
      body: { question, sourceId, ...(conversationId ? { conversationId } : {}) },
      signal
    })
  };
}

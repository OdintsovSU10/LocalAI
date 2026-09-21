// Minimal Telegram Bot API client for outbound long polling (Stage 08): no inbound port, no webhook.
// Message texts are never logged; errors are reported without the bot token.

export const MAX_MESSAGE_CHARS = 4096;

export function createTelegramApi({ token, baseUrl = "https://api.telegram.org", fetchImpl = fetch }) {
  const endpoint = (method) => `${baseUrl}/bot${token}/${method}`;
  // The token appears in the URL, so it is stripped from anything that may reach a log.
  const safeMessage = (value) => String(value || "").split(token).join("<token>");

  async function call(method, payload = {}, { signal, timeoutMs = 60_000 } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const onAbort = () => controller.abort();
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      const response = await fetchImpl(endpoint(method), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: controller.signal
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok || body?.ok === false) {
        throw new Error(safeMessage(`Telegram ${method} failed: ${body?.description || response.status}`));
      }
      return body.result;
    } catch (error) {
      throw new Error(safeMessage(error.message || String(error)));
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }
  }

  return {
    safeMessage,
    getUpdates: ({ offset, timeoutSeconds = 25, signal }) => call("getUpdates", {
      offset,
      timeout: timeoutSeconds,
      allowed_updates: ["message", "callback_query"]
    }, { signal, timeoutMs: (timeoutSeconds + 15) * 1000 }),
    sendMessage: (chatId, text, options = {}) => call("sendMessage", {
      chat_id: chatId,
      text,
      disable_web_page_preview: true,
      ...options
    }),
    editMessageText: (chatId, messageId, text, options = {}) => call("editMessageText", {
      chat_id: chatId,
      message_id: messageId,
      text,
      disable_web_page_preview: true,
      ...options
    }).catch(() => null),
    sendChatAction: (chatId, action = "typing") => call("sendChatAction", { chat_id: chatId, action }).catch(() => null),
    answerCallbackQuery: (id, text = "") => call("answerCallbackQuery", { callback_query_id: id, text }).catch(() => null),
    deleteMessage: (chatId, messageId) => call("deleteMessage", { chat_id: chatId, message_id: messageId }).catch(() => null)
  };
}

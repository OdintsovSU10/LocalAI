// Per-chat state of the bot (Stage 08). The conversation itself lives on the server; the bot only
// remembers which conversation belongs to the chat, what it last showed and what is still running.

export function createSessions() {
  const byChat = new Map();
  return {
    get(chatId) {
      const key = String(chatId);
      if (!byChat.has(key)) {
        byChat.set(key, {
          chatId: key,
          conversationId: "",
          pinnedSourceId: "",
          projects: [],
          clarification: [],
          lastSources: [],
          inflight: null
        });
      }
      return byChat.get(key);
    },
    reset(chatId) {
      const session = this.get(chatId);
      session.conversationId = "";
      session.pinnedSourceId = "";
      session.clarification = [];
      session.lastSources = [];
      return session;
    },
    all: () => [...byChat.values()]
  };
}

// One question at a time per chat: a new one cancels the previous, so a long answer never blocks the chat.
export function startRequest(session) {
  cancelRequest(session);
  const controller = new AbortController();
  session.inflight = { controller, startedAt: Date.now() };
  return controller;
}

export function cancelRequest(session) {
  if (!session.inflight) return false;
  session.inflight.controller.abort();
  session.inflight = null;
  return true;
}

export function finishRequest(session, controller) {
  if (session.inflight?.controller === controller) session.inflight = null;
}

/** Token bucket per user: a neutral refusal instead of an answer when a chat floods the local model. */
export function createRateLimiter({ perMinute = 10, now = Date.now } = {}) {
  const hits = new Map();
  return {
    allow(userId) {
      const key = String(userId);
      const cutoff = now() - 60_000;
      const recent = (hits.get(key) || []).filter((time) => time > cutoff);
      if (recent.length >= perMinute) {
        hits.set(key, recent);
        return false;
      }
      recent.push(now());
      hits.set(key, recent);
      return true;
    }
  };
}

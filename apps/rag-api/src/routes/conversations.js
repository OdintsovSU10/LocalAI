export const MAX_IMPORT_SESSIONS = 100;

function asyncRoute(handler) {
  return async (req, res, next) => {
    try {
      await handler(req, res);
    } catch (error) {
      next(error);
    }
  };
}

function badRequest(res, error) {
  res.status(400).json({ error: error.message || "invalid request" });
}

// REST API for server-side conversations of one channel (the web UI uses "web").
export function registerConversationRoutes(app, { getStore, channel = "web" }) {
  const scoped = { channel };

  app.get("/api/conversations", asyncRoute(async (req, res) => {
    const store = await getStore();
    res.json({
      conversations: store.listConversations({
        channel,
        includeArchived: req.query.includeArchived === "true",
        limit: Number(req.query.limit) || 100
      })
    });
  }));

  app.post("/api/conversations", asyncRoute(async (req, res) => {
    const store = await getStore();
    res.status(201).json(store.createConversation({
      channel,
      title: req.body?.title,
      pinnedSourceId: req.body?.sourceId
    }));
  }));

  app.post("/api/conversations/import", asyncRoute(async (req, res) => {
    const sessions = Array.isArray(req.body?.sessions) ? req.body.sessions : [];
    if (!sessions.length) return badRequest(res, new Error("sessions array is required"));
    if (sessions.length > MAX_IMPORT_SESSIONS) return badRequest(res, new Error(`at most ${MAX_IMPORT_SESSIONS} sessions per import`));

    const store = await getStore();
    const results = sessions.map((session) => {
      const legacyId = String(session?.id || "");
      try {
        const { conversation, created } = store.importLegacySession(session, scoped);
        return { legacyId, conversationId: conversation.id, created };
      } catch (error) {
        return { legacyId, error: error.message };
      }
    });
    res.json({ results });
  }));

  app.get("/api/conversations/:id", asyncRoute(async (req, res) => {
    const store = await getStore();
    const conversation = store.getConversation(req.params.id, scoped);
    if (!conversation) return res.status(404).json({ error: "conversation not found" });
    res.json({ conversation, messages: store.listMessages(conversation.id) });
  }));

  app.patch("/api/conversations/:id", asyncRoute(async (req, res) => {
    const store = await getStore();
    const body = req.body || {};
    const conversation = store.updateConversation(req.params.id, {
      title: body.title,
      pinnedSourceId: body.pinnedSourceId,
      archived: body.archived === undefined ? undefined : Boolean(body.archived)
    }, scoped);
    if (!conversation) return res.status(404).json({ error: "conversation not found" });
    res.json(conversation);
  }));

  app.delete("/api/conversations/:id", asyncRoute(async (req, res) => {
    const store = await getStore();
    if (!store.deleteConversation(req.params.id, scoped)) return res.status(404).json({ error: "conversation not found" });
    res.status(204).end();
  }));

  app.get("/api/conversations/:id/messages", asyncRoute(async (req, res) => {
    const store = await getStore();
    const conversation = store.getConversation(req.params.id, scoped);
    if (!conversation) return res.status(404).json({ error: "conversation not found" });
    res.json({ messages: store.listMessages(conversation.id, { limit: Number(req.query.limit) || 0 }) });
  }));

  app.post("/api/conversations/:id/messages", asyncRoute(async (req, res) => {
    const store = await getStore();
    const conversation = store.getConversation(req.params.id, scoped);
    if (!conversation) return res.status(404).json({ error: "conversation not found" });
    try {
      res.status(201).json(store.appendMessage(conversation.id, { role: req.body?.role, text: req.body?.text }));
    } catch (error) {
      badRequest(res, error);
    }
  }));
}

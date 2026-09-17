function asyncRoute(handler) {
  return async (req, res, next) => {
    try {
      await handler(req, res);
    } catch (error) {
      next(error);
    }
  };
}

// Read access to documents, facts and fact traces; rebuild is explicit (and also runs after indexing).
export function registerEvidenceRoutes(app, { getStore, rebuildSource }) {
  app.get("/api/evidence/sources/:sourceId", asyncRoute(async (req, res) => {
    const store = await getStore();
    const sourceId = req.params.sourceId;
    res.json({
      build: store.getSourceSummary(sourceId),
      documents: store.listDocuments(sourceId),
      relations: store.listRelations(sourceId),
      conflicts: store.listConflicts(sourceId)
    });
  }));

  app.get("/api/evidence/facts", asyncRoute(async (req, res) => {
    const sourceId = String(req.query.sourceId || "").trim();
    if (!sourceId) return res.status(400).json({ error: "sourceId is required" });
    const store = await getStore();
    res.json({
      facts: store.listFacts({
        sourceId,
        factType: String(req.query.type || "").trim(),
        status: String(req.query.status || "").trim(),
        documentId: String(req.query.documentId || "").trim()
      })
    });
  }));

  app.get("/api/evidence/facts/:factId/trace", asyncRoute(async (req, res) => {
    const store = await getStore();
    const trace = store.getFactTrace(req.params.factId);
    if (!trace) return res.status(404).json({ error: "fact not found" });
    res.json(trace);
  }));

  app.post("/api/evidence/rebuild", asyncRoute(async (req, res) => {
    const sourceId = String(req.body?.sourceId || "").trim();
    if (!sourceId) return res.status(400).json({ error: "sourceId is required" });
    res.json(await rebuildSource(sourceId));
  }));
}

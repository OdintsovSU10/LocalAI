// In-memory evidence provider with the same interface as the evidence store (spansForChunks, spansByIds,
// neighborSpan, factsForSources, documentsByIds). Used by the offline product eval and by tests.

function withPreview(span) {
  return {
    ...span,
    preview: {
      sourceId: span.sourceId,
      fileId: span.fileId,
      chunkId: span.chunkId,
      focusText: String(span.text || "").slice(0, 300)
    }
  };
}

export function createMemoryEvidenceProvider(builds = []) {
  const spans = builds.flatMap((build) => build.spans || []);
  const facts = builds.flatMap((build) => build.facts || []);
  const documents = builds.flatMap((build) => build.documents || []);
  const spanById = new Map(spans.map((span) => [span.evidenceId, span]));
  const spanByPosition = new Map(spans.map((span) => [`${span.documentId}|${span.ordinal}`, span]));

  return {
    spansForChunks(chunkIds = []) {
      const ids = new Set(chunkIds.filter(Boolean).map(String));
      return spans.filter((span) => span.chunkId && ids.has(span.chunkId)).map(withPreview);
    },
    spansByIds(evidenceIds = []) {
      return [...new Set(evidenceIds)].map((id) => spanById.get(id)).filter(Boolean).map(withPreview);
    },
    neighborSpan(documentId, ordinal) {
      const span = spanByPosition.get(`${documentId}|${Number(ordinal)}`);
      return span ? withPreview(span) : null;
    },
    factsForSources({ sourceIds = null, factTypes = null, statuses = null } = {}) {
      return facts.filter((fact) => (!Array.isArray(sourceIds) || sourceIds.includes(fact.sourceId))
        && (!Array.isArray(factTypes) || factTypes.includes(fact.factType))
        && (!Array.isArray(statuses) || statuses.includes(fact.status)));
    },
    documentsByIds(documentIds = []) {
      const ids = new Set(documentIds);
      return documents.filter((document) => ids.has(document.documentId));
    }
  };
}

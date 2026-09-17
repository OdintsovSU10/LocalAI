import path from "node:path";
import { fileURLToPath } from "node:url";

import { openMigratedDatabase } from "../sqlite-migrations.js";
import { redactEvidenceText } from "./evidence-redaction.js";

const migrationsDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "migrations");
const PREVIEW_FOCUS_CHARS = 300;

function parseJson(value, fallback) {
  try {
    return value ? JSON.parse(value) : fallback;
  } catch {
    return fallback;
  }
}

function optionalInteger(value) {
  return value === null || value === undefined || value === "" ? null : Number(value);
}

// Rejects a build before anything is written: every fact must point at evidence spans of the same build.
export function validateEvidenceBuild(build) {
  const spanIds = new Set(build.spans.map((span) => span.evidenceId));
  const documentIds = new Set(build.documents.map((document) => document.documentId));
  for (const span of build.spans) {
    if (!documentIds.has(span.documentId)) throw new Error(`evidence ${span.evidenceId} has no document`);
  }
  for (const fact of build.facts) {
    if (!documentIds.has(fact.documentId)) throw new Error(`fact ${fact.factId} has no document`);
    if (!fact.evidenceIds?.length) throw new Error(`fact ${fact.factId} has no evidence`);
    for (const evidenceId of fact.evidenceIds) {
      if (!spanIds.has(evidenceId)) throw new Error(`fact ${fact.factId} references unknown evidence ${evidenceId}`);
    }
  }
}

function publicDocument(row) {
  return {
    documentId: row.document_id,
    sourceId: row.source_id,
    fileId: row.file_id,
    fileLabel: row.file_label,
    kind: row.kind,
    title: row.title,
    number: row.number,
    documentDate: row.document_date,
    effectiveDate: row.effective_date,
    contentHash: row.content_hash,
    parentDocumentId: row.parent_document_id,
    parentRef: parseJson(row.parent_ref_json, null),
    relation: row.relation,
    classification: parseJson(row.classification_json, {}),
    indexedAt: row.indexed_at,
    builtAt: row.built_at
  };
}

function publicSpan(row) {
  return {
    evidenceId: row.evidence_id,
    documentId: row.document_id,
    sourceId: row.source_id,
    fileId: row.file_id,
    chunkId: row.chunk_id,
    kind: row.kind,
    ordinal: Number(row.ordinal),
    pageStart: optionalInteger(row.page_start),
    pageEnd: optionalInteger(row.page_end),
    sheetName: row.sheet_name,
    rowStart: optionalInteger(row.row_start),
    rowEnd: optionalInteger(row.row_end),
    sectionTitle: row.section_title,
    text: row.text,
    contentHash: row.content_hash,
    charStart: optionalInteger(row.char_start),
    charEnd: optionalInteger(row.char_end),
    // Parameters for GET /api/files/preview that open this exact fragment.
    preview: {
      sourceId: row.source_id,
      fileId: row.file_id,
      chunkId: row.chunk_id,
      focusText: String(row.text || "").slice(0, PREVIEW_FOCUS_CHARS)
    }
  };
}

function publicFact(row, evidenceIds = []) {
  return {
    factId: row.fact_id,
    documentId: row.document_id,
    sourceId: row.source_id,
    factType: row.fact_type,
    rawValue: row.raw_value,
    normalized: parseJson(row.normalized_json, {}),
    unit: row.unit,
    condition: row.condition_text,
    clauseRef: row.clause_ref,
    amends: Boolean(row.amends),
    validFrom: row.valid_from,
    validTo: row.valid_to,
    status: row.status,
    supersedesFactId: row.supersedes_fact_id,
    supersededByFactId: row.superseded_by_fact_id,
    extractionMethod: row.extraction_method,
    extractionVersion: row.extraction_version,
    evidenceIds
  };
}

export async function createEvidenceStore({ databasePath, now = () => new Date().toISOString() }) {
  const db = await openMigratedDatabase(databasePath, migrationsDir, { label: "evidence" });

  const evidenceIdsFor = (factId) => db.prepare("SELECT evidence_id FROM fact_evidence WHERE fact_id = ? ORDER BY evidence_id")
    .all(factId).map((row) => row.evidence_id);
  const factById = (factId) => {
    const row = factId ? db.prepare("SELECT * FROM facts WHERE fact_id = ?").get(factId) : null;
    return row ? publicFact(row, evidenceIdsFor(row.fact_id)) : null;
  };

  const store = {
    // Replaces everything stored for the source with a new build; the same build twice leaves the same rows.
    replaceSourceEvidence(build) {
      validateEvidenceBuild(build);
      const builtAt = now();
      db.exec("BEGIN IMMEDIATE");
      try {
        db.prepare("DELETE FROM fact_conflicts WHERE source_id = ?").run(build.sourceId);
        db.prepare("DELETE FROM document_relations WHERE source_id = ?").run(build.sourceId);
        db.prepare("DELETE FROM documents WHERE source_id = ?").run(build.sourceId);
        db.prepare("DELETE FROM source_builds WHERE source_id = ?").run(build.sourceId);

        const insertDocument = db.prepare(`
          INSERT INTO documents (document_id, source_id, file_id, file_label, kind, title, number, document_date, effective_date,
            revision, content_hash, parent_document_id, parent_ref_json, relation, classification_json, indexed_at, built_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);
        for (const document of build.documents) {
          insertDocument.run(
            document.documentId, build.sourceId, document.fileId, path.basename(String(document.fileLabel || "")), document.kind,
            redactEvidenceText(document.title || ""), document.number || "", document.documentDate || null, document.effectiveDate || null,
            document.revision || "", document.contentHash, document.parentDocumentId || null,
            JSON.stringify(document.parentRef || {}), document.relation || "none", JSON.stringify(document.classification || {}),
            document.indexedAt || null, builtAt
          );
        }

        const insertSpan = db.prepare(`
          INSERT INTO evidence_spans (evidence_id, document_id, source_id, file_id, chunk_id, kind, ordinal, page_start, page_end,
            sheet_name, row_start, row_end, section_title, text, content_hash, char_start, char_end, recognition_json)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);
        for (const span of build.spans) {
          insertSpan.run(
            span.evidenceId, span.documentId, build.sourceId, span.fileId, span.chunkId || null, span.kind, span.ordinal,
            span.pageStart ?? null, span.pageEnd ?? null, span.sheetName || null, span.rowStart ?? null, span.rowEnd ?? null,
            span.sectionTitle ? redactEvidenceText(span.sectionTitle) : null, redactEvidenceText(span.text), span.contentHash, span.charStart ?? null, span.charEnd ?? null,
            JSON.stringify(span.recognition || {})
          );
        }

        const insertFact = db.prepare(`
          INSERT INTO facts (fact_id, document_id, source_id, fact_type, raw_value, normalized_json, unit, condition_text, clause_ref,
            amends, valid_from, valid_to, status, supersedes_fact_id, superseded_by_fact_id, extraction_method, extraction_version, built_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);
        const insertFactEvidence = db.prepare("INSERT INTO fact_evidence (fact_id, evidence_id) VALUES (?, ?)");
        for (const fact of build.facts) {
          insertFact.run(
            fact.factId, fact.documentId, build.sourceId, fact.factType, redactEvidenceText(fact.rawValue), redactEvidenceText(JSON.stringify(fact.normalized)),
            fact.unit || "", redactEvidenceText(fact.condition || ""), fact.clauseRef || "", fact.amends ? 1 : 0, fact.validFrom || null,
            fact.validTo || null, fact.status, fact.supersedesFactId || null, fact.supersededByFactId || null,
            fact.extractionMethod, fact.extractionVersion, builtAt
          );
          for (const evidenceId of fact.evidenceIds) insertFactEvidence.run(fact.factId, evidenceId);
        }

        const insertRelation = db.prepare(`
          INSERT INTO document_relations (source_id, from_document_id, to_document_id, relation, reason) VALUES (?, ?, ?, ?, ?)
        `);
        for (const relation of build.relations) {
          insertRelation.run(build.sourceId, relation.fromDocumentId, relation.toDocumentId || null, relation.relation, relation.reason || "");
        }

        const insertConflict = db.prepare(`
          INSERT INTO fact_conflicts (conflict_id, source_id, type_group, fact_ids_json, reason, built_at) VALUES (?, ?, ?, ?, ?, ?)
        `);
        for (const conflict of build.conflicts) {
          insertConflict.run(conflict.conflictId, build.sourceId, conflict.typeGroup, JSON.stringify(conflict.factIds), conflict.reason, builtAt);
        }

        db.prepare(`
          INSERT INTO source_builds (source_id, built_at, extraction_version, document_count, span_count, fact_count, input_hash)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(build.sourceId, builtAt, build.extractionVersion, build.documents.length, build.spans.length, build.facts.length, build.inputHash);
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
      return store.getSourceSummary(build.sourceId);
    },

    getSourceSummary(sourceId) {
      const build = db.prepare("SELECT * FROM source_builds WHERE source_id = ?").get(String(sourceId || ""));
      if (!build) return null;
      return {
        sourceId: build.source_id,
        builtAt: build.built_at,
        extractionVersion: build.extraction_version,
        documentCount: Number(build.document_count),
        spanCount: Number(build.span_count),
        factCount: Number(build.fact_count),
        inputHash: build.input_hash
      };
    },

    listDocuments(sourceId) {
      return db.prepare("SELECT * FROM documents WHERE source_id = ? ORDER BY file_label").all(String(sourceId || "")).map(publicDocument);
    },

    listRelations(sourceId) {
      return db.prepare("SELECT * FROM document_relations WHERE source_id = ? ORDER BY from_document_id").all(String(sourceId || ""))
        .map((row) => ({ fromDocumentId: row.from_document_id, toDocumentId: row.to_document_id, relation: row.relation, reason: row.reason }));
    },

    listConflicts(sourceId) {
      return db.prepare("SELECT * FROM fact_conflicts WHERE source_id = ? ORDER BY type_group, conflict_id").all(String(sourceId || ""))
        .map((row) => ({ conflictId: row.conflict_id, typeGroup: row.type_group, factIds: parseJson(row.fact_ids_json, []), reason: row.reason }));
    },

    listFacts({ sourceId, factType = "", status = "", documentId = "" } = {}) {
      const conditions = ["source_id = ?"];
      const params = [String(sourceId || "")];
      if (factType) {
        conditions.push("fact_type = ?");
        params.push(factType);
      }
      if (status) {
        conditions.push("status = ?");
        params.push(status);
      }
      if (documentId) {
        conditions.push("document_id = ?");
        params.push(documentId);
      }
      return db.prepare(`SELECT * FROM facts WHERE ${conditions.join(" AND ")} ORDER BY fact_type, valid_from, fact_id`)
        .all(...params).map((row) => publicFact(row, evidenceIdsFor(row.fact_id)));
    },

    // fact -> evidence spans (with preview parameters) -> document, plus amendment history and conflicts.
    getFactTrace(factId) {
      const fact = factById(factId);
      if (!fact) return null;
      const document = db.prepare("SELECT * FROM documents WHERE document_id = ?").get(fact.documentId);
      const evidence = fact.evidenceIds
        .map((evidenceId) => db.prepare("SELECT * FROM evidence_spans WHERE evidence_id = ?").get(evidenceId))
        .filter(Boolean)
        .map(publicSpan);
      const conflicts = db.prepare("SELECT * FROM fact_conflicts WHERE source_id = ?").all(fact.sourceId)
        .map((row) => ({ conflictId: row.conflict_id, typeGroup: row.type_group, factIds: parseJson(row.fact_ids_json, []), reason: row.reason }))
        .filter((conflict) => conflict.factIds.includes(fact.factId));
      return {
        fact,
        document: document ? publicDocument(document) : null,
        evidence,
        supersedes: factById(fact.supersedesFactId),
        supersededBy: factById(fact.supersededByFactId),
        conflicts
      };
    },

    close() {
      db.close();
    }
  };
  return store;
}

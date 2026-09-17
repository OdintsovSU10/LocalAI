-- Canonical documents, evidence spans, structured facts and the document version graph (Product V2, Stage 04).
-- Derived from the index: rebuilding a source replaces its rows. File labels only, never absolute paths.

CREATE TABLE IF NOT EXISTS documents (
  document_id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL,
  file_id TEXT NOT NULL,
  file_label TEXT NOT NULL,
  kind TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  number TEXT NOT NULL DEFAULT '',
  document_date TEXT,
  effective_date TEXT,
  revision TEXT NOT NULL DEFAULT '',
  content_hash TEXT NOT NULL,
  parent_document_id TEXT,
  parent_ref_json TEXT NOT NULL DEFAULT '{}',
  relation TEXT NOT NULL DEFAULT 'none',
  classification_json TEXT NOT NULL DEFAULT '{}',
  indexed_at TEXT,
  built_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_documents_source ON documents(source_id);

CREATE TABLE IF NOT EXISTS evidence_spans (
  evidence_id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL REFERENCES documents(document_id) ON DELETE CASCADE,
  source_id TEXT NOT NULL,
  file_id TEXT NOT NULL,
  chunk_id TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('paragraph', 'table_row')),
  ordinal INTEGER NOT NULL,
  page_start INTEGER,
  page_end INTEGER,
  sheet_name TEXT,
  row_start INTEGER,
  row_end INTEGER,
  section_title TEXT,
  text TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  char_start INTEGER,
  char_end INTEGER,
  recognition_json TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_evidence_document ON evidence_spans(document_id, ordinal);
CREATE INDEX IF NOT EXISTS idx_evidence_source ON evidence_spans(source_id);

CREATE TABLE IF NOT EXISTS facts (
  fact_id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL REFERENCES documents(document_id) ON DELETE CASCADE,
  source_id TEXT NOT NULL,
  fact_type TEXT NOT NULL,
  raw_value TEXT NOT NULL,
  normalized_json TEXT NOT NULL,
  unit TEXT NOT NULL DEFAULT '',
  condition_text TEXT NOT NULL DEFAULT '',
  clause_ref TEXT NOT NULL DEFAULT '',
  amends INTEGER NOT NULL DEFAULT 0,
  valid_from TEXT,
  valid_to TEXT,
  status TEXT NOT NULL CHECK (status IN ('active', 'superseded', 'conflict')),
  supersedes_fact_id TEXT,
  superseded_by_fact_id TEXT,
  extraction_method TEXT NOT NULL,
  extraction_version TEXT NOT NULL,
  built_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_facts_source_type ON facts(source_id, fact_type, status);

CREATE TABLE IF NOT EXISTS fact_evidence (
  fact_id TEXT NOT NULL REFERENCES facts(fact_id) ON DELETE CASCADE,
  evidence_id TEXT NOT NULL REFERENCES evidence_spans(evidence_id) ON DELETE CASCADE,
  PRIMARY KEY (fact_id, evidence_id)
);

CREATE TABLE IF NOT EXISTS document_relations (
  source_id TEXT NOT NULL,
  from_document_id TEXT NOT NULL REFERENCES documents(document_id) ON DELETE CASCADE,
  to_document_id TEXT,
  relation TEXT NOT NULL CHECK (relation IN ('amends', 'appendix_of', 'unknown')),
  reason TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (from_document_id, relation)
);

CREATE TABLE IF NOT EXISTS fact_conflicts (
  conflict_id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL,
  type_group TEXT NOT NULL,
  fact_ids_json TEXT NOT NULL,
  reason TEXT NOT NULL,
  built_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_fact_conflicts_source ON fact_conflicts(source_id);

CREATE TABLE IF NOT EXISTS source_builds (
  source_id TEXT PRIMARY KEY,
  built_at TEXT NOT NULL,
  extraction_version TEXT NOT NULL,
  document_count INTEGER NOT NULL,
  span_count INTEGER NOT NULL,
  fact_count INTEGER NOT NULL,
  input_hash TEXT NOT NULL
);

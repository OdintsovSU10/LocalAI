-- Server-side conversations (Product V2, Stage 03). No secrets or absolute document paths are stored here.

CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY,
  channel TEXT NOT NULL CHECK (channel IN ('web', 'telegram', 'api')),
  external_user_id_hash TEXT,
  legacy_id TEXT,
  title TEXT NOT NULL DEFAULT '',
  selected_source_ids_json TEXT NOT NULL DEFAULT '[]',
  pinned_source_id TEXT NOT NULL DEFAULT '',
  archived_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_conversations_channel_legacy
  ON conversations(channel, legacy_id) WHERE legacy_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_conversations_channel_updated
  ON conversations(channel, updated_at);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  text TEXT NOT NULL,
  scope_json TEXT NOT NULL DEFAULT '{}',
  answer_status TEXT NOT NULL DEFAULT '',
  citations_json TEXT NOT NULL DEFAULT '[]',
  verifier_json TEXT,
  trace_id TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  UNIQUE (conversation_id, seq)
);

CREATE TABLE IF NOT EXISTS turn_state (
  conversation_id TEXT PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,
  pending_clarification_json TEXT,
  memory_json TEXT NOT NULL DEFAULT '{}',
  updated_at TEXT NOT NULL
);

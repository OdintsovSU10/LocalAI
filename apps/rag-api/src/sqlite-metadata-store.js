import fs from "node:fs/promises";
import path from "node:path";
import { metadataSqlitePath } from "./paths.js";

let sqliteModulePromise = null;

async function sqliteModule() {
  sqliteModulePromise ||= import("node:sqlite");
  return sqliteModulePromise;
}

function json(value, fallback = null) {
  try {
    return JSON.stringify(value ?? fallback);
  } catch {
    return JSON.stringify(fallback);
  }
}

function parseJson(value, fallback) {
  try {
    return value ? JSON.parse(value) : fallback;
  } catch {
    return fallback;
  }
}

export function sqliteMetadataPath(storage = {}) {
  const configured = String(storage?.sqlite?.databasePath || "").trim();
  return configured ? path.resolve(configured) : metadataSqlitePath();
}

async function openDatabase(storage = {}) {
  const { DatabaseSync } = await sqliteModule();
  const databasePath = sqliteMetadataPath(storage);
  await fs.mkdir(path.dirname(databasePath), { recursive: true });
  const db = new DatabaseSync(databasePath);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  ensureSchema(db);
  return db;
}

function ensureSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS metadata_files (
      file_id TEXT PRIMARY KEY,
      source_id TEXT NOT NULL,
      source_title TEXT,
      path TEXT NOT NULL,
      cache_file TEXT,
      mtime_ms REAL,
      size INTEGER,
      indexed_at TEXT,
      recognition_json TEXT,
      quality_json TEXT,
      payload_json TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_metadata_files_source ON metadata_files(source_id);
    CREATE INDEX IF NOT EXISTS idx_metadata_files_path ON metadata_files(path);

    CREATE TABLE IF NOT EXISTS metadata_chunks (
      id TEXT PRIMARY KEY,
      file_id TEXT,
      source_id TEXT NOT NULL,
      source_title TEXT,
      path TEXT NOT NULL,
      title TEXT,
      chunk_index INTEGER,
      text TEXT NOT NULL,
      terms_json TEXT,
      metadata_json TEXT,
      payload_json TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_metadata_chunks_source ON metadata_chunks(source_id);
    CREATE INDEX IF NOT EXISTS idx_metadata_chunks_file ON metadata_chunks(file_id);
    CREATE INDEX IF NOT EXISTS idx_metadata_chunks_path ON metadata_chunks(path);

    CREATE TABLE IF NOT EXISTS source_summaries (
      source_id TEXT PRIMARY KEY,
      updated_at TEXT,
      payload_json TEXT NOT NULL
    );
  `);
}

export async function assertSqliteMetadataAvailable(storage = {}) {
  const db = await openDatabase(storage);
  db.close();
  return sqliteMetadataPath(storage);
}

export async function readManifestFromSqlite(storage = {}) {
  const db = await openDatabase(storage);
  try {
    const rows = db.prepare("SELECT file_id, payload_json FROM metadata_files ORDER BY source_id, path").all();
    const files = {};
    for (const row of rows) {
      const entry = parseJson(row.payload_json, null);
      if (entry && row.file_id) files[row.file_id] = entry;
    }
    return { files };
  } finally {
    db.close();
  }
}

export async function writeManifestToSqlite(manifest = {}, storage = {}) {
  const db = await openDatabase(storage);
  try {
    const files = manifest.files || {};
    db.exec("BEGIN IMMEDIATE");
    db.exec("DELETE FROM metadata_files");
    const insert = db.prepare(`
      INSERT INTO metadata_files (
        file_id, source_id, source_title, path, cache_file, mtime_ms, size,
        indexed_at, recognition_json, quality_json, payload_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const [fileId, entry] of Object.entries(files)) {
      insert.run(
        fileId,
        String(entry?.sourceId || ""),
        String(entry?.sourceTitle || ""),
        String(entry?.path || ""),
        String(entry?.cacheFile || ""),
        Number(entry?.mtimeMs || 0),
        Number(entry?.size || 0),
        String(entry?.indexedAt || ""),
        json(entry?.recognition, {}),
        json(entry?.quality, {}),
        json({ ...entry, fileId }, {})
      );
    }
    db.exec("COMMIT");
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // Ignore rollback errors after a failed transaction.
    }
    throw error;
  } finally {
    db.close();
  }
}

export async function readChunksFromSqlite(storage = {}) {
  const db = await openDatabase(storage);
  try {
    const rows = db.prepare(`
      SELECT payload_json
      FROM metadata_chunks
      ORDER BY source_id, path, chunk_index, id
    `).all();
    return rows
      .map((row) => parseJson(row.payload_json, null))
      .filter(Boolean);
  } finally {
    db.close();
  }
}

export async function writeChunksToSqlite(chunks = [], storage = {}) {
  const db = await openDatabase(storage);
  try {
    db.exec("BEGIN IMMEDIATE");
    db.exec("DELETE FROM metadata_chunks");
    const insert = db.prepare(`
      INSERT INTO metadata_chunks (
        id, file_id, source_id, source_title, path, title, chunk_index,
        text, terms_json, metadata_json, payload_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const chunk of chunks) {
      insert.run(
        String(chunk?.id || ""),
        String(chunk?.fileId || ""),
        String(chunk?.sourceId || ""),
        String(chunk?.sourceTitle || ""),
        String(chunk?.path || ""),
        String(chunk?.title || ""),
        Number(chunk?.chunkIndex || 0),
        String(chunk?.text || ""),
        json(chunk?.terms, []),
        json(chunk?.metadata, {}),
        json(chunk, {})
      );
    }
    db.exec("COMMIT");
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // Ignore rollback errors after a failed transaction.
    }
    throw error;
  } finally {
    db.close();
  }
}

export async function readSourceSummariesFromSqlite(storage = {}) {
  const db = await openDatabase(storage);
  try {
    const rows = db.prepare("SELECT source_id, payload_json FROM source_summaries ORDER BY source_id").all();
    const summaries = {};
    for (const row of rows) {
      const summary = parseJson(row.payload_json, null);
      if (summary && row.source_id) summaries[row.source_id] = summary;
    }
    return { summaries };
  } finally {
    db.close();
  }
}

export async function readSourceSummaryFromSqlite(sourceId, storage = {}) {
  const sourceSummaries = await readSourceSummariesFromSqlite(storage);
  return sourceSummaries.summaries?.[sourceId] || null;
}

export async function writeSourceSummariesToSqlite(sourceSummaries = {}, storage = {}) {
  const db = await openDatabase(storage);
  try {
    const summaries = sourceSummaries.summaries || {};
    db.exec("BEGIN IMMEDIATE");
    db.exec("DELETE FROM source_summaries");
    const insert = db.prepare(`
      INSERT INTO source_summaries (source_id, updated_at, payload_json)
      VALUES (?, ?, ?)
    `);
    for (const [sourceId, summary] of Object.entries(summaries)) {
      insert.run(
        sourceId,
        String(summary?.updatedAt || ""),
        json({ ...summary, sourceId }, {})
      );
    }
    db.exec("COMMIT");
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // Ignore rollback errors after a failed transaction.
    }
    throw error;
  } finally {
    db.close();
  }
}

export async function writeSourceSummaryToSqlite(summary = {}, storage = {}) {
  const db = await openDatabase(storage);
  try {
    const sourceId = String(summary?.sourceId || "");
    if (!sourceId) return null;
    db.prepare(`
      INSERT INTO source_summaries (source_id, updated_at, payload_json)
      VALUES (?, ?, ?)
      ON CONFLICT(source_id) DO UPDATE SET
        updated_at = excluded.updated_at,
        payload_json = excluded.payload_json
    `).run(
      sourceId,
      String(summary?.updatedAt || ""),
      json({ ...summary, sourceId }, {})
    );
    return summary;
  } finally {
    db.close();
  }
}

export async function migrateJsonMetadataToSqlite({ manifest = { files: {} }, chunks = [], storage = {}, overwrite = true } = {}) {
  if (overwrite) {
    await writeManifestToSqlite(manifest, storage);
    await writeChunksToSqlite(chunks, storage);
    return {
      files: Object.keys(manifest.files || {}).length,
      chunks: chunks.length,
      databasePath: sqliteMetadataPath(storage)
    };
  }

  const existingManifest = await readManifestFromSqlite(storage);
  const existingChunks = await readChunksFromSqlite(storage);
  if (Object.keys(existingManifest.files || {}).length || existingChunks.length) {
    return {
      skipped: true,
      files: Object.keys(existingManifest.files || {}).length,
      chunks: existingChunks.length,
      databasePath: sqliteMetadataPath(storage)
    };
  }

  await writeManifestToSqlite(manifest, storage);
  await writeChunksToSqlite(chunks, storage);
  return {
    files: Object.keys(manifest.files || {}).length,
    chunks: chunks.length,
    databasePath: sqliteMetadataPath(storage)
  };
}

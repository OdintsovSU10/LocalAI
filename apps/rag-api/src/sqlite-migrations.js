import fs from "node:fs/promises";
import path from "node:path";

async function migrationFiles(migrationsDir) {
  const entries = await fs.readdir(migrationsDir);
  return entries
    .map((name) => ({ name, match: name.match(/^(\d{3})_[\w-]+\.sql$/) }))
    .filter((item) => item.match)
    .map((item) => ({ version: Number(item.match[1]), name: item.name }))
    .sort((left, right) => left.version - right.version);
}

// Applies numbered SQL migrations (NNN_name.sql) once each; re-running on an up-to-date database is a no-op.
export async function applyMigrations(db, migrationsDir, { label = "sqlite" } = {}) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL
    )
  `);
  const applied = new Set(db.prepare("SELECT version FROM schema_migrations").all().map((row) => Number(row.version)));
  const newlyApplied = [];

  for (const migration of await migrationFiles(migrationsDir)) {
    if (applied.has(migration.version)) continue;
    const sql = await fs.readFile(path.join(migrationsDir, migration.name), "utf8");
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec(sql);
      db.prepare("INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)")
        .run(migration.version, migration.name, new Date().toISOString());
      db.exec("COMMIT");
      newlyApplied.push(migration.name);
    } catch (error) {
      db.exec("ROLLBACK");
      throw new Error(`${label} migration ${migration.name} failed: ${error.message}`);
    }
  }
  return newlyApplied;
}

export async function openMigratedDatabase(databasePath, migrationsDir, { label = "sqlite" } = {}) {
  const { DatabaseSync } = await import("node:sqlite");
  await fs.mkdir(path.dirname(databasePath), { recursive: true });
  const db = new DatabaseSync(databasePath);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA busy_timeout = 5000");
  await applyMigrations(db, migrationsDir, { label });
  return db;
}

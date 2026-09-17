import path from "node:path";
import { fileURLToPath } from "node:url";

import { applyMigrations as applyMigrationsFrom, openMigratedDatabase } from "../sqlite-migrations.js";

const migrationsDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "migrations");

// Applies app-state migrations once each; re-running on an up-to-date database is a no-op.
export async function applyMigrations(db) {
  return applyMigrationsFrom(db, migrationsDir, { label: "app-state" });
}

export async function openAppStateDatabase(databasePath) {
  return openMigratedDatabase(databasePath, migrationsDir, { label: "app-state" });
}

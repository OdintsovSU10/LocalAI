import { migrateJsonMetadataToSqlite } from "../apps/rag-api/src/store.js";

const args = new Set(process.argv.slice(2));
const overwrite = !args.has("--no-overwrite");

const result = await migrateJsonMetadataToSqlite({ overwrite });
if (result.skipped) {
  console.log(`SQLite metadata already exists: ${result.files} files, ${result.chunks} chunks`);
} else {
  console.log(`Migrated JSON metadata to SQLite: ${result.files} files, ${result.chunks} chunks`);
}
console.log(`Database: ${result.databasePath}`);

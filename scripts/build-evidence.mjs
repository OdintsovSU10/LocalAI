#!/usr/bin/env node
// Rebuilds canonical documents, evidence spans and facts from the existing index (no re-conversion).
//   npm run evidence:build -- --source-id=<id>
//   npm run evidence:build -- --all
import { evidenceSqlitePath, markdownCacheDir } from "../apps/rag-api/src/paths.js";
import { readChunks, readManifest, readSources } from "../apps/rag-api/src/store.js";
import { createEvidenceStore } from "../apps/rag-api/src/evidence/evidence-store.js";
import { rebuildSourceEvidence } from "../apps/rag-api/src/evidence/source-evidence-runtime.js";

const args = process.argv.slice(2);
const sourceIdArg = (args.find((arg) => arg.startsWith("--source-id=")) || "").slice("--source-id=".length);
const all = args.includes("--all");

if (!sourceIdArg && !all) {
  console.error("Usage: node scripts/build-evidence.mjs --source-id=<id> | --all");
  process.exitCode = 1;
} else {
  const store = await createEvidenceStore({ databasePath: evidenceSqlitePath() });
  try {
    const sources = await readSources();
    const sourceIds = all ? sources.map((source) => source.id) : [sourceIdArg];
    for (const sourceId of sourceIds) {
      try {
        const result = await rebuildSourceEvidence(sourceId, { store, readSources, readManifest, readChunks, markdownCacheRoot: markdownCacheDir() });
        const { summary } = result;
        console.log(`${sourceId}: documents=${summary.documentCount} spans=${summary.spanCount} facts=${summary.factCount} relations=${result.relations} conflicts=${result.conflicts}`);
      } catch (error) {
        console.error(`${sourceId}: ${error.message}`);
        process.exitCode = 1;
      }
    }
  } finally {
    store.close();
  }
}

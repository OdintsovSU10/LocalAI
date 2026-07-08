import {
  ensureStorage,
  readChunks,
  readSettings,
  readSources,
  readVectors,
  writeSettings
} from "../apps/rag-api/src/store.js";
import { ensureChunkEmbeddings } from "../apps/rag-api/src/embeddings.js";
import { buildVectorBackfillRows } from "../apps/rag-api/src/vector-backfill-status.js";
import { countQdrantVectorsBySource } from "../apps/rag-api/src/vector-store.js";

function parseArgs(argv) {
  const args = {
    all: false,
    dryRun: false,
    enableEmbeddings: false,
    list: false,
    smallest: false,
    sourceId: "",
    limitSources: 0,
    batchSize: 16,
    timeoutSeconds: 120
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--all") args.all = true;
    else if (arg === "--dry-run") args.dryRun = true;
    else if (arg === "--enable-embeddings") args.enableEmbeddings = true;
    else if (arg === "--list") args.list = true;
    else if (arg === "--smallest") args.smallest = true;
    else if (arg === "--source-id") args.sourceId = argv[++index] || "";
    else if (arg === "--limit-sources") args.limitSources = Number(argv[++index] || 0);
    else if (arg === "--batch-size") args.batchSize = Number(argv[++index] || args.batchSize);
    else if (arg === "--timeout-seconds") args.timeoutSeconds = Number(argv[++index] || args.timeoutSeconds);
    else if (arg === "--help" || arg === "-h") args.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }

  return args;
}

function usage() {
  return [
    "Usage:",
    "  node scripts/backfill-vectors.mjs --list",
    "  node scripts/backfill-vectors.mjs --smallest --enable-embeddings",
    "  node scripts/backfill-vectors.mjs --source-id <id> --enable-embeddings",
    "  node scripts/backfill-vectors.mjs --all --enable-embeddings",
    "",
    "Options:",
    "  --dry-run              Show selected sources without embedding.",
    "  --batch-size <n>       Embedding batch size to save in settings. Default: 16.",
    "  --timeout-seconds <n>  Embedding timeout to save in settings. Default: 120."
  ].join("\n");
}

async function sourceRows({ sources, chunks, vectors, settings }) {
  const qdrantCountsStatus = await countQdrantVectorsBySource({
    vectorStore: settings.vectorStore,
    sourceIds: sources.map((source) => source.id)
  });

  return buildVectorBackfillRows({
    sources,
    chunks,
    vectors,
    settings,
    qdrantCounts: qdrantCountsStatus.counts,
    qdrantAvailable: qdrantCountsStatus.qdrantAvailable,
    qdrantError: qdrantCountsStatus.qdrantError,
    qdrantWarning: qdrantCountsStatus.warning
  });
}

function selectSources(rows, args) {
  if (args.sourceId) return rows.filter((row) => row.id === args.sourceId);
  if (args.smallest) return rows.filter((row) => !row.ready).filter((row) => row.chunks > 0).slice(0, 1);
  if (args.all) {
    const selected = rows.filter((row) => !row.ready && row.chunks > 0);
    return args.limitSources > 0 ? selected.slice(0, args.limitSources) : selected;
  }
  return [];
}

function printRows(rows) {
  for (const row of rows) {
    const warning = row.warning ? `\twarning=${row.warning}` : "";
    console.log(`${row.id}\tchunks=${row.chunks}\tstored=${row.storedVectors}\tjson=${row.jsonVectors}\tqdrant=${row.qdrantVectors}\tprovider=${row.vectorProviderUsed}\tready=${row.ready}\t${row.title}${warning}`);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(usage());
    return;
  }

  await ensureStorage();
  let settings = await readSettings();
  const [sources, chunks, vectors] = await Promise.all([readSources(), readChunks(), readVectors()]);
  const rows = await sourceRows({ sources, chunks, vectors, settings });

  if (args.list || (!args.all && !args.sourceId && !args.smallest)) {
    printRows(rows);
    if (!args.list) console.log("\nNo source selected. Use --smallest, --source-id <id>, or --all.");
    return;
  }

  const selected = selectSources(rows, args);
  if (!selected.length) throw new Error("No matching source needs vector backfill.");

  console.log("Selected sources:");
  printRows(selected);
  if (args.dryRun) return;

  const runnable = selected.filter((row) => !row.ready);
  if (!runnable.length) {
    console.log("Selected sources already have complete vectors in the active store.");
    return;
  }

  if (!settings.embeddings.enabled) {
    if (!args.enableEmbeddings) {
      throw new Error("Embeddings are disabled. Re-run with --enable-embeddings to enable them in settings.");
    }

    settings = await writeSettings({
      embeddings: {
        ...settings.embeddings,
        enabled: true,
        batchSize: args.batchSize,
        timeoutSeconds: args.timeoutSeconds
      }
    });
    console.log(`Embeddings enabled: ${settings.embeddings.model}, batch=${settings.embeddings.batchSize}, timeout=${settings.embeddings.timeoutSeconds}s`);
  }

  const chunksBySource = new Map();
  for (const chunk of chunks) {
    if (!chunksBySource.has(chunk.sourceId)) chunksBySource.set(chunk.sourceId, []);
    chunksBySource.get(chunk.sourceId).push(chunk);
  }

  for (const row of runnable) {
    const sourceChunks = chunksBySource.get(row.id) || [];
    console.log(`\nBackfilling ${row.id}: ${row.title}`);
    let lastLogAt = 0;
    const result = await ensureChunkEmbeddings({
      sourceId: row.id,
      chunks: sourceChunks,
      onProgress: (progress) => {
        const now = Date.now();
        if (now - lastLogAt < 1500 && progress.phase !== "vector_store") return;
        lastLogAt = now;
        const processed = progress.vectorsProcessed ?? 0;
        const total = progress.vectorsTotal ?? sourceChunks.length;
        const cached = progress.vectorsCached ?? 0;
        const embedded = progress.vectorsEmbedded ?? 0;
        console.log(`${progress.phase}: ${processed}/${total}, cached=${cached}, embedded=${embedded}`);
      }
    });

    console.log(JSON.stringify({
      sourceId: row.id,
      vectorsTotal: result.vectorsTotal,
      vectorsCached: result.vectorsCached,
      vectorsEmbedded: result.vectorsEmbedded,
      qdrantAvailable: result.qdrantAvailable,
      qdrantPoints: result.qdrantPoints,
      qdrantError: result.qdrantError
    }, null, 2));
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});

#!/usr/bin/env node
import { runDailyIndexAgent } from "../apps/rag-api/src/daily-agent.js";

const args = new Set(process.argv.slice(2));
const force = args.has("--force") ? true : undefined;
const dryRun = args.has("--dry-run");
const quiet = args.has("--quiet");

function log(message) {
  if (!quiet) console.log(message);
}

try {
  const run = await runDailyIndexAgent({
    trigger: "cli",
    force,
    dryRun,
    onProgress: (progress) => {
      const total = progress.total || progress.vectorsTotal || 0;
      const processed = progress.processed || progress.vectorsProcessed || 0;
      const suffix = total ? ` ${processed}/${total}` : "";
      log(`[${new Date().toISOString()}] ${progress.phase || "agent"}: ${progress.message || ""}${suffix}`);
    }
  });

  log(JSON.stringify({
    id: run.id,
    status: run.status,
    force: run.force,
    dryRun: run.dryRun,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    totals: run.totals
  }, null, 2));

  process.exitCode = run.status === "completed" ? 0 : 1;
} catch (error) {
  console.error(error.stack || error.message);
  process.exitCode = 1;
}

#!/usr/bin/env node
import {
  createHubTenderAdapterFromEnv,
  createMockHubTenderAdapter
} from "../apps/rag-api/src/hubtender-adapter.js";
import { runTenderPriceAudit } from "../apps/rag-api/src/tender-price-audit.js";

const args = process.argv.slice(2);
const argSet = new Set(args);

function readOption(name) {
  const inline = args.find((arg) => arg.startsWith(`--${name}=`));
  if (inline) return inline.slice(name.length + 3);
  const index = args.indexOf(`--${name}`);
  if (index >= 0 && args[index + 1] && !args[index + 1].startsWith("--")) {
    return args[index + 1];
  }
  return "";
}

const dryRun = argSet.has("--dry-run");
const quiet = argSet.has("--quiet");
const sourceId = readOption("source-id") || readOption("id");
const tenderNumber = readOption("tender-number") || readOption("number");
const hubTenderId = readOption("hub-tender-id");
const tolerancePercent = Number(readOption("tolerance") || "1");

if (!sourceId && !tenderNumber && !hubTenderId) {
  console.error("Usage: node scripts/tender-price-audit.mjs --source-id=<id> [--hub-tender-id=<uuid>] [--tender-number=<no>] [--tolerance=1] [--dry-run] [--quiet]");
  process.exitCode = 1;
} else {
  try {
    const adapter = dryRun
      ? createMockHubTenderAdapter()
      : createHubTenderAdapterFromEnv(process.env);

    const report = await runTenderPriceAudit({
      sourceId,
      tenderNumber,
      hubTenderId,
      tolerancePercent,
      adapter
    });

    if (!quiet) console.log(JSON.stringify(report, null, 2));
    if (report.status === "error") process.exitCode = 2;
    else if (report.status === "warning" || report.status === "needs_review") process.exitCode = 1;
  } catch (error) {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  }
}

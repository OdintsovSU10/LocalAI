#!/usr/bin/env node
import { runTenderSourceSync } from "../apps/rag-api/src/tender-sync.js";

const args = new Set(process.argv.slice(2));
const apply = args.has("--apply");
const quiet = args.has("--quiet");
const prune = args.has("--prune");
const scopeArg = process.argv.slice(2).find((arg) => arg.startsWith("--scope="));
const scope = scopeArg ? scopeArg.slice("--scope=".length) : "all";

try {
  const summary = await runTenderSourceSync({ apply, prune, scope });
  if (!quiet) console.log(JSON.stringify(summary, null, 2));
} catch (error) {
  console.error(error.stack || error.message);
  process.exitCode = 1;
}

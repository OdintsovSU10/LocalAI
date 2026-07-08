#!/usr/bin/env node
import {
  createHubTenderAdapterFromEnv,
  createMockHubTenderAdapter
} from "../apps/rag-api/src/hubtender-adapter.js";
import { getGlobalTenderAuditRun, startGlobalTenderAudit } from "../apps/rag-api/src/tender-global-audit.js";

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
const wait = argSet.has("--wait");
const sync = argSet.has("--sync");
const resumeRunId = readOption("resume");
const maxTenders = Number(readOption("max") || "0");
const tolerancePercent = Number(readOption("tolerance") || "1");

try {
  const adapter = dryRun
    ? createMockHubTenderAdapter()
    : createHubTenderAdapterFromEnv(process.env);

  const run = await startGlobalTenderAudit({
    resumeRunId,
    maxTenders,
    tolerancePercent,
    adapter,
    runInBackground: !sync
  });

  if (!quiet) console.log(JSON.stringify(run, null, 2));

  if (wait && !sync) {
    let latest = run;
    while (latest.status === "running") {
      await new Promise((resolve) => setTimeout(resolve, 1500));
      latest = await getGlobalTenderAuditRun(run.runId);
      if (!quiet) console.error(`status=${latest.status} checked=${latest.tenderReports?.length || 0}`);
    }
    if (!quiet) console.log(JSON.stringify(latest, null, 2));
    if (latest.status === "failed") process.exitCode = 2;
    else if (latest.status !== "ok") process.exitCode = 1;
  }
} catch (error) {
  console.error(error.stack || error.message);
  process.exitCode = 1;
}

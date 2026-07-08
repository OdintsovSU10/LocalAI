import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { indexSource } from "./indexer.js";
import { agentLockPath } from "./paths.js";
import { ensureStorage, readAgentRuns, readSources, writeAgentRuns } from "./store.js";

const AGENT_LOCK_STALE_MS = 24 * 60 * 60 * 1000;
const MAX_PERSISTED_RUNS = 50;

function boolEnv(name, fallback = false) {
  const value = String(process.env[name] || "").trim().toLowerCase();
  if (!value) return fallback;
  return ["1", "true", "yes", "on"].includes(value);
}

function agentForceDefault() {
  return boolEnv("RAG_DAILY_AGENT_FORCE", false);
}

function agentLockStaleMs() {
  const value = Number(process.env.RAG_DAILY_AGENT_LOCK_STALE_MS || AGENT_LOCK_STALE_MS);
  return Number.isFinite(value) && value > 0 ? value : AGENT_LOCK_STALE_MS;
}

async function acquireAgentLock() {
  const lockPath = agentLockPath();
  await fs.mkdir(path.dirname(lockPath), { recursive: true });

  try {
    const handle = await fs.open(lockPath, "wx");
    await handle.writeFile(JSON.stringify({
      createdAt: new Date().toISOString()
    }, null, 2), "utf8");

    return async () => {
      await handle.close().catch(() => {});
      await fs.rm(lockPath, { force: true }).catch(() => {});
    };
  } catch (error) {
    if (error.code !== "EEXIST") throw error;

    const stat = await fs.stat(lockPath).catch(() => null);
    if (stat && Date.now() - stat.mtimeMs > agentLockStaleMs()) {
      await fs.rm(lockPath, { force: true });
      return acquireAgentLock();
    }

    throw new Error("Daily agent is already running.");
  }
}

async function persistRun(run) {
  const runs = await readAgentRuns();
  runs[run.id] = run;

  const orderedIds = Object.keys(runs)
    .sort((left, right) => String(runs[right]?.startedAt || "").localeCompare(String(runs[left]?.startedAt || "")));

  for (const id of orderedIds.slice(MAX_PERSISTED_RUNS)) {
    delete runs[id];
  }

  await writeAgentRuns(runs);
}

function addTotals(totals, result) {
  totals.files += result.files || 0;
  totals.indexedFiles += result.indexedFiles || 0;
  totals.chunks += result.chunks || 0;
  totals.cached += result.cached || 0;
  totals.failedFiles += result.failed || 0;
  totals.vectorsTotal += result.vectorsTotal || 0;
  totals.vectorsEmbedded += result.vectorsEmbedded || 0;
  totals.vectorsCached += result.vectorsCached || 0;
  totals.unsupportedFiles += result.unsupportedFiles || 0;
  totals.temporaryFiles += result.temporaryFiles || 0;
  totals.excludedFiles += result.excludedFiles || 0;
  totals.unreadableDirectories += result.unreadableDirectories || 0;
}

export async function runDailyIndexAgent({
  trigger = "manual",
  force = agentForceDefault(),
  dryRun = false,
  onProgress = () => {},
  googleContextSessionFetch = null
} = {}) {
  await ensureStorage();
  const release = await acquireAgentLock();
  const run = {
    id: crypto.randomUUID(),
    trigger,
    status: "running",
    force: Boolean(force),
    dryRun: Boolean(dryRun),
    startedAt: new Date().toISOString(),
    finishedAt: null,
    sources: [],
    totals: {
      sources: 0,
      files: 0,
      indexedFiles: 0,
      chunks: 0,
      cached: 0,
      failedFiles: 0,
      failedSources: 0,
      vectorsTotal: 0,
      vectorsEmbedded: 0,
      vectorsCached: 0,
      unsupportedFiles: 0,
      temporaryFiles: 0,
      excludedFiles: 0,
      unreadableDirectories: 0
    }
  };

  try {
    await persistRun(run);
    const sources = await readSources();
    run.totals.sources = sources.length;
    await persistRun(run);
    onProgress({ phase: "sources", message: "Sources loaded", total: sources.length });

    if (dryRun) {
      run.sources = sources.map((source) => ({
        sourceId: source.id,
        sourceTitle: source.title,
        path: source.path,
        status: "planned"
      }));
      run.status = "completed";
      run.finishedAt = new Date().toISOString();
      await persistRun(run);
      return run;
    }

    for (const source of sources) {
      const sourceRun = {
        sourceId: source.id,
        sourceTitle: source.title,
        path: source.path,
        status: "running",
        startedAt: new Date().toISOString()
      };
      run.sources.push(sourceRun);
      await persistRun(run);
      onProgress({ phase: "source", message: `Indexing ${source.title}`, sourceId: source.id });

      try {
        const result = await indexSource(source, (progress) => {
          Object.assign(sourceRun, {
            phase: progress.phase,
            message: progress.message,
            processed: progress.processed,
            total: progress.total,
            vectorsProcessed: progress.vectorsProcessed,
            vectorsTotal: progress.vectorsTotal,
            updatedAt: new Date().toISOString()
          });
          persistRun(run).catch(() => {});
          onProgress({ ...progress, sourceId: source.id, sourceTitle: source.title });
        }, {
          force,
          googleContextSessionFetch
        });

        Object.assign(sourceRun, result, {
          status: "completed",
          finishedAt: new Date().toISOString()
        });
        addTotals(run.totals, result);
      } catch (error) {
        Object.assign(sourceRun, {
          status: "failed",
          message: error.message,
          finishedAt: new Date().toISOString()
        });
        run.totals.failedSources += 1;
      }

      await persistRun(run);
    }

    run.status = run.totals.failedSources > 0 ? "completed_with_errors" : "completed";
    run.finishedAt = new Date().toISOString();
    await persistRun(run);
    onProgress({ phase: "done", message: run.status, runId: run.id });
    return run;
  } catch (error) {
    run.status = "failed";
    run.message = error.message;
    run.finishedAt = new Date().toISOString();
    await persistRun(run).catch(() => {});
    throw error;
  } finally {
    await release();
  }
}

export async function readDailyAgentRuns() {
  await ensureStorage();
  return readAgentRuns();
}

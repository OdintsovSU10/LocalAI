import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { indexSource } from "./indexer.js";
import { agentLockPath } from "./paths.js";
import { ensureStorage, readAgentRuns, readSources, writeAgentRuns } from "./store.js";

const AGENT_LOCK_STALE_MS = 24 * 60 * 60 * 1000;
const AGENT_ORPHAN_LOCK_STALE_MS = 30 * 60 * 1000;
const AGENT_LOCK_HEARTBEAT_MS = 60 * 1000;
const MAX_PERSISTED_RUNS = 50;
const INTERRUPTED_MESSAGE = "\u0418\u043d\u0434\u0435\u043a\u0441\u0430\u0446\u0438\u044f \u043f\u0440\u0435\u0440\u0432\u0430\u043d\u0430; \u0437\u0430\u043f\u0443\u0441\u0442\u0438\u0442\u0435 \u0437\u0430\u043d\u043e\u0432\u043e";

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

function agentOrphanLockStaleMs() {
  const value = Number(process.env.RAG_DAILY_AGENT_ORPHAN_LOCK_STALE_MS || AGENT_ORPHAN_LOCK_STALE_MS);
  return Number.isFinite(value) && value > 0 ? value : AGENT_ORPHAN_LOCK_STALE_MS;
}

async function readAgentLock(lockPath) {
  try {
    return JSON.parse(await fs.readFile(lockPath, "utf8"));
  } catch {
    return null;
  }
}

function lockOwnerIsAlive(pid) {
  const ownerPid = Number(pid);
  if (!Number.isInteger(ownerPid) || ownerPid <= 0) return null;
  if (ownerPid === process.pid) return true;

  try {
    process.kill(ownerPid, 0);
    return true;
  } catch (error) {
    if (error.code === "ESRCH") return false;
    if (error.code === "EPERM") return true;
    return null;
  }
}

export async function dailyAgentLockStatus() {
  const lockPath = agentLockPath();
  const stat = await fs.stat(lockPath).catch(() => null);
  if (!stat) {
    return {
      exists: false,
      active: false,
      stale: false,
      orphan: false,
      ownerAlive: null,
      ageMs: 0
    };
  }

  const lock = await readAgentLock(lockPath);
  const pid = Number(lock?.pid || 0) || null;
  const ownerAlive = lockOwnerIsAlive(pid);
  const ageMs = Math.max(0, Date.now() - stat.mtimeMs);
  const orphan = !pid;
  const stale = ownerAlive === false
    || ageMs > agentLockStaleMs()
    || (orphan && ageMs > agentOrphanLockStaleMs());

  return {
    exists: true,
    active: !stale,
    stale,
    orphan,
    ownerAlive,
    ageMs,
    pid,
    createdAt: lock?.createdAt || "",
    updatedAt: stat.mtime.toISOString()
  };
}

async function acquireAgentLock() {
  const lockPath = agentLockPath();
  while (true) {
    await fs.mkdir(path.dirname(lockPath), { recursive: true });

    try {
      const handle = await fs.open(lockPath, "wx");
      await handle.writeFile(JSON.stringify({
        createdAt: new Date().toISOString(),
        pid: process.pid
      }, null, 2), "utf8");
      const heartbeat = setInterval(() => {
        const now = new Date();
        fs.utimes(lockPath, now, now).catch(() => {});
      }, AGENT_LOCK_HEARTBEAT_MS);
      heartbeat.unref?.();

      return async () => {
        clearInterval(heartbeat);
        await handle.close().catch(() => {});
        await fs.rm(lockPath, { force: true }).catch(() => {});
      };
    } catch (error) {
      if (error.code !== "EEXIST") throw error;

      const status = await dailyAgentLockStatus();
      if (status.stale) {
        await fs.rm(lockPath, { force: true });
        continue;
      }

      throw new Error("Daily agent is already running.");
    }
  }
}

export function publicDailyAgentRun(run, { active = false, lockStatus = null } = {}) {
  if (!run || run.status !== "running") return run;
  if (active || lockStatus?.active) return run;

  const finishedAt = run.finishedAt || lockStatus?.updatedAt || run.updatedAt || new Date().toISOString();
  return {
    ...run,
    status: "interrupted",
    phase: run.phase || "interrupted",
    message: INTERRUPTED_MESSAGE,
    finishedAt,
    sources: Array.isArray(run.sources)
      ? run.sources.map((sourceRun) => (
        sourceRun?.status === "running"
          ? { ...sourceRun, status: "interrupted", message: INTERRUPTED_MESSAGE, finishedAt: sourceRun.finishedAt || finishedAt }
          : sourceRun
      ))
      : run.sources
  };
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
  totals.reindexQueued += result.reindexQueued || 0;
  totals.reindexRetried += result.reindexRetried || 0;
  totals.reindexResolved += result.reindexResolved || 0;
  totals.reindexUnresolved += result.reindexUnresolved || 0;
  totals.reindexFailed += result.reindexFailed || 0;
  totals.reindexRecoveredErrors += result.reindexRecoveredErrors || 0;
}

function throwIfAborted(signal) {
  if (!signal?.aborted) return;
  const error = new Error("Индексация остановлена");
  error.name = "AbortError";
  throw error;
}

function isAbortError(error, signal) {
  return signal?.aborted || error?.name === "AbortError" || /aborted|cancelled|остановлена/i.test(String(error?.message || ""));
}

export async function runDailyIndexAgent({
  trigger = "manual",
  force = agentForceDefault(),
  dryRun = false,
  onProgress = () => {},
  signal = null,
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
      unreadableDirectories: 0,
      reindexQueued: 0,
      reindexRetried: 0,
      reindexResolved: 0,
      reindexUnresolved: 0,
      reindexFailed: 0,
      reindexRecoveredErrors: 0
    }
  };

  try {
    throwIfAborted(signal);
    await persistRun(run);
    const sources = await readSources();
    run.totals.sources = sources.length;
    await persistRun(run);
    onProgress({ phase: "sources", message: "Sources loaded", total: sources.length });
    throwIfAborted(signal);

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
      throwIfAborted(signal);
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
            currentFileTitle: progress.currentFileTitle,
            currentFileRelativePath: progress.currentFileRelativePath,
            currentFileExtension: progress.currentFileExtension,
            ocrPage: progress.ocrPage,
            ocrPages: progress.ocrPages,
            ocrTotalPages: progress.ocrTotalPages,
            vectorsProcessed: progress.vectorsProcessed,
            vectorsTotal: progress.vectorsTotal,
            reindexQueued: progress.reindexQueued,
            reindexRetried: progress.reindexRetried,
            reindexResolved: progress.reindexResolved,
            reindexUnresolved: progress.reindexUnresolved,
            reindexFailed: progress.reindexFailed,
            updatedAt: new Date().toISOString()
          });
          persistRun(run).catch(() => {});
          onProgress({ ...progress, sourceId: source.id, sourceTitle: source.title });
        }, {
          force,
          signal,
          googleContextSessionFetch
        });

        Object.assign(sourceRun, result, {
          status: "completed",
          finishedAt: new Date().toISOString()
        });
        addTotals(run.totals, result);
      } catch (error) {
        if (isAbortError(error, signal)) {
          Object.assign(sourceRun, {
            status: "cancelled",
            message: "Индексация остановлена",
            finishedAt: new Date().toISOString()
          });
          run.status = "cancelled";
          run.message = "Индексация остановлена";
          run.finishedAt = new Date().toISOString();
          await persistRun(run);
          throw error;
        }

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
    run.status = isAbortError(error, signal) ? "cancelled" : "failed";
    run.message = isAbortError(error, signal) ? "Индексация остановлена" : error.message;
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

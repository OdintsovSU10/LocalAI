import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import "dotenv/config";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const projectRoot = path.resolve(__dirname, "../../..");
export const configPath = path.join(projectRoot, "config", "sources.yaml");
export const settingsPath = path.join(projectRoot, "config", "settings.json");
const defaultLocalRagDataDir = "D:\\LOCAL_RAG\\data";
const legacyRepoDataDir = path.join(projectRoot, "data");

function normalizeComparablePath(value = "") {
  return path.resolve(String(value || "")).replace(/[\\/]+$/, "").toLowerCase();
}

export function defaultDataDir() {
  return path.resolve(defaultLocalRagDataDir);
}

export function isLegacyDefaultDataDir(value = "") {
  if (!String(value || "").trim()) return false;
  const normalized = normalizeComparablePath(value);
  if (normalized === normalizeComparablePath(legacyRepoDataDir)) return true;
  return /[\\/]desktop[\\/]local_rag[\\/]data$/i.test(normalized);
}

export function resolveDataDirSetting(value = "") {
  const configured = String(value || "").trim();
  if (!configured || isLegacyDefaultDataDir(configured)) return defaultDataDir();
  return path.resolve(configured);
}

export function dataDir() {
  if (process.env.RAG_DATA_DIR) return resolveDataDirSetting(process.env.RAG_DATA_DIR);

  try {
    const settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
    if (settings.dataDir) return resolveDataDirSetting(settings.dataDir);
  } catch {
    // Missing or invalid settings should not prevent the app from starting.
  }

  return defaultDataDir();
}

export function stateDir() {
  return path.join(dataDir(), "state");
}

export function markdownCacheDir() {
  return path.join(dataDir(), "md-cache");
}

export function manifestPath() {
  return path.join(stateDir(), "manifest.json");
}

export function chunksPath() {
  return path.join(stateDir(), "chunks.json");
}

export function sourceSummariesPath() {
  return path.join(stateDir(), "source-summaries.json");
}

export function metadataSqlitePath() {
  return path.join(stateDir(), "metadata.sqlite");
}

export function vectorsPath() {
  return path.join(stateDir(), "vectors.json");
}

export function jobsPath() {
  return path.join(stateDir(), "jobs.json");
}

export function agentRunsPath() {
  return path.join(stateDir(), "agent-runs.json");
}

export function auditRunsPath() {
  return path.join(stateDir(), "audit-runs.json");
}

export function indexLockPath() {
  return path.join(stateDir(), "index.lock");
}

export function agentLockPath() {
  return path.join(stateDir(), "daily-agent.lock");
}

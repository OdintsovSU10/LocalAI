import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { projectRoot } from "./paths.js";

const execFileAsync = promisify(execFile);
export const defaultManagedQdrantBaseUrl = "http://127.0.0.1:6333";

function stripTrailingSlash(value = "") {
  return String(value || "").replace(/\/$/, "");
}

function isLoopbackHost(hostname = "") {
  return new Set(["127.0.0.1", "localhost", "::1", "[::1]"]).has(String(hostname || "").toLowerCase());
}

function normalizeQdrantBaseUrl(vectorStore = {}) {
  const qdrant = vectorStore.qdrant || {};
  let url;
  try {
    url = new URL(qdrant.url || defaultManagedQdrantBaseUrl);
  } catch {
    url = new URL(defaultManagedQdrantBaseUrl);
  }

  url.pathname = "/";
  url.search = "";
  url.hash = "";
  return stripTrailingSlash(url.toString());
}

export function managedQdrantSettings(vectorStore = {}) {
  const baseUrl = normalizeQdrantBaseUrl(vectorStore);
  const url = new URL(baseUrl);
  const port = Number(url.port || (url.protocol === "https:" ? 443 : 80));
  const local = isLoopbackHost(url.hostname);
  return {
    baseUrl,
    port,
    local,
    manageable: process.platform === "win32" && local && port === 6333
  };
}

async function fetchJsonWithTimeout(url, timeoutMs = 1500) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      cache: "no-store"
    });
    const payload = await response.json().catch(() => ({}));
    return {
      ok: response.ok,
      status: response.status,
      payload
    };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      payload: null,
      error: error.message
    };
  } finally {
    clearTimeout(timeout);
  }
}

export async function managedQdrantStatus(vectorStore = {}) {
  const settings = managedQdrantSettings(vectorStore);
  const health = await fetchJsonWithTimeout(`${settings.baseUrl}/`);
  return {
    ok: true,
    running: Boolean(health.ok),
    state: health.ok ? "running" : "stopped",
    manageable: settings.manageable,
    local: settings.local,
    baseUrl: settings.baseUrl,
    port: settings.port,
    version: health.payload?.version || "",
    error: health.ok ? "" : (health.error || "")
  };
}

export async function waitForManagedQdrant(vectorStore = {}, expectedRunning = true, timeoutMs = 12000) {
  const startedAt = Date.now();
  let status = await managedQdrantStatus(vectorStore);

  while (Date.now() - startedAt < timeoutMs) {
    if (status.running === expectedRunning) return status;
    await new Promise((resolve) => setTimeout(resolve, 600));
    status = await managedQdrantStatus(vectorStore);
  }

  return status;
}

async function runQdrantScript(scriptName) {
  const scriptPath = path.join(projectRoot, "scripts", scriptName);
  const { stdout, stderr } = await execFileAsync("powershell.exe", [
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    scriptPath
  ], {
    cwd: projectRoot,
    windowsHide: true,
    timeout: 30000,
    maxBuffer: 1024 * 256
  });
  return { stdout, stderr };
}

export async function startManagedQdrant(vectorStore = {}) {
  const status = await managedQdrantStatus(vectorStore);
  if (status.running) return { ...status, starting: false, alreadyRunning: true };

  const settings = managedQdrantSettings(vectorStore);
  if (!settings.manageable) {
    throw new Error("Managed Qdrant start is available only for local Windows Qdrant at port 6333");
  }

  await runQdrantScript("start-qdrant-windows.ps1");
  const nextStatus = await waitForManagedQdrant(vectorStore, true, 12000);
  return {
    ...nextStatus,
    starting: !nextStatus.running
  };
}

export async function stopManagedQdrant(vectorStore = {}) {
  const settings = managedQdrantSettings(vectorStore);
  if (!settings.manageable) {
    throw new Error("Managed Qdrant stop is available only for local Windows Qdrant at port 6333");
  }

  await runQdrantScript("stop-qdrant-windows.ps1");
  return waitForManagedQdrant(vectorStore, false, 7000);
}

export async function restartManagedQdrant(vectorStore = {}) {
  const settings = managedQdrantSettings(vectorStore);
  if (!settings.manageable) {
    throw new Error("Managed Qdrant restart is available only for local Windows Qdrant at port 6333");
  }

  await stopManagedQdrant(vectorStore);
  return startManagedQdrant(vectorStore);
}

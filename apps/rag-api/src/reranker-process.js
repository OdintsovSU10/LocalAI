import path from "node:path";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { projectRoot } from "./paths.js";
import { rerankerSettings } from "./reranker.js";

const execFileAsync = promisify(execFile);
export const defaultManagedRerankerBaseUrl = "http://127.0.0.1:8080";
export const defaultManagedRerankerModel = "BAAI/bge-reranker-v2-m3";

function stripTrailingSlash(value = "") {
  return String(value || "").replace(/\/$/, "");
}

function normalizeHealthBaseUrl(rawBaseUrl = defaultManagedRerankerBaseUrl) {
  const fallback = new URL(defaultManagedRerankerBaseUrl);
  let url;
  try {
    url = new URL(rawBaseUrl || defaultManagedRerankerBaseUrl);
  } catch {
    url = fallback;
  }

  if (url.pathname.replace(/\/$/, "").endsWith("/rerank")) {
    url.pathname = url.pathname.replace(/\/rerank\/?$/, "") || "/";
  }

  url.search = "";
  url.hash = "";
  return stripTrailingSlash(url.toString());
}

function isLoopbackHost(hostname = "") {
  return new Set(["127.0.0.1", "localhost", "::1", "[::1]"]).has(String(hostname || "").toLowerCase());
}

export function managedRerankerSettings(reranker = {}) {
  const settings = rerankerSettings(reranker);
  const configuredBaseUrl = stripTrailingSlash(settings.baseUrl || "");
  const healthBaseUrl = normalizeHealthBaseUrl(configuredBaseUrl || defaultManagedRerankerBaseUrl);
  const url = new URL(healthBaseUrl);
  const port = Number(url.port || (url.protocol === "https:" ? 443 : 80));
  const local = isLoopbackHost(url.hostname);
  const model = configuredBaseUrl ? settings.model : defaultManagedRerankerModel;

  return {
    ...settings,
    baseUrl: configuredBaseUrl || defaultManagedRerankerBaseUrl,
    healthBaseUrl,
    healthUrl: `${healthBaseUrl}/health`,
    endpoint: `${healthBaseUrl}/rerank`,
    model,
    port,
    local,
    manageable: process.platform === "win32" && local && Number.isInteger(port) && port > 0
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
      ok: response.ok && payload?.ok !== false,
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

export async function managedRerankerStatus(reranker = {}) {
  const settings = managedRerankerSettings(reranker);
  const health = await fetchJsonWithTimeout(settings.healthUrl);
  return {
    ok: true,
    running: Boolean(health.ok),
    state: health.ok ? "running" : "stopped",
    manageable: settings.manageable,
    local: settings.local,
    baseUrl: settings.healthBaseUrl,
    endpoint: settings.endpoint,
    healthUrl: settings.healthUrl,
    model: health.payload?.model || settings.model,
    loaded: Array.isArray(health.payload?.loaded) ? health.payload.loaded : [],
    port: settings.port,
    error: health.ok ? "" : (health.error || "")
  };
}

export async function waitForManagedReranker(reranker = {}, expectedRunning = true, timeoutMs = 12000) {
  const startedAt = Date.now();
  let status = await managedRerankerStatus(reranker);

  while (Date.now() - startedAt < timeoutMs) {
    if (status.running === expectedRunning) return status;
    await new Promise((resolve) => setTimeout(resolve, 600));
    status = await managedRerankerStatus(reranker);
  }

  return status;
}

export async function startManagedReranker(reranker = {}) {
  const status = await managedRerankerStatus(reranker);
  if (status.running) return { ...status, starting: false, alreadyRunning: true };

  const settings = managedRerankerSettings(reranker);
  if (!settings.manageable) {
    throw new Error("Managed reranker start is available only for local Windows reranker URLs");
  }

  const scriptPath = path.join(projectRoot, "scripts", "start-reranker-windows.ps1");
  const child = spawn("powershell.exe", [
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    scriptPath,
    "-Model",
    settings.model,
    "-Port",
    String(settings.port)
  ], {
    cwd: projectRoot,
    env: process.env,
    detached: true,
    stdio: "ignore",
    windowsHide: true
  });
  child.unref();

  return {
    ...status,
    state: "starting",
    starting: true,
    pid: child.pid || 0
  };
}

async function stopRerankerProcesses(port) {
  const servicePath = path.join(projectRoot, "scripts", "reranker-service.py");
  const script = `
$ErrorActionPreference = "SilentlyContinue"
$port = [int]$args[0]
$servicePath = [string]$args[1]
$processIds = @()
try {
  $processIds += Get-NetTCPConnection -LocalPort $port -State Listen | Select-Object -ExpandProperty OwningProcess
} catch {}
try {
  $processIds += Get-CimInstance Win32_Process | Where-Object {
    $_.CommandLine -and $_.CommandLine -like "*reranker-service.py*"
  } | ForEach-Object { $_.ProcessId }
} catch {}
$processIds = @($processIds | Where-Object { $_ } | Sort-Object -Unique)
$stopped = @()
foreach ($processId in $processIds) {
  try {
    $proc = Get-CimInstance Win32_Process -Filter "ProcessId=$processId"
    $commandLine = [string]$proc.CommandLine
    if ($commandLine -like "*reranker-service.py*" -or $commandLine -like "*$servicePath*") {
      Stop-Process -Id $processId -Force
      $stopped += $processId
    }
  } catch {}
}
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
@{ stopped = $stopped; count = $stopped.Count } | ConvertTo-Json -Compress
`;

  const { stdout } = await execFileAsync("powershell.exe", [
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-Command",
    script,
    String(port),
    servicePath
  ], {
    cwd: projectRoot,
    windowsHide: true,
    timeout: 10000,
    maxBuffer: 1024 * 128
  });

  try {
    return JSON.parse(stdout || "{}");
  } catch {
    return { stopped: [], count: 0 };
  }
}

export async function stopManagedReranker(reranker = {}) {
  const settings = managedRerankerSettings(reranker);
  if (!settings.manageable) {
    throw new Error("Managed reranker stop is available only for local Windows reranker URLs");
  }

  const stopped = await stopRerankerProcesses(settings.port);
  const status = await waitForManagedReranker(reranker, false, 7000);
  return {
    ...status,
    stopped: stopped.stopped || [],
    stoppedCount: Number(stopped.count || 0)
  };
}

export async function restartManagedReranker(reranker = {}) {
  const settings = managedRerankerSettings(reranker);
  if (!settings.manageable) {
    throw new Error("Managed reranker restart is available only for local Windows reranker URLs");
  }

  await stopManagedReranker(reranker);
  await waitForManagedReranker(reranker, false, 3000);
  return startManagedReranker(reranker);
}

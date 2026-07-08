import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";

function errorWithStatus(message, statusCode, code = "") {
  const error = new Error(message);
  error.statusCode = statusCode;
  if (code) error.code = code;
  return error;
}

function psString(value) {
  return String(value || "").replaceAll("'", "''");
}

function runPowerShell(script) {
  return new Promise((resolve, reject) => {
    const encoded = Buffer.from(script, "utf16le").toString("base64");
    execFile(
      "powershell.exe",
      ["-NoProfile", "-EncodedCommand", encoded],
      { windowsHide: true, timeout: 15000 },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(stderr?.trim() || error.message));
          return;
        }
        resolve(stdout.trim());
      }
    );
  });
}

function runExecutable(command, args = [], options = {}) {
  return new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      { windowsHide: true, timeout: 15000, ...options },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(stderr?.trim() || error.message));
          return;
        }
        resolve(stdout.trim());
      }
    );
  });
}

async function resolveExistingFile(filePath) {
  const rawPath = String(filePath || "").trim();
  if (!rawPath) throw errorWithStatus("file path is required", 400, "ENOENT");

  const normalized = path.resolve(rawPath);
  let stat;
  try {
    stat = await fs.stat(normalized);
  } catch (error) {
    if (error?.code === "ENOENT") throw errorWithStatus("file not found", 404, "ENOENT");
    throw error;
  }

  if (!stat.isFile()) throw errorWithStatus("target is not a file", 400);
  return normalized;
}

function normalizeRoot(rootPath) {
  return path.win32.normalize(rootPath);
}

function isRoot(folderPath) {
  const normalized = path.win32.normalize(folderPath);
  const parsed = path.win32.parse(normalized);
  return normalized.toLowerCase() === parsed.root.toLowerCase();
}

export async function listRoots() {
  const script = `
$ErrorActionPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$drives = Get-PSDrive -PSProvider FileSystem | ForEach-Object {
  [pscustomobject]@{
    name = $_.Name
    path = $_.Root
    label = if ($_.DisplayRoot) { "$($_.Name): $($_.DisplayRoot)" } else { "$($_.Name): $($_.Root)" }
    kind = 'drive'
  }
}
$mappings = Get-SmbMapping -ErrorAction SilentlyContinue | Where-Object { -not $_.LocalPath -and $_.RemotePath } | ForEach-Object {
  [pscustomobject]@{
    name = $_.RemotePath
    path = $_.RemotePath
    label = $_.RemotePath
    kind = 'network'
  }
}
@($drives + $mappings) | ConvertTo-Json -Compress
`;

  const output = await runPowerShell(script);
  const parsed = output ? JSON.parse(output) : [];
  const roots = (Array.isArray(parsed) ? parsed : [parsed])
    .filter((item) => item?.path)
    .map((item) => ({
      name: item.name,
      label: item.label || item.path,
      path: normalizeRoot(item.path),
      kind: item.kind || "drive"
    }));

  const seen = new Set();
  return roots.filter((root) => {
    const key = root.path.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export async function listFolders(folderPath) {
  const normalized = path.win32.normalize(folderPath);
  const stat = await fs.stat(normalized);
  if (!stat.isDirectory()) throw new Error("Path is not a directory");

  const entries = await fs.readdir(normalized, { withFileTypes: true });
  const folders = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name === "." || entry.name === "..") continue;
    const childPath = path.win32.join(normalized, entry.name);
    folders.push({
      name: entry.name,
      path: childPath
    });
  }

  folders.sort((a, b) => a.name.localeCompare(b.name, "ru", { sensitivity: "base" }));

  return {
    path: normalized,
    parent: isRoot(normalized) ? "" : path.win32.dirname(normalized),
    folders
  };
}

export async function openFileInSystem(filePath) {
  const targetPath = await resolveExistingFile(filePath);

  if (process.platform === "win32") {
    await runPowerShell(`
$ErrorActionPreference = 'Stop'
Invoke-Item -LiteralPath '${psString(targetPath)}'
`);
  } else if (process.platform === "darwin") {
    await runExecutable("open", [targetPath]);
  } else {
    await runExecutable("xdg-open", [targetPath]);
  }

  return { path: targetPath };
}

export async function revealFileInSystem(filePath) {
  const targetPath = await resolveExistingFile(filePath);

  if (process.platform === "win32") {
    await runExecutable("explorer.exe", [`/select,${targetPath}`], { windowsHide: false });
  } else if (process.platform === "darwin") {
    await runExecutable("open", ["-R", targetPath]);
  } else {
    await runExecutable("xdg-open", [path.dirname(targetPath)]);
  }

  return { path: targetPath };
}

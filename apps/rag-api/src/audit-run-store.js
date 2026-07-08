import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { auditRunsPath } from "./paths.js";

const MAX_RUNS = 50;

async function readRunsFile() {
  const filePath = auditRunsPath();
  try {
    const text = await fs.readFile(filePath, "utf8");
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch (error) {
    if (error.code === "ENOENT") return {};
    throw error;
  }
}

async function writeRunsFile(runs) {
  const filePath = auditRunsPath();
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const ordered = Object.keys(runs)
    .sort((left, right) => String(runs[right]?.startedAt || "").localeCompare(String(runs[left]?.startedAt || "")));
  for (const id of ordered.slice(MAX_RUNS)) delete runs[id];
  await fs.writeFile(filePath, JSON.stringify(runs, null, 2), "utf8");
}

export async function createAuditRun(report = {}) {
  const runs = await readRunsFile();
  const runId = report.runId || crypto.randomUUID();
  const next = {
    runId,
    startedAt: report.startedAt || new Date().toISOString(),
    finishedAt: null,
    status: "running",
    totals: {
      tendersChecked: 0,
      findings: 0,
      critical: 0,
      high: 0,
      medium: 0,
      low: 0,
      needsReview: 0
    },
    tenderReports: [],
    checkpoint: null,
    ...report
  };
  runs[runId] = next;
  await writeRunsFile(runs);
  return next;
}

export async function saveAuditRun(report) {
  const runs = await readRunsFile();
  runs[report.runId] = report;
  await writeRunsFile(runs);
  return report;
}

export async function getAuditRun(runId) {
  const runs = await readRunsFile();
  return runs[String(runId || "")] || null;
}

export async function updateAuditCheckpoint(report, lastTenderIndex) {
  report.checkpoint = {
    lastTenderIndex,
    updatedAt: new Date().toISOString()
  };
  return saveAuditRun(report);
}

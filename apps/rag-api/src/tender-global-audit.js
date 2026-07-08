import {
  createAuditRun,
  getAuditRun,
  saveAuditRun,
  updateAuditCheckpoint
} from "./audit-run-store.js";
import { matchTenderToRagSource } from "./tender-audit-match.js";
import { runTenderPriceAudit } from "./tender-price-audit.js";
import { readChunks, readSources } from "./store.js";

function severityBucket(severity = "") {
  switch (severity) {
    case "error": return "high";
    case "warning": return "medium";
    case "needs_review": return "low";
    default: return "low";
  }
}

export function aggregateGlobalTotals(tenderReports = []) {
  const totals = {
    tendersChecked: tenderReports.length,
    findings: 0,
    critical: 0,
    high: 0,
    medium: 0,
    low: 0,
    needsReview: 0
  };

  for (const report of tenderReports) {
    if (report.needsReview) totals.needsReview += 1;
    for (const finding of report.findings || []) {
      totals.findings += 1;
      if (finding.severity === "needs_review" || finding.needsReview) totals.needsReview += 1;
      const bucket = severityBucket(finding.severity);
      totals[bucket] += 1;
    }
  }
  return totals;
}

function globalStatusFromTotals(totals = {}) {
  if (totals.high > 0) return "error";
  if (totals.medium > 0 || totals.low > 0) return "warning";
  if (totals.needsReview > 0) return "needs_review";
  return "ok";
}

function mapPriceFinding(finding = {}, tender = {}, match = {}) {
  return {
    severity: finding.severity,
    category: "price_match",
    fieldPath: finding.field || "",
    dbValue: finding.dbValue ?? null,
    expectedValue: finding.expectedValue ?? null,
    delta: finding.delta ?? null,
    confidence: finding.confidence ?? 0,
    rationale: finding.rationale || "",
    evidence: finding.evidence || [],
    needsReview: finding.severity === "needs_review",
    ragSourceId: match.ragSource?.id || "",
    hubTenderId: tender.id || ""
  };
}

export async function executeGlobalAudit(run, {
  adapter,
  includeArchived = false,
  maxTenders = 0,
  tenderIds = [],
  tolerancePercent = 1,
  readSourcesFn = readSources,
  readChunksFn = readChunks,
  onProgress = () => {}
} = {}) {
  const sources = await readSourcesFn();
  const tenders = await adapter.listTendersForAudit({
    includeArchived,
    limit: maxTenders > 0 ? maxTenders : 10_000,
    tenderIds
  });

  const startIndex = run.checkpoint?.lastTenderIndex >= 0
    ? run.checkpoint.lastTenderIndex + 1
    : 0;
  if (!Array.isArray(run.tenderReports)) run.tenderReports = [];

  for (let index = startIndex; index < tenders.length; index += 1) {
    const tender = tenders[index];
    const match = matchTenderToRagSource(tender, sources);
    const priceReport = await runTenderPriceAudit({
      sourceId: match.ragSource?.id || "",
      tenderNumber: tender.tenderNumber,
      hubTenderId: tender.id,
      tolerancePercent,
      adapter,
      readSourcesFn,
      readChunksFn
    });

    const tenderReport = {
      tenderId: tender.id,
      title: tender.title,
      hubTenderNumber: tender.tenderNumber,
      needsReview: priceReport.status === "needs_review" || match.confidence === "none",
      dbMatch: {
        sourceId: tender.id,
        strategy: "postgresql",
        confidence: "exact"
      },
      ragMatch: {
        sourceId: match.ragSource?.id || "",
        strategy: match.strategy,
        confidence: match.confidence,
        score: match.score,
        note: match.note || ""
      },
      priceAudit: {
        status: priceReport.status,
        checkedAt: priceReport.checkedAt,
        meta: priceReport.meta
      },
      findings: (priceReport.findings || []).map((finding) => mapPriceFinding(finding, tender, match))
    };

    if (match.confidence === "none") {
      tenderReport.findings.push({
        severity: "needs_review",
        category: "rag_match",
        fieldPath: `tenders.${tender.id}.rag_match`,
        confidence: 0,
        rationale: match.note,
        evidence: [],
        needsReview: true
      });
      tenderReport.needsReview = true;
    }

    if (index < run.tenderReports.length) run.tenderReports[index] = tenderReport;
    else run.tenderReports.push(tenderReport);

    run.totals = aggregateGlobalTotals(run.tenderReports);
    await updateAuditCheckpoint(run, index);
    onProgress({
      index: index + 1,
      total: tenders.length,
      tenderId: tender.id,
      status: priceReport.status
    });
  }

  run.finishedAt = new Date().toISOString();
  run.status = globalStatusFromTotals(run.totals);
  run.totals = aggregateGlobalTotals(run.tenderReports);
  await saveAuditRun(run);
  return run;
}

export async function startGlobalTenderAudit({
  resumeRunId = "",
  includeArchived = false,
  maxTenders = 0,
  tenderIds = [],
  tolerancePercent = 1,
  adapter,
  readSourcesFn = readSources,
  readChunksFn = readChunks,
  runInBackground = true
} = {}) {
  let run = resumeRunId ? await getAuditRun(resumeRunId) : null;
  if (run && run.status === "completed") return run;
  if (!run) {
    run = await createAuditRun({
      status: "running",
      options: { includeArchived, maxTenders, tenderIds, tolerancePercent }
    });
  } else {
    run.status = "running";
    await saveAuditRun(run);
  }

  const execute = () => executeGlobalAudit(run, {
    adapter,
    includeArchived,
    maxTenders,
    tenderIds,
    tolerancePercent,
    readSourcesFn,
    readChunksFn
  }).catch(async (error) => {
    run.status = "failed";
    run.error = String(error.message || error);
    run.finishedAt = new Date().toISOString();
    await saveAuditRun(run);
  });

  if (runInBackground) {
    queueMicrotask(execute);
    return run;
  }
  return execute();
}

export async function getGlobalTenderAuditRun(runId) {
  return getAuditRun(runId);
}

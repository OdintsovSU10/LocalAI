import path from "node:path";

// Every metric is reported explicitly: either computed from a non-empty denominator,
// or NOT_AVAILABLE with a reason. A metric that is neither is a runner failure.
export const METRIC_OK = "ok";
export const METRIC_NOT_AVAILABLE = "not_available";

const ANSWER_STAGE_REASON = "requires answer/verifier pipeline (Stage 07); retrieval-only runner";

export function metricValue(numerator, denominator, emptyReason) {
  if (!denominator) return { status: METRIC_NOT_AVAILABLE, value: null, numerator, denominator, reason: emptyReason };
  return { status: METRIC_OK, value: numerator / denominator, numerator, denominator };
}

function notAvailable(reason) {
  return { status: METRIC_NOT_AVAILABLE, value: null, reason };
}

export function normalizeEvidenceText(value) {
  return String(value || "")
    .toLowerCase()
    .replaceAll("ё", "е")
    .replace(/[ \s]+/g, " ")
    .trim();
}

function fileMatches(result, evidence) {
  if (evidence.sourceId && result.sourceId !== evidence.sourceId) return false;
  return path.basename(String(result.path || "")).toLowerCase() === evidence.file.toLowerCase();
}

function textMatches(result, evidence) {
  return !evidence.includes || normalizeEvidenceText(result.text).includes(normalizeEvidenceText(evidence.includes));
}

function inRange(value, start, end) {
  if (start === undefined || start === null) return false;
  return value >= start && value <= (end ?? start);
}

export function hasLocation(evidence) {
  return evidence.page !== null || evidence.row !== null || Boolean(evidence.sheet) || Boolean(evidence.section);
}

export function locationMatches(target = {}, evidence) {
  if (evidence.page !== null && !inRange(evidence.page, target.pageStart, target.pageEnd)) return false;
  if (evidence.row !== null && !inRange(evidence.row, target.rowStart, target.rowEnd)) return false;
  if (evidence.sheet && normalizeEvidenceText(target.sheetName) !== normalizeEvidenceText(evidence.sheet)) return false;
  if (evidence.section && !normalizeEvidenceText(target.sectionTitle).includes(normalizeEvidenceText(evidence.section))) return false;
  return true;
}

// mode "file": only the right file; "content": file + text; "exact": file + text + citation location.
export function evidenceMatches(result, evidence, mode = "exact") {
  if (!fileMatches(result, evidence)) return false;
  if (mode === "file") return true;
  if (!textMatches(result, evidence)) return false;
  if (mode === "content") return true;
  return locationMatches(result.citationTarget, evidence);
}

export function evidenceRank(results, evidence, mode = "exact") {
  const match = results.find((result) => evidenceMatches(result, evidence, mode));
  return match ? match.rank : null;
}

function withinTopK(rank, topK) {
  return rank !== null && rank <= topK;
}

function sameIdSet(left = [], right = []) {
  if (left.length !== right.length) return false;
  const set = new Set(left);
  return right.every((item) => set.has(item));
}

export function projectSelectionCorrect(testCase, retrieval) {
  const { expected } = testCase;
  if (expected.allSources) return retrieval.scope.searchAllSources;
  if (retrieval.scope.searchAllSources) return false;
  return sameIdSet([retrieval.scope.sourceId].filter(Boolean), expected.sourceIds);
}

export function computeProductMetrics(rows = []) {
  const evidenceItems = [];
  for (const row of rows) {
    for (const evidence of row.testCase.expected.evidence || []) {
      evidenceItems.push({ row, evidence });
    }
  }

  const exactRanks = evidenceItems.map(({ row, evidence }) => evidenceRank(row.retrieval.results, evidence, "exact"));
  const fileRanks = evidenceItems.map(({ row, evidence }) => evidenceRank(row.retrieval.results, evidence, "file"));
  const count = (ranks, topK) => ranks.filter((rank) => withinTopK(rank, topK)).length;
  const noEvidenceReason = "no expected evidence in eval set";

  const evidenceCases = rows.filter((row) => (row.testCase.expected.evidence || []).length);
  const reciprocalRankSum = evidenceCases.reduce((sum, row) => {
    const ranks = row.testCase.expected.evidence
      .map((evidence) => evidenceRank(row.retrieval.results, evidence, "exact"))
      .filter((rank) => rank !== null);
    return sum + (ranks.length ? 1 / Math.min(...ranks) : 0);
  }, 0);

  const scopedRows = rows.filter((row) => row.testCase.expected.status !== "clarification_required");
  const selectionCorrect = scopedRows.filter((row) => projectSelectionCorrect(row.testCase, row.retrieval)).length;

  const clarificationExpected = rows.filter((row) => row.testCase.expected.status === "clarification_required");
  const clarificationPredicted = rows.filter((row) => row.retrieval.clarificationPredicted);
  const clarificationTruePositive = clarificationExpected.filter((row) => row.retrieval.clarificationPredicted).length;

  const locatedItems = evidenceItems.filter(({ evidence }) => hasLocation(evidence));
  const locatedFound = locatedItems
    .map(({ row, evidence }) => ({
      evidence,
      result: row.retrieval.results.find((result) => result.rank <= 5 && evidenceMatches(result, evidence, "content"))
    }))
    .filter((item) => item.result);
  const locatedCorrect = locatedFound.filter(({ result, evidence }) => locationMatches(result.citationTarget, evidence)).length;

  const versionRows = rows.filter((row) => row.testCase.expected.staleEvidence.length);
  const versionCorrect = versionRows.filter((row) => {
    const currentRanks = row.testCase.expected.evidence.map((evidence) => evidenceRank(row.retrieval.results, evidence, "exact"));
    if (currentRanks.some((rank) => rank === null)) return false;
    const bestCurrent = Math.min(...currentRanks);
    return row.testCase.expected.staleEvidence.every((stale) => {
      const staleRank = evidenceRank(row.retrieval.results, stale, "content");
      return staleRank === null || bestCurrent < staleRank;
    });
  }).length;

  const leakRows = rows.filter((row) => !row.testCase.expected.allSources && row.testCase.expected.sourceIds.length);
  const leaked = leakRows.filter((row) => {
    const allowed = new Set(row.testCase.expected.sourceIds);
    return row.retrieval.results.some((result) => result.rank <= 5 && !allowed.has(result.sourceId));
  }).length;

  return {
    retrieval: {
      recallAt5: metricValue(count(exactRanks, 5), evidenceItems.length, noEvidenceReason),
      recallAt10: metricValue(count(exactRanks, 10), evidenceItems.length, noEvidenceReason),
      fileRecallAt5: metricValue(count(fileRanks, 5), evidenceItems.length, noEvidenceReason),
      mrr: evidenceCases.length
        ? { status: METRIC_OK, value: reciprocalRankSum / evidenceCases.length, numerator: reciprocalRankSum, denominator: evidenceCases.length }
        : notAvailable(noEvidenceReason),
      projectSelectionAccuracy: metricValue(selectionCorrect, scopedRows.length, "no cases with expected project scope"),
      wrongProjectLeakRateAt5: metricValue(leaked, leakRows.length, "no single-project cases"),
      citationTargetAccuracy: metricValue(locatedCorrect, locatedFound.length, "no located evidence found in top 5"),
      currentVersionAccuracy: metricValue(versionCorrect, versionRows.length, "no amendment/version cases")
    },
    clarification: {
      precision: metricValue(clarificationTruePositive, clarificationPredicted.length, "system predicted no clarifications"),
      recall: metricValue(clarificationTruePositive, clarificationExpected.length, "no clarification cases")
    },
    answer: {
      materialClaimSupportRate: notAvailable(ANSWER_STAGE_REASON),
      numericFidelity: notAvailable(ANSWER_STAGE_REASON),
      noAnswerHallucinationRate: notAvailable(ANSWER_STAGE_REASON)
    },
    verifier: {
      falsePassRate: notAvailable(ANSWER_STAGE_REASON),
      falseRejectRate: notAvailable(ANSWER_STAGE_REASON)
    }
  };
}

// Returns names of metrics that are neither computed nor explicitly NOT_AVAILABLE with a reason.
export function silentMetricFailures(metrics) {
  const failures = [];
  for (const [group, values] of Object.entries(metrics || {})) {
    for (const [name, metric] of Object.entries(values || {})) {
      const ok = metric?.status === METRIC_OK && Number.isFinite(metric.value);
      const declared = metric?.status === METRIC_NOT_AVAILABLE && Boolean(metric.reason);
      if (!ok && !declared) failures.push(`${group}.${name}`);
    }
  }
  return failures;
}

// Metrics that must be computable on the committed corpus; NOT_AVAILABLE there means the eval set lost coverage.
export const REQUIRED_RETRIEVAL_METRICS = [
  "retrieval.recallAt5",
  "retrieval.recallAt10",
  "retrieval.fileRecallAt5",
  "retrieval.mrr",
  "retrieval.projectSelectionAccuracy",
  "retrieval.wrongProjectLeakRateAt5",
  "retrieval.citationTargetAccuracy",
  "retrieval.currentVersionAccuracy",
  "clarification.recall"
];

export function missingRequiredMetrics(metrics) {
  return REQUIRED_RETRIEVAL_METRICS.filter((name) => {
    const [group, key] = name.split(".");
    return metrics?.[group]?.[key]?.status !== METRIC_OK;
  });
}

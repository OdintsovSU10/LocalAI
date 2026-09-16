import fs from "node:fs/promises";
import path from "node:path";

export const PRODUCT_EVAL_SCHEMA_VERSION = "product-v2/1";

// The 15 case classes of the Product V2 eval contract (Stage 01).
export const CASE_CLASSES = [
  "exact_fact",
  "amount_percent_date_period",
  "multi_condition_clause",
  "broad_overview",
  "no_answer",
  "ambiguous_project",
  "follow_up",
  "multiple_documents",
  "conflicting_values",
  "amendment_supersedes",
  "wrong_project_negative",
  "citation_exactness",
  "spreadsheet_row",
  "ocr_page",
  "all_projects_aggregate"
];

export const ANSWER_STATUSES = [
  "verified",
  "verified_with_conflict",
  "clarification_required",
  "insufficient_evidence",
  "system_error"
];

function stringList(value) {
  return Array.isArray(value) ? value.map((item) => String(item || "").trim()).filter(Boolean) : [];
}

function optionalNumber(value) {
  if (value === undefined || value === null || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : Number.NaN;
}

function normalizeEvidence(raw = {}) {
  return {
    sourceId: String(raw.sourceId || "").trim(),
    file: String(raw.file || "").trim(),
    includes: String(raw.includes || "").trim(),
    section: String(raw.section || "").trim(),
    sheet: String(raw.sheet || "").trim(),
    page: optionalNumber(raw.page),
    row: optionalNumber(raw.row)
  };
}

export function normalizeProductCase(raw, fileName = "", index = 0) {
  const item = raw && typeof raw === "object" ? raw : {};
  const expected = item.expected && typeof item.expected === "object" ? item.expected : {};
  const request = item.request && typeof item.request === "object" ? item.request : {};
  const answer = expected.answer && typeof expected.answer === "object" ? expected.answer : {};
  return {
    id: String(item.id || `${path.basename(fileName, ".json")}-${index + 1}`),
    fileName,
    class: String(item.class || "").trim(),
    question: String(item.question || "").trim(),
    request: {
      sourceId: String(request.sourceId || "").trim(),
      contextSourceId: String(request.contextSourceId || "").trim()
    },
    history: Array.isArray(item.history)
      ? item.history.map((turn) => ({ question: String(turn?.question || "").trim() })).filter((turn) => turn.question)
      : [],
    expected: {
      status: String(expected.status || "").trim(),
      sourceIds: stringList(expected.sourceIds),
      allSources: expected.allSources === true,
      clarificationCandidates: stringList(expected.clarificationCandidates),
      evidence: Array.isArray(expected.evidence) ? expected.evidence.map(normalizeEvidence) : null,
      staleEvidence: Array.isArray(expected.staleEvidence) ? expected.staleEvidence.map(normalizeEvidence) : [],
      answer: {
        mustContain: stringList(answer.mustContain),
        mustNotContain: stringList(answer.mustNotContain)
      }
    }
  };
}

function evidenceErrors(list, label) {
  const errors = [];
  list.forEach((evidence, index) => {
    const prefix = `${label}[${index}]`;
    if (!evidence.sourceId) errors.push(`${prefix}.sourceId is required`);
    if (!evidence.file) errors.push(`${prefix}.file is required`);
    if (!evidence.includes && evidence.page === null && evidence.row === null && !evidence.sheet && !evidence.section) {
      errors.push(`${prefix} needs includes or a location (page/sheet/row/section)`);
    }
    for (const key of ["page", "row"]) {
      if (Number.isNaN(evidence[key])) errors.push(`${prefix}.${key} must be a number`);
    }
  });
  return errors;
}

export function validateProductCase(testCase) {
  const errors = [];
  const { expected } = testCase;
  if (!testCase.id) errors.push("id is required");
  if (!testCase.question) errors.push("question is required");
  if (!CASE_CLASSES.includes(testCase.class)) errors.push(`unknown class "${testCase.class}"`);
  if (!ANSWER_STATUSES.includes(expected.status)) errors.push(`unknown expected.status "${expected.status}"`);
  if (expected.evidence === null) errors.push("expected.evidence must be an array (use [] for no evidence)");

  if (expected.status === "clarification_required") {
    if (expected.clarificationCandidates.length < 2) errors.push("clarification_required needs at least 2 clarificationCandidates");
  } else if (!expected.allSources && !expected.sourceIds.length) {
    errors.push("expected.sourceIds or expected.allSources is required");
  }

  if (expected.status === "insufficient_evidence" && expected.evidence?.length) {
    errors.push("insufficient_evidence case must not list evidence");
  }
  if (["verified", "verified_with_conflict"].includes(expected.status) && !expected.evidence?.length) {
    errors.push(`${expected.status} case must list evidence`);
  }
  if (testCase.class === "follow_up" && !testCase.history.length) errors.push("follow_up case needs history");
  if (testCase.class === "amendment_supersedes" && !expected.staleEvidence.length) {
    errors.push("amendment_supersedes case needs staleEvidence");
  }

  errors.push(...evidenceErrors(expected.evidence || [], "expected.evidence"));
  errors.push(...evidenceErrors(expected.staleEvidence, "expected.staleEvidence"));
  return errors;
}

export function missingCaseClasses(cases = []) {
  const present = new Set(cases.map((testCase) => testCase.class));
  return CASE_CLASSES.filter((caseClass) => !present.has(caseClass));
}

export async function loadProductEvalFile(filePath) {
  const payload = JSON.parse(await fs.readFile(filePath, "utf8"));
  const fileName = path.basename(filePath);
  if (payload?.schemaVersion !== PRODUCT_EVAL_SCHEMA_VERSION) {
    throw new Error(`${fileName}: schemaVersion must be "${PRODUCT_EVAL_SCHEMA_VERSION}"`);
  }
  const cases = Array.isArray(payload.cases) ? payload.cases : [];
  return {
    fileName,
    corpus: String(payload.corpus || "").trim(),
    cases: cases.map((item, index) => normalizeProductCase(item, fileName, index))
  };
}

export async function loadProductEvalSets(directory) {
  const entries = await fs.readdir(directory, { withFileTypes: true }).catch(() => []);
  const files = entries
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".json"))
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right));
  const sets = [];
  for (const fileName of files) {
    sets.push(await loadProductEvalFile(path.join(directory, fileName)));
  }
  return sets;
}

import { DURATION_UNITS, compareQuantities, extractQuantities } from "./claim-numbers.js";

// Deterministic claim checks (Product V2, Stage 07). They run before and independently of the verifier
// model, so a verifier false-pass cannot let a wrong number, unit, citation, project or superseded
// clause into the final answer.

export const CLAIM_KINDS = ["fact", "amount", "percentage", "date", "period", "condition", "comparison"];

// Issues that mean the claim says something else than the evidence (vs. merely not shown by it).
const CONTRADICTING_ISSUES = new Set(["unit_mismatch", "type_mismatch", "superseded_evidence"]);

// The claim itself talks about an earlier version, so citing the replaced clause is correct.
const HISTORY_WORDING = /ранее|прежн|первоначальн|изначальн|изменен|заменен|до\s+(?:подписания\s+|заключения\s+)?(?:доп|дс(?![\p{L}\p{N}]))|в\s+редакции\s+договора|(?<![\p{L}])был[аио]?(?![\p{L}])/iu;
// A label names the value when it heads the phrase ("Срок возврата — 3%") or stands right before it
// ("в течение 3%"); "Неустойка за нарушение срока — 0,1%" is not a period.
const PERIOD_LABEL = /^\s*(?:срок|период|продолжительн)|(?:в\s+течени\p{L}*|сроком|на\s+срок)\s*$/iu;
const SIZE_LABEL = /^\s*(?:размер|процент|ставк)|(?:в\s+размере|размером|ставкой)\s*$/iu;

const KIND_UNITS = {
  percentage: (unit) => unit === "percent" || unit === "fraction",
  period: (unit) => DURATION_UNITS.has(unit) || unit === "date" || unit === "calendar_year",
  date: (unit) => unit === "date" || unit === "calendar_year",
  amount: (unit) => !DURATION_UNITS.has(unit) && unit !== "date"
};

// The words right before a quantity, back to the previous quantity or punctuation ("Срок возврата — 3%").
function labelBefore(text, quantity, previous) {
  const from = Math.max(previous ? previous.index + previous.raw.length : 0, quantity.index - 80);
  const window = text.slice(from, quantity.index);
  const boundary = Math.max(...[".", ";", ",", "\n", "!", "?"].map((mark) => window.lastIndexOf(mark)));
  // Dashes and colons between the label and the value do not change what the label names.
  return (boundary >= 0 ? window.slice(boundary + 1) : window).replace(/[\s—–:-]+$/u, "");
}

function typeIssues(claim) {
  const quantities = extractQuantities(claim.text);
  const issues = [];
  const kindRule = KIND_UNITS[claim.kind];
  if (kindRule && quantities.length && !quantities.some((quantity) => kindRule(quantity.unit))) {
    issues.push({ code: "type_mismatch", detail: `kind ${claim.kind} has no matching value` });
  }
  quantities.forEach((quantity, index) => {
    const label = labelBefore(claim.text, quantity, quantities[index - 1]);
    const periodAsShare = PERIOD_LABEL.test(label) && (quantity.unit === "percent" || quantity.unit === "currency");
    const shareAsPeriod = SIZE_LABEL.test(label) && !PERIOD_LABEL.test(label) && DURATION_UNITS.has(quantity.unit);
    if (periodAsShare || shareAsPeriod) issues.push({ code: "type_mismatch", detail: `${quantity.raw} labelled as "${label.trim()}"` });
  });
  return issues;
}

/**
 * @param {object} claim           { claimId, text, kind, evidenceIds }
 * @param {object} context
 * @param {Map}    context.evidenceById    E-label -> packet item ({ text, sourceId, retrievalReason, fileId, chunkId, path })
 * @param {Array|null} context.allowedSourceIds  scope of the turn (null = every project)
 * @param {string} context.versionPolicy   current | historical | all
 * @returns {{ claimId, passed: boolean, status: "passed"|"unsupported"|"contradicted", issues: Array, conflict: boolean }}
 */
export function checkClaim(claim, { evidenceById, allowedSourceIds = null, versionPolicy = "current" }) {
  const issues = [];
  const evidenceIds = Array.isArray(claim.evidenceIds) ? claim.evidenceIds : [];
  if (!evidenceIds.length) issues.push({ code: "missing_evidence", detail: "claim cites no evidence" });
  const cited = [];
  for (const id of evidenceIds) {
    const item = evidenceById.get(id);
    if (!item) {
      issues.push({ code: "unknown_evidence", detail: id });
      continue;
    }
    cited.push(item);
    if (Array.isArray(allowedSourceIds) && !allowedSourceIds.includes(item.sourceId)) {
      issues.push({ code: "out_of_scope", detail: `${id} belongs to ${item.sourceId}` });
    }
    if (!item.fileId && !item.chunkId && !item.path) issues.push({ code: "no_citation_target", detail: id });
  }

  if (cited.length) {
    for (const { quantity, status } of compareQuantities(claim.text, cited.map((item) => item.text))) {
      if (status === "missing") issues.push({ code: "number_not_in_evidence", detail: quantity.raw });
      if (status === "unit_mismatch") issues.push({ code: "unit_mismatch", detail: quantity.raw });
    }
    const allSuperseded = cited.every((item) => String(item.retrievalReason || "").includes(":superseded"));
    if (versionPolicy === "current" && allSuperseded && !HISTORY_WORDING.test(claim.text)) {
      issues.push({ code: "superseded_evidence", detail: "only replaced clauses are cited for the current version" });
    }
  }
  issues.push(...typeIssues(claim));

  const contradicting = issues.some((issue) => CONTRADICTING_ISSUES.has(issue.code));
  return {
    claimId: claim.claimId,
    passed: issues.length === 0,
    status: issues.length === 0 ? "passed" : (contradicting ? "contradicted" : "unsupported"),
    issues,
    conflict: cited.some((item) => String(item.retrievalReason || "").includes(":conflict"))
  };
}

export function checkClaims(claims, context) {
  return claims.map((claim) => checkClaim(claim, context));
}

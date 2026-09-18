import fs from "node:fs/promises";
import path from "node:path";

import { labelEvidence } from "../../apps/rag-api/src/answer-core/answer-draft.js";
import { VERDICT_RESPONSE_FORMAT, buildVerifierMessages, parseVerdict } from "../../apps/rag-api/src/answer-core/answer-verifier.js";
import { CLAIM_KINDS, checkClaim } from "../../apps/rag-api/src/answer-core/claim-checks.js";
import { metricValue } from "./metrics.mjs";

// Stage 07 gate eval: labelled claims against real corpus evidence. Offline it measures the
// deterministic checks; with a verifier model (--verifier-llm) it measures checks + verifier.

export const VERIFIER_EXPECTED = ["supported", "unsupported", "contradicted"];
export const VERIFIER_CATEGORIES = ["supported", "numeric", "version", "scope", "citation", "semantic"];

export async function loadVerifierSets(directory) {
  const entries = await fs.readdir(directory, { withFileTypes: true }).catch(() => []);
  const sets = [];
  for (const name of entries.filter((entry) => entry.isFile() && entry.name.endsWith(".json")).map((entry) => entry.name).sort()) {
    const payload = JSON.parse(await fs.readFile(path.join(directory, name), "utf8"));
    sets.push({ fileName: name, corpus: payload.corpus || "", cases: Array.isArray(payload.cases) ? payload.cases : [] });
  }
  return sets;
}

export function validateVerifierCase(testCase = {}) {
  const errors = [];
  if (!testCase.id) errors.push("id is required");
  if (!VERIFIER_EXPECTED.includes(testCase.expected)) errors.push(`expected must be one of ${VERIFIER_EXPECTED.join(", ")}`);
  if (!VERIFIER_CATEGORIES.includes(testCase.category)) errors.push(`unknown category "${testCase.category}"`);
  if ((testCase.category === "supported") !== (testCase.expected === "supported")) errors.push("category supported <-> expected supported");
  if (!testCase.sourceId) errors.push("sourceId is required");
  if (!String(testCase.claim?.text || "").trim()) errors.push("claim.text is required");
  if (!CLAIM_KINDS.includes(testCase.claim?.kind)) errors.push(`claim.kind must be one of ${CLAIM_KINDS.join(", ")}`);
  if (!Array.isArray(testCase.claim?.evidence)) errors.push("claim.evidence must be an array");
  return errors;
}

// Evidence spans of the corpus with the retrieval reason a packet would give them (superseded/conflict).
export function corpusEvidenceIndex({ chunks, evidenceProvider }) {
  const titleByChunk = new Map(chunks.map((chunk) => [chunk.id, chunk.title]));
  const spans = evidenceProvider.spansForChunks(chunks.map((chunk) => chunk.id));
  const facts = evidenceProvider.factsForSources({});
  const reasonFor = (evidenceId) => {
    const related = facts.filter((fact) => fact.evidenceIds.includes(evidenceId));
    const current = related.find((fact) => fact.status === "active" || fact.status === "conflict");
    if (current) return `fact:${current.factType}:${current.status}`;
    if (related.length) return `fact:${related[0].factType}:${related[0].status}`;
    return "chunk:1";
  };
  return {
    find(sourceId, file, includes) {
      const span = spans.find((item) => item.sourceId === sourceId && titleByChunk.get(item.chunkId) === file && item.text.includes(includes));
      if (!span) return null;
      return { id: span.chunkId, chunkId: span.chunkId, evidenceId: span.evidenceId, fileId: span.fileId, sourceId, title: file, text: span.text, retrievalReason: reasonFor(span.evidenceId) };
    }
  };
}

export async function runVerifierCases({ cases, evidenceIndex, verifierLlm = null, chatCompletion = null }) {
  const rows = [];
  for (const testCase of cases) {
    const items = [];
    const problems = [];
    for (const reference of testCase.claim.evidence) {
      const item = evidenceIndex.find(reference.sourceId || testCase.sourceId, reference.file, reference.includes);
      if (item) items.push(item);
      else problems.push(`evidence ${reference.file} "${reference.includes}" not found`);
    }
    const labelled = labelEvidence(items);
    const claim = {
      claimId: "c1",
      text: testCase.claim.text,
      kind: testCase.claim.kind,
      evidenceIds: [...labelled.items.map(({ label }) => label), ...(testCase.claim.rawEvidenceIds || [])]
    };
    const check = checkClaim(claim, {
      evidenceById: labelled.byLabel,
      allowedSourceIds: [testCase.sourceId],
      versionPolicy: testCase.versionPolicy || "current"
    });
    let verdict = null;
    if (verifierLlm && check.passed) {
      const reply = await chatCompletion({
        llm: verifierLlm,
        responseFormat: VERDICT_RESPONSE_FORMAT,
        messages: buildVerifierMessages({ question: testCase.question || testCase.claim.text, plan: { versionPolicy: testCase.versionPolicy || "current" }, claims: [claim], labelled, profile: {} })
      });
      try {
        verdict = parseVerdict(reply.text, ["c1"]).verdicts.get("c1");
      } catch {
        verdict = { status: "ambiguous", supportedBy: [], issues: ["unparsable verdict"] };
      }
    }
    const passed = check.passed && (!verifierLlm || verdict?.status === "supported");
    rows.push({ testCase, check, verdict, passed, problems });
  }
  return rows;
}

export function computeVerifierMetrics(rows, { mode = "deterministic checks" } = {}) {
  const adversarial = rows.filter((row) => row.testCase.expected !== "supported");
  const supported = rows.filter((row) => row.testCase.expected === "supported");
  const falsePass = adversarial.filter((row) => row.passed).length;
  const falseReject = supported.filter((row) => !row.passed).length;
  return {
    falsePassRate: { ...metricValue(falsePass, adversarial.length, "no adversarial claims"), mode },
    falseRejectRate: { ...metricValue(falseReject, supported.length, "no supported claims"), mode }
  };
}

export function verifierCategoryBreakdown(rows) {
  return VERIFIER_CATEGORIES.map((category) => {
    const inCategory = rows.filter((row) => row.testCase.category === category);
    const wrong = inCategory.filter((row) => (category === "supported" ? !row.passed : row.passed));
    return { category, total: inCategory.length, wrong: wrong.map((row) => row.testCase.id) };
  }).filter((item) => item.total);
}

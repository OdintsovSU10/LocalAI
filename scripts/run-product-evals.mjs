#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { buildProductCorpus } from "./product-eval/corpus.mjs";
import {
  METRIC_OK,
  computeProductMetrics,
  evidenceRank,
  missingRequiredMetrics,
  silentMetricFailures
} from "./product-eval/metrics.mjs";
import { RETRIEVAL_MODES, runRetrievalCase } from "./product-eval/retrieval.mjs";
import { loadProductEvalSets, missingCaseClasses, validateProductCase } from "./product-eval/schema.mjs";
import {
  computeVerifierMetrics,
  corpusEvidenceIndex,
  loadVerifierSets,
  runVerifierCases,
  verifierGateProblems,
  validateVerifierCase,
  verifierCategoryBreakdown
} from "./product-eval/verifier-eval.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);

function readOption(name) {
  const inline = args.find((arg) => arg.startsWith(`--${name}=`));
  if (inline) return inline.slice(name.length + 3);
  const index = args.indexOf(`--${name}`);
  return index >= 0 && args[index + 1] && !args[index + 1].startsWith("--") ? args[index + 1] : "";
}

function formatMetric(metric) {
  if (metric.status !== METRIC_OK) return `NOT_AVAILABLE (${metric.reason})`;
  const counts = Number.isInteger(metric.numerator) ? ` [${metric.numerator}/${metric.denominator}]` : ` [n=${metric.denominator}]`;
  return `${metric.value.toFixed(3)}${counts}`;
}

function caseLine(row) {
  const { testCase, retrieval } = row;
  const ranks = (testCase.expected.evidence || []).map((evidence) => {
    const exact = evidenceRank(retrieval.results, evidence, "exact");
    const file = evidenceRank(retrieval.results, evidence, "file");
    return `${evidence.file}:exact=${exact ?? "-"}/file=${file ?? "-"}`;
  });
  const scope = retrieval.clarificationPredicted
    ? "clarification"
    : retrieval.scope.searchAllSources ? "all" : retrieval.scope.sourceId || "none";
  return `- ${testCase.id} [${testCase.class}] scope=${scope} results=${retrieval.results.length}${ranks.length ? ` ${ranks.join(" ")}` : ""}`;
}

// Verifier model for --verifier-llm: the local LM Studio route from the environment (no settings.json).
function verifierLlmFromEnv() {
  return {
    enabled: true,
    provider: "local",
    baseUrl: process.env.RAG_LLM_BASE_URL || "http://127.0.0.1:1234/v1",
    apiKey: "lm-studio",
    model: process.env.RAG_VERIFIER_MODEL || process.env.RAG_LLM_MODEL || "",
    temperature: 0,
    maxTokens: 1500,
    timeoutSeconds: 180
  };
}

export async function runProductEvals({
  evalsDir = path.join(projectRoot, "evals", "product-v2"),
  verifierDir = path.join(projectRoot, "evals", "verifier"),
  retrievalMode = "v2",
  verifierLlm = null,
  chatCompletion = null
} = {}) {
  const problems = [];
  if (!RETRIEVAL_MODES.includes(retrievalMode)) problems.push(`unknown retrieval mode "${retrievalMode}" (use ${RETRIEVAL_MODES.join(" | ")})`);
  const sets = await loadProductEvalSets(evalsDir);
  const cases = sets.flatMap((set) => set.cases.map((testCase) => ({ testCase, corpus: set.corpus })));
  if (!cases.length) problems.push(`no product eval cases in ${path.relative(projectRoot, evalsDir) || evalsDir}`);

  const ids = new Set();
  for (const { testCase, corpus } of cases) {
    const errors = validateProductCase(testCase);
    if (!corpus) errors.push("eval file has no corpus");
    if (ids.has(testCase.id)) errors.push("duplicate id");
    ids.add(testCase.id);
    errors.forEach((error) => problems.push(`${testCase.fileName}:${testCase.id}: ${error}`));
  }
  const missingClasses = missingCaseClasses(cases.map((item) => item.testCase));
  if (cases.length && missingClasses.length) problems.push(`missing case classes: ${missingClasses.join(", ")}`);
  if (problems.length) return { problems, rows: [], metrics: null };

  const corpora = new Map();
  const rows = [];
  for (const { testCase, corpus } of cases) {
    if (!corpora.has(corpus)) corpora.set(corpus, await buildProductCorpus({ projectRoot, corpusDir: corpus }));
    const corpusState = corpora.get(corpus);
    for (const evidence of [...testCase.expected.evidence, ...testCase.expected.staleEvidence]) {
      if (!corpusState.chunks.some((chunk) => chunk.sourceId === evidence.sourceId && chunk.title === evidence.file)) {
        problems.push(`${testCase.id}: evidence file ${evidence.sourceId}/${evidence.file} is not in corpus ${corpus}`);
      }
    }
    rows.push({ testCase, retrieval: runRetrievalCase(testCase, { ...corpusState, mode: retrievalMode }) });
  }

  const metrics = computeProductMetrics(rows);

  // Stage 07: labelled claims through the answer gate (deterministic checks, plus a verifier model if given).
  const verifierRows = [];
  for (const set of await loadVerifierSets(verifierDir)) {
    if (!set.corpus) problems.push(`${set.fileName}: verifier set has no corpus`);
    set.cases.forEach((testCase) => validateVerifierCase(testCase).forEach((error) => problems.push(`${set.fileName}:${testCase.id}: ${error}`)));
    if (!set.corpus || problems.length) continue;
    if (!corpora.has(set.corpus)) corpora.set(set.corpus, await buildProductCorpus({ projectRoot, corpusDir: set.corpus }));
    const evidenceIndex = corpusEvidenceIndex(corpora.get(set.corpus));
    const setRows = await runVerifierCases({ cases: set.cases, evidenceIndex, verifierLlm, chatCompletion });
    setRows.forEach((row) => row.problems.forEach((problem) => problems.push(`${set.fileName}:${row.testCase.id}: ${problem}`)));
    verifierRows.push(...setRows);
  }
  if (verifierRows.length) {
    problems.push(...verifierGateProblems(verifierRows, { verifierModel: Boolean(verifierLlm) }));
    metrics.verifier = computeVerifierMetrics(verifierRows, { mode: verifierLlm ? "deterministic checks + verifier model" : "deterministic checks" });
  }

  silentMetricFailures(metrics).forEach((name) => problems.push(`metric ${name} was not computed and has no NOT_AVAILABLE reason`));
  missingRequiredMetrics(metrics).forEach((name) => problems.push(`required metric ${name} is not computable on this eval set`));
  return { problems, rows, metrics, verifierRows, corpora: [...corpora.keys()], retrievalMode };
}

async function main() {
  const jsonOut = readOption("json");
  const evalsDir = path.resolve(readOption("dir") || path.join(projectRoot, "evals", "product-v2"));
  // --retrieval legacy measures the pre-Stage-06 chunk results for before/after comparison.
  const retrievalMode = readOption("retrieval") || "v2";
  // Every *.json in the eval directory is loaded as a case set, so a report written there breaks the next run.
  if (jsonOut && !path.relative(evalsDir, path.resolve(jsonOut)).startsWith("..")) {
    console.error(`FAIL: --json report must be written outside the eval directory (${evalsDir})`);
    process.exitCode = 1;
    return;
  }
  // --verifier-llm also asks the local verifier model (RAG_LLM_BASE_URL, RAG_VERIFIER_MODEL or RAG_LLM_MODEL).
  const useVerifierLlm = args.includes("--verifier-llm");
  const chatCompletion = useVerifierLlm ? (await import("../apps/rag-api/src/llm.js")).chatCompletion : null;
  const { problems, rows, metrics, verifierRows = [], corpora = [] } = await runProductEvals({
    evalsDir,
    retrievalMode,
    verifierLlm: useVerifierLlm ? verifierLlmFromEnv() : null,
    chatCompletion
  });

  if (rows.length) {
    console.log(`Product V2 eval (retrieval-only, ${retrievalMode}): ${rows.length} case(s), corpus ${corpora.join(", ")}`);
    rows.forEach((row) => console.log(caseLine(row)));
  }
  if (verifierRows.length) {
    console.log(`\nVerifier gate (${metrics?.verifier?.falsePassRate?.mode || ""}): ${verifierRows.length} claim(s)`);
    verifierCategoryBreakdown(verifierRows).forEach(({ category, total, wrong }) => {
      console.log(`- ${category}: ${total - wrong.length}/${total} correct${wrong.length ? ` (wrong: ${wrong.join(", ")})` : ""}`);
    });
  }
  if (metrics) {
    console.log("\nMetrics");
    for (const [group, values] of Object.entries(metrics)) {
      for (const [name, metric] of Object.entries(values)) {
        console.log(`${group}.${name}: ${formatMetric(metric)}`);
      }
    }
  }

  if (jsonOut) {
    const report = {
      schemaVersion: "product-v2-report/1",
      generatedAt: new Date().toISOString(),
      mode: `retrieval-only/${retrievalMode}`,
      metrics,
      cases: rows.map(({ testCase, retrieval }) => ({
        id: testCase.id,
        class: testCase.class,
        scope: retrieval.scope,
        clarificationPredicted: retrieval.clarificationPredicted,
        results: retrieval.results.map(({ rank, sourceId, path: resultPath, score, citationLabel }) => ({ rank, sourceId, path: resultPath, score, citationLabel }))
      })),
      problems
    };
    await fs.mkdir(path.dirname(path.resolve(jsonOut)), { recursive: true });
    await fs.writeFile(path.resolve(jsonOut), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  }

  if (problems.length) {
    problems.forEach((problem) => console.error(`FAIL: ${problem}`));
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}

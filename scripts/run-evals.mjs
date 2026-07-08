import path from "node:path";

import {
  buildDemoIndex,
  demoEvalFile,
  demoSettings,
  evalsDir,
  fileMatchesHint,
  formatMetric,
  loadEvalCases,
  projectRoot,
  retrievalMetrics,
  retrievalSearch,
  validateCase
} from "./eval-utils.mjs";

const args = new Set(process.argv.slice(2));
const withLlm = args.has("--with-llm");
const demoMode = args.has("--demo");
const strictMode = args.has("--strict") || demoMode;
const allowLlm = args.has("--allow-llm") || ["1", "true", "yes", "on"].includes(String(process.env.RAG_EVAL_ALLOW_LLM || "").toLowerCase());

function apiBaseUrl() {
  return String(process.env.RAG_EVAL_API_URL || process.env.RAG_API_URL || "http://127.0.0.1:8787").replace(/\/$/, "");
}

async function runLlmCase(testCase) {
  if (!allowLlm) {
    throw new Error("eval:llm is gated. Set RAG_EVAL_ALLOW_LLM=true or pass --allow-llm to call a real /api/chat endpoint.");
  }

  const headers = { "Content-Type": "application/json" };
  if (process.env.RAG_AUTH_TOKEN) headers.Authorization = `Bearer ${process.env.RAG_AUTH_TOKEN}`;

  const response = await fetch(`${apiBaseUrl()}/api/chat`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      question: testCase.question,
      sourceId: testCase.sourceId
    })
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);

  const answer = String(payload.answer || "");
  const lowerAnswer = answer.toLowerCase();
  const missingTerms = testCase.mustContain.filter((term) => !lowerAnswer.includes(String(term).toLowerCase()));
  const citationOk = !testCase.mustCite || /\[\d+\]/.test(answer);
  const expectedFileHint = testCase.expectedFileHint.trim();
  const sourceHit = expectedFileHint
    ? (payload.sources || []).some((source) => fileMatchesHint(source, expectedFileHint))
    : null;

  return {
    answerChars: answer.length,
    missingTerms,
    citationOk,
    sourceHit
  };
}

function printRetrievalCase(testCase, retrieval) {
  const status = retrieval.evaluated
    ? `R@3=${retrieval.recallAt3 ? "1" : "0"} R@5=${retrieval.recallAt5 ? "1" : "0"} MRR=${retrieval.reciprocalRank.toFixed(3)}`
    : "skipped(no expectedFileHint)";
  console.log(`- ${testCase.id}: ${status}, results=${retrieval.results.length}`);
  retrieval.results.slice(0, 3).forEach((result) => {
    console.log(`  #${result.rank} score=${result.score} ${result.citationLabel || result.path || result.id}`);
  });
}

function printSummary({ retrievalRows, llmRows }) {
  const metrics = retrievalMetrics(retrievalRows);

  console.log("\nSummary");
  console.log(`cases: ${metrics.cases}`);
  console.log(`retrieval evaluated: ${metrics.evaluated}`);
  console.log(`Recall@3: ${formatMetric(metrics.recallAt3)}`);
  console.log(`Recall@5: ${formatMetric(metrics.recallAt5)}`);
  console.log(`Recall@10: ${formatMetric(metrics.recallAt10)}`);
  console.log(`MRR: ${formatMetric(metrics.mrr)}`);

  if (!metrics.evaluated) {
    console.log(strictMode ? "FAIL: no retrieval cases evaluated" : "WARN: no retrieval cases evaluated");
  }

  if (llmRows.length) {
    const failed = llmRows.filter((row) => row.llm.missingTerms.length || !row.llm.citationOk);
    console.log(`LLM checked: ${llmRows.length}`);
    console.log(`LLM assertion failures: ${failed.length}`);
  }

  return metrics;
}

async function loadStateForEval() {
  if (demoMode) {
    const demo = await buildDemoIndex();
    return {
      cases: await loadEvalCases({ filePath: demoEvalFile }),
      settings: demoSettings,
      chunks: demo.chunks,
      sourceSummary: demo.sourceSummary,
      label: "demo fixture"
    };
  }

  const [{ chunksPath }, { readJson, readSettings }] = await Promise.all([
    import("../apps/rag-api/src/paths.js"),
    import("../apps/rag-api/src/store.js")
  ]);
  return {
    cases: await loadEvalCases({ directory: evalsDir }),
    settings: await readSettings(),
    chunks: await readJson(chunksPath(), []),
    sourceSummary: null,
    label: path.relative(projectRoot, evalsDir)
  };
}

async function main() {
  if (withLlm && !allowLlm) {
    console.error("Refusing to run LLM eval without explicit opt-in. Use RAG_EVAL_ALLOW_LLM=true or --allow-llm.");
    process.exit(2);
  }

  const { cases, settings, chunks, sourceSummary, label } = await loadStateForEval();
  if (!cases.length) {
    console.log("No eval cases found");
    process.exit(strictMode ? 1 : 0);
  }

  const invalid = cases
    .map((testCase) => ({ testCase, errors: validateCase(testCase) }))
    .filter((row) => row.errors.length);

  if (invalid.length) {
    invalid.forEach((row) => {
      console.error(`${row.testCase.fileName}:${row.testCase.id}: ${row.errors.join("; ")}`);
    });
    process.exit(1);
  }

  const retrievalRows = [];
  const llmRows = [];

  console.log(`Loaded ${cases.length} eval case(s) from ${label}`);
  console.log(`Retrieval mode: ${settings.search?.lexicalMode || "bm25"} lexical, chunks=${chunks.length}`);
  if (sourceSummary) {
    console.log(`Demo summary: files=${sourceSummary.fileCount}, chunks=${sourceSummary.chunkCount}`);
  }

  for (const testCase of cases) {
    const retrieval = retrievalSearch({ testCase, chunks, settings });
    retrievalRows.push({ testCase, retrieval });
    printRetrievalCase(testCase, retrieval);

    if (withLlm) {
      const llm = await runLlmCase(testCase);
      llmRows.push({ testCase, llm });
      const terms = llm.missingTerms.length ? `missing=${llm.missingTerms.join(", ")}` : "mustContain=ok";
      const cite = llm.citationOk ? "mustCite=ok" : "mustCite=fail";
      const source = llm.sourceHit === null ? "" : ` sourceHit=${llm.sourceHit ? "1" : "0"}`;
      console.log(`  LLM answerChars=${llm.answerChars} ${terms} ${cite}${source}`);
    }
  }

  const metrics = printSummary({ retrievalRows, llmRows });
  const llmFailures = llmRows.filter((row) => row.llm.missingTerms.length || !row.llm.citationOk);
  const retrievalFailures = retrievalRows.filter((row) => row.retrieval.evaluated && !row.retrieval.recallAt5);

  if (strictMode && (!metrics.evaluated || retrievalFailures.length || llmFailures.length)) {
    if (retrievalFailures.length) {
      console.error(`FAIL: ${retrievalFailures.length} retrieval case(s) missed expectedFileHint in top 5.`);
    }
    process.exitCode = 1;
  } else if (llmFailures.length) {
    process.exitCode = 1;
  }
}

await main();

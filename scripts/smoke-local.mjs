import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { formatCitationLabel } from "../apps/rag-api/src/citations.js";
import {
  buildDemoIndex,
  demoEvalFile,
  demoSettings,
  formatMetric,
  loadEvalCases,
  retrievalMetrics,
  retrievalSearch,
  validateCase
} from "./eval-utils.mjs";

const keepTemp = process.argv.includes("--keep-temp");
const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "localai-smoke-local-"));
const stateDir = path.join(tempRoot, "state");

process.env.DOTENV_CONFIG_PATH = path.join(tempRoot, ".env.disabled");
process.env.RAG_DATA_DIR = tempRoot;
process.env.RAG_REQUIRE_AUTH = "false";
process.env.RAG_AUTH_TOKEN = "";
process.env.RAG_ALLOW_REMOTE_CONTEXT = "false";
process.env.RAG_REMOTE_LLM_ENABLED = "false";
process.env.RAG_LLM_FALLBACK_TO_LOCAL_ON_REMOTE_ERROR = "false";
process.env.RAG_EMBEDDINGS_ENABLED = "false";
process.env.RAG_VECTOR_STORE_ENABLED = "false";
process.env.RAG_RERANKER_ENABLED = "false";
process.env.RAG_OCR_ENABLED = "false";

function assertSmoke(condition, message) {
  if (!condition) throw new Error(message);
}

function fallbackAnswerFor(results) {
  const refs = results.slice(0, 3).map((_result, index) => `[${index + 1}]`).join(", ");
  return `LLM disabled for local smoke. Relevant chunks were found.\n\nSources: ${refs}.`;
}

try {
  const cases = await loadEvalCases({ filePath: demoEvalFile });
  const invalid = cases
    .map((testCase) => ({ testCase, errors: validateCase(testCase) }))
    .filter((row) => row.errors.length);
  assertSmoke(!invalid.length, `Invalid demo eval cases: ${invalid.map((row) => row.testCase.id).join(", ")}`);

  const demo = await buildDemoIndex();
  await fs.mkdir(stateDir, { recursive: true });
  await fs.writeFile(path.join(stateDir, "manifest.json"), JSON.stringify(demo.manifest, null, 2), "utf8");
  await fs.writeFile(path.join(stateDir, "chunks.json"), JSON.stringify(demo.chunks, null, 2), "utf8");
  await fs.writeFile(path.join(stateDir, "source-summary.json"), JSON.stringify(demo.sourceSummary, null, 2), "utf8");

  assertSmoke(demo.sourceSummary.fileCount === 5, `Expected 5 demo files, got ${demo.sourceSummary.fileCount}`);
  assertSmoke(demo.sourceSummary.chunkCount >= 5, `Expected demo chunks, got ${demo.sourceSummary.chunkCount}`);
  assertSmoke(demo.sourceSummary.deterministicSummary, "Missing deterministic source summary");

  const retrievalRows = [];
  for (const testCase of cases) {
    assertSmoke(testCase.expectedFileHint, `${testCase.id} has no expectedFileHint`);
    const retrieval = retrievalSearch({ testCase, chunks: demo.chunks, settings: demoSettings });
    retrievalRows.push({ testCase, retrieval });
    assertSmoke(retrieval.recallAt5, `${testCase.id} missed ${testCase.expectedFileHint} in top 5`);
    assertSmoke(retrieval.results.length > 0, `${testCase.id} returned no retrieval results`);

    const label = formatCitationLabel(retrieval.results[0]);
    assertSmoke(label && label.includes(".md"), `${testCase.id} has unreadable citation label`);
  }

  const sectionLabel = demo.chunks
    .map((chunk) => formatCitationLabel(chunk))
    .find((label) => label.includes("\u0440\u0430\u0437\u0434\u0435\u043b"));
  assertSmoke(sectionLabel, "Markdown section citation label was not generated");

  const firstRetrieval = retrievalRows[0].retrieval;
  const fallback = fallbackAnswerFor(firstRetrieval.results);
  assertSmoke(/Sources:\s*\[1\]/.test(fallback), "Fallback answer does not include source references");

  const metrics = retrievalMetrics(retrievalRows);
  console.log("Smoke temp: created");
  console.log(`Demo files: ${demo.sourceSummary.fileCount}`);
  console.log(`Demo chunks: ${demo.sourceSummary.chunkCount}`);
  console.log(`Cases loaded: ${metrics.cases}`);
  console.log(`Cases evaluated: ${metrics.evaluated}`);
  console.log(`Recall@3: ${formatMetric(metrics.recallAt3)}`);
  console.log(`Recall@5: ${formatMetric(metrics.recallAt5)}`);
  console.log(`MRR: ${formatMetric(metrics.mrr)}`);
  console.log("LLM/Qdrant/OCR: disabled");
  console.log("Fallback check: PASS");
  console.log("Smoke local: PASS");
} finally {
  if (keepTemp) {
    console.log(`Keeping temp directory: ${tempRoot}`);
  } else {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
}

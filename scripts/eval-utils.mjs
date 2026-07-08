import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { formatCitationLabel } from "../apps/rag-api/src/citations.js";
import { buildSourceSummary } from "../apps/rag-api/src/source-summary.js";
import { prepareSearchQuery } from "../apps/rag-api/src/search-query.js";
import {
  buildLexicalCandidates,
  filterChunksBySource,
  scoreSearchChunks
} from "../apps/rag-api/src/search-pipeline.js";
import { chunkMarkdown, tokenize } from "../apps/rag-api/src/text.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const projectRoot = path.resolve(__dirname, "..");
export const evalsDir = path.join(projectRoot, "evals");
export const demoSourceId = "demo-project";
export const demoFixtureDir = path.join(projectRoot, "fixtures", "demo-project");
export const demoEvalFile = path.join(evalsDir, "demo-project.json");

export const demoSettings = {
  search: { lexicalMode: "bm25" }
};

export const demoSource = {
  id: demoSourceId,
  title: "Demo Project",
  path: path.join("fixtures", "demo-project"),
  include: ["**/*.md"],
  exclude: []
};

export function normalizeText(value) {
  return String(value || "").toLowerCase();
}

export function fileMatchesHint(result, hint) {
  const needle = normalizeText(hint).trim();
  if (!needle) return false;
  const haystack = normalizeText([
    result.title,
    result.path,
    result.citationLabel,
    result.sourceTitle
  ].filter(Boolean).join(" "));
  return haystack.includes(needle);
}

export function compactResult(candidate, index) {
  const chunk = candidate.chunk || candidate;
  const score = Number(candidate.score ?? chunk.score ?? 0);
  return {
    rank: index + 1,
    id: chunk.id,
    score: Number(score.toFixed(3)),
    sourceId: chunk.sourceId,
    sourceTitle: chunk.sourceTitle || "",
    title: chunk.title || path.basename(chunk.path || ""),
    path: chunk.path || "",
    sectionTitle: chunk.sectionTitle || chunk.metadata?.sectionTitle || "",
    citationLabel: formatCitationLabel(chunk)
  };
}

export function normalizeCase(raw, fileName, index) {
  const item = raw && typeof raw === "object" ? raw : {};
  return {
    id: String(item.id || `${path.basename(fileName, ".json")}-${index + 1}`),
    sourceId: String(item.sourceId || ""),
    question: String(item.question || ""),
    mustContain: Array.isArray(item.mustContain) ? item.mustContain.map(String) : [],
    mustCite: Boolean(item.mustCite),
    expectedFileHint: String(item.expectedFileHint || "")
  };
}

export function casesFromPayload(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.cases)) return payload.cases;
  if (payload && typeof payload === "object") return [payload];
  return [];
}

export async function loadEvalCases({ filePath = "", directory = evalsDir } = {}) {
  if (filePath) {
    const text = await fs.readFile(filePath, "utf8");
    const payload = JSON.parse(text);
    const fileName = path.basename(filePath);
    return casesFromPayload(payload).map((item, index) => ({
      ...normalizeCase(item, fileName, index),
      fileName
    }));
  }

  const entries = await fs.readdir(directory, { withFileTypes: true }).catch(() => []);
  const files = entries
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".json"))
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right));

  const cases = [];
  for (const fileName of files) {
    const nextCases = await loadEvalCases({ filePath: path.join(directory, fileName) });
    cases.push(...nextCases);
  }
  return cases;
}

export function validateCase(testCase) {
  const errors = [];
  if (!testCase.id.trim()) errors.push("id is required");
  if (!testCase.question.trim()) errors.push("question is required");
  if (!Array.isArray(testCase.mustContain)) errors.push("mustContain must be an array");
  return errors;
}

function fileIdFor(fileName) {
  return `demo-${path.basename(fileName, path.extname(fileName)).toLowerCase()}`;
}

export async function buildDemoIndex({ fixtureDir = demoFixtureDir, source = demoSource } = {}) {
  const entries = await fs.readdir(fixtureDir, { withFileTypes: true });
  const files = entries
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".md"))
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right));

  const manifest = { files: {} };
  const chunks = [];

  for (const fileName of files) {
    const filePath = path.join(fixtureDir, fileName);
    const displayPath = path.join("fixtures", "demo-project", fileName);
    const markdown = await fs.readFile(filePath, "utf8");
    const stat = await fs.stat(filePath);
    const fileId = fileIdFor(fileName);
    const fileChunks = chunkMarkdown(markdown, 1800, 220, { documentType: "md" });

    manifest.files[fileId] = {
      fileId,
      sourceId: source.id,
      sourceTitle: source.title,
      path: displayPath,
      title: fileName,
      mtimeMs: stat.mtimeMs,
      size: stat.size,
      quality: {
        status: "ok",
        chunks: fileChunks.length,
        warnings: []
      },
      recognition: { method: "text" }
    };

    fileChunks.forEach((chunk, chunkIndex) => {
      const metadata = Object.fromEntries(
        Object.entries(chunk)
          .filter(([key]) => key !== "text")
          .filter(([, value]) => value !== undefined && value !== null && value !== "")
      );
      chunks.push({
        id: `${fileId}:${chunkIndex}`,
        fileId,
        sourceId: source.id,
        sourceTitle: source.title,
        path: displayPath,
        title: fileName,
        chunkIndex,
        ...metadata,
        metadata,
        text: chunk.text,
        terms: tokenize(chunk.text)
      });
    });
  }

  return {
    source,
    manifest,
    chunks,
    sourceSummary: buildSourceSummary({ source, manifest, chunks })
  };
}

export function retrievalSearch({ testCase, chunks, settings = demoSettings, topK = 10 }) {
  const { originalTerms, queryTerms, phrase } = prepareSearchQuery(testCase.question);
  const filteredChunks = filterChunksBySource(chunks, testCase.sourceId);
  const lexicalMode = settings.search?.lexicalMode || "bm25";
  const lexicalCandidates = buildLexicalCandidates({
    chunks: filteredChunks,
    queryTerms,
    phrase,
    lexicalMode,
    topK
  });
  const lexicalScoreById = new Map(lexicalCandidates.map((candidate) => [candidate.chunkId, Number(candidate.score || 0)]));
  const scored = scoreSearchChunks({
    chunks: lexicalCandidates.map((candidate) => candidate.chunk),
    originalTerms,
    queryTerms,
    phrase,
    lexicalMode,
    lexicalScoreById
  })
    .filter((chunk) => chunk.score > 0)
    .sort((left, right) => right.score - left.score)
    .slice(0, topK)
    .map((chunk, index) => compactResult(chunk, index));

  const expectedFileHint = testCase.expectedFileHint.trim();
  const sourceHitRank = expectedFileHint
    ? scored.findIndex((result) => fileMatchesHint(result, expectedFileHint)) + 1
    : 0;

  return {
    results: scored,
    evaluated: Boolean(expectedFileHint),
    sourceHitRank: sourceHitRank || null,
    recallAt3: expectedFileHint ? sourceHitRank > 0 && sourceHitRank <= 3 : null,
    recallAt5: expectedFileHint ? sourceHitRank > 0 && sourceHitRank <= 5 : null,
    recallAt10: expectedFileHint ? sourceHitRank > 0 && sourceHitRank <= 10 : null,
    reciprocalRank: expectedFileHint && sourceHitRank > 0 ? 1 / sourceHitRank : 0
  };
}

export function retrievalMetrics(retrievalRows = []) {
  const evaluated = retrievalRows.filter((row) => row.retrieval.evaluated);
  const ratio = (predicate) => evaluated.length
    ? evaluated.filter(predicate).length / evaluated.length
    : null;
  return {
    cases: retrievalRows.length,
    evaluated: evaluated.length,
    recallAt3: ratio((row) => row.retrieval.recallAt3),
    recallAt5: ratio((row) => row.retrieval.recallAt5),
    recallAt10: ratio((row) => row.retrieval.recallAt10),
    mrr: evaluated.length
      ? evaluated.reduce((sum, row) => sum + Number(row.retrieval.reciprocalRank || 0), 0) / evaluated.length
      : null
  };
}

export function formatMetric(value) {
  return value === null ? "n/a" : Number(value).toFixed(3);
}

import fs from "node:fs/promises";

import { buildSourceEvidence } from "../../apps/rag-api/src/evidence/build-source-evidence.js";
import { buildProductCorpus } from "../../scripts/product-eval/corpus.mjs";
import { projectRoot } from "./chat-runtime.mjs";

// Builds evidence for a synthetic product-v2 source straight from fixture markdown (no server, no index).
export async function buildFixtureSourceEvidence(sourceId) {
  const { chunks } = await buildProductCorpus({ projectRoot, corpusDir: "fixtures/product-v2" });
  const sourceChunks = chunks.filter((chunk) => chunk.sourceId === sourceId);
  const files = [...new Map(sourceChunks.map((chunk) => [chunk.fileId, {
    fileId: chunk.fileId,
    title: chunk.title,
    path: chunk.path
  }])).values()];
  return buildSourceEvidence({
    sourceId,
    files,
    chunks: sourceChunks,
    readMarkdown: (file) => fs.readFile(new URL(`../../${file.path}`, import.meta.url), "utf8")
  });
}

export function factsOf(build, factType, status = "") {
  return build.facts.filter((fact) => fact.factType === factType && (!status || fact.status === status));
}

export function spanOf(build, fact) {
  return build.spans.find((span) => span.evidenceId === fact.evidenceIds[0]);
}

export function documentOf(build, fact) {
  return build.documents.find((document) => document.documentId === fact.documentId);
}

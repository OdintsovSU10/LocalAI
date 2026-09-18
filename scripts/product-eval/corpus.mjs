import fs from "node:fs/promises";
import path from "node:path";

import { buildSourceEvidence } from "../../apps/rag-api/src/evidence/build-source-evidence.js";
import { createMemoryEvidenceProvider } from "../../apps/rag-api/src/evidence/memory-evidence-provider.js";
import { chunkMarkdown, tokenize } from "../../apps/rag-api/src/text.js";

// Fixture files are already in converter output form (xlsx → "## Лист:", OCR → "## OCR page N"),
// so the eval measures retrieval and citation metadata, not the converters themselves.
async function markdownFiles(directory) {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".md"))
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right));
}

export async function buildProductCorpus({ projectRoot, corpusDir }) {
  const absoluteCorpusDir = path.resolve(projectRoot, corpusDir);
  const payload = JSON.parse(await fs.readFile(path.join(absoluteCorpusDir, "sources.json"), "utf8"));
  const sources = Array.isArray(payload.sources) ? payload.sources : [];
  if (!sources.length) throw new Error(`${corpusDir}/sources.json has no sources`);

  const chunks = [];
  for (const source of sources) {
    const sourceDir = path.resolve(projectRoot, source.path);
    for (const fileName of await markdownFiles(sourceDir)) {
      const markdown = await fs.readFile(path.join(sourceDir, fileName), "utf8");
      const fileId = `${source.id}-${path.basename(fileName, ".md")}`;
      const displayPath = `${source.path}/${fileName}`;
      chunkMarkdown(markdown, 1800, 220, { documentType: "md" }).forEach((chunk, chunkIndex) => {
        const metadata = Object.fromEntries(Object.entries(chunk).filter(([key]) => key !== "text"));
        chunks.push({
          id: `${fileId}:${chunkIndex}`,
          fileId,
          sourceId: source.id,
          sourceTitle: source.title,
          path: displayPath,
          title: fileName,
          chunkIndex,
          ...metadata,
          metadata: { ...metadata, fileId, sourceId: source.id, chunkIndex },
          text: chunk.text,
          terms: tokenize(chunk.text)
        });
      });
    }
  }

  return { sources, chunks, evidenceProvider: await buildCorpusEvidenceProvider({ projectRoot, sources, chunks }) };
}

// Evidence (Stage 04) for the corpus, built in memory exactly like the server builds it from the index.
export async function buildCorpusEvidenceProvider({ projectRoot, sources, chunks }) {
  const builds = [];
  for (const source of sources) {
    const sourceChunks = chunks.filter((chunk) => chunk.sourceId === source.id);
    const files = [...new Map(sourceChunks.map((chunk) => [chunk.fileId, { fileId: chunk.fileId, title: chunk.title, path: chunk.path }])).values()];
    builds.push(await buildSourceEvidence({
      sourceId: source.id,
      files,
      chunks: sourceChunks,
      readMarkdown: (file) => fs.readFile(path.resolve(projectRoot, file.path), "utf8")
    }));
  }
  return createMemoryEvidenceProvider(builds);
}

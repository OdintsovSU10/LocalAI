import path from "node:path";

import { classifyDocument, stripFrontMatter } from "./document-classifier.js";
import { buildEvidenceSpans, sha1 } from "./evidence-spans.js";
import { EXTRACTION_VERSION, extractDocumentFacts } from "./fact-extractor.js";
import { linkDocumentFamily } from "./version-graph.js";

// Rebuilds markdown from index chunks when the markdown cache is missing (chunks carry the same text,
// long paragraphs may repeat their overlap — acceptable for evidence spans).
export function markdownFromChunks(chunks = []) {
  return [...chunks]
    .sort((left, right) => Number(left.chunkIndex || 0) - Number(right.chunkIndex || 0))
    .map((chunk) => String(chunk.text || ""))
    .join("\n\n");
}

/**
 * Builds documents, evidence spans, facts, relations and conflicts for one source.
 * @param {object} input
 * @param {string} input.sourceId
 * @param {Array} input.files    manifest entries of the source: { fileId, title, path, indexedAt, recognition }
 * @param {Array} input.chunks   index chunks of the source
 * @param {(file) => Promise<string|null>} input.readMarkdown  converted markdown for a file, null when unavailable
 */
export async function buildSourceEvidence({ sourceId, files = [], chunks = [], readMarkdown }) {
  const documents = [];
  const spans = [];
  const facts = [];
  const inputHashes = [];

  for (const file of [...files].sort((left, right) => String(left.fileId).localeCompare(String(right.fileId)))) {
    const fileChunks = chunks.filter((chunk) => chunk.fileId === file.fileId);
    const cached = await readMarkdown(file).catch(() => null);
    const markdown = cached === null || cached === undefined ? markdownFromChunks(fileChunks) : cached;
    const body = stripFrontMatter(markdown);
    if (!body.trim()) continue;

    const fileLabel = file.title || path.basename(String(file.path || "")) || file.fileId;
    const classification = classifyDocument({ markdown: body, fileLabel });
    const contentHash = sha1(body);
    inputHashes.push(`${file.fileId}:${contentHash}`);

    const document = {
      documentId: file.fileId,
      sourceId,
      fileId: file.fileId,
      fileLabel,
      kind: classification.kind,
      title: classification.title,
      number: classification.number,
      documentDate: classification.documentDate,
      effectiveDate: null,
      revision: "",
      contentHash,
      parentRef: classification.parentRef,
      classification: { method: classification.method, markdownSource: cached === null || cached === undefined ? "chunks" : "cache" },
      indexedAt: file.indexedAt || null
    };
    const documentSpans = buildEvidenceSpans({
      sourceId,
      fileId: file.fileId,
      documentId: document.documentId,
      markdown: body,
      chunks: fileChunks,
      recognition: file.recognition?.method ? { method: file.recognition.method } : {}
    });
    documents.push(document);
    spans.push(...documentSpans);
    facts.push(...extractDocumentFacts(document, documentSpans));
  }

  const graph = linkDocumentFamily({ documents, facts });
  return {
    sourceId,
    extractionVersion: EXTRACTION_VERSION,
    inputHash: sha1(`${EXTRACTION_VERSION}|${inputHashes.join("|")}`),
    documents: graph.documents,
    spans,
    facts: graph.facts,
    relations: graph.relations,
    conflicts: graph.conflicts
  };
}

import assert from "node:assert/strict";
import test from "node:test";

import { chunkMarkdown, snippet, tokenize } from "../apps/rag-api/src/text.js";

test("tokenize lowercases words and drops one-character tokens", () => {
  assert.deepEqual(
    tokenize("Привет, RAG-UI x 42 _id qwen3.6"),
    ["привет", "rag-ui", "42", "_id", "qwen3"]
  );
});

test("chunkMarkdown groups normalized paragraphs up to the size limit", () => {
  assert.deepEqual(
    chunkMarkdown("Alpha\n\nBeta\n\nGamma", 12, 3),
    ["Alpha\n\nBeta", "Gamma"]
  );
});

test("chunkMarkdown can attach page metadata from OCR page headings", () => {
  const chunks = chunkMarkdown("## OCR page 12\n\nAlpha text", 120, 10, { documentType: "pdf" });

  assert.equal(chunks[0].text, "## OCR page 12\n\nAlpha text");
  assert.equal(chunks[0].documentType, "pdf");
  assert.equal(chunks[0].pageStart, 12);
  assert.equal(chunks[0].pageEnd, 12);
});

test("chunkMarkdown can attach sheet rows and section titles", () => {
  const sheetChunks = chunkMarkdown("## \u041b\u0438\u0441\u0442: \u0421\u043c\u0435\u0442\u0430\n\n| \u0421\u0442\u0440\u043e\u043a\u0430 | A |\n| --- | --- |\n| 4 | value |\n| 8 | value |", 400, 20, { documentType: "xlsx" });
  const mdChunks = chunkMarkdown("## \u041e\u043f\u043b\u0430\u0442\u0430\n\nTerms", 400, 20, { documentType: "md" });

  assert.equal(sheetChunks.at(-1).sheetName, "\u0421\u043c\u0435\u0442\u0430");
  assert.equal(sheetChunks.at(-1).rowStart, 4);
  assert.equal(sheetChunks.at(-1).rowEnd, 8);
  assert.equal(mdChunks[0].sectionTitle, "\u041e\u043f\u043b\u0430\u0442\u0430");
});

test("snippet returns context around the first matching query term", () => {
  assert.equal(snippet("Alpha beta gamma delta", "gamma", 6), "...beta gamma...");
});

test("snippet falls back to normalized leading text when no query term matches", () => {
  assert.equal(snippet(" Alpha\n\n beta gamma ", "missing", 5), "Alpha\n\n be");
});

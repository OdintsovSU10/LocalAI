import assert from "node:assert/strict";
import test from "node:test";

import { buildCitationTarget, formatCitationLabel } from "../apps/rag-api/src/citations.js";

test("formatCitationLabel includes PDF page", () => {
  assert.equal(
    formatCitationLabel({ title: "\u0414\u043e\u0433\u043e\u0432\u043e\u0440.pdf", pageStart: 12, pageEnd: 12 }),
    "\u0414\u043e\u0433\u043e\u0432\u043e\u0440.pdf, \u0441\u0442\u0440. 12"
  );
});

test("formatCitationLabel includes PDF page range", () => {
  assert.equal(
    formatCitationLabel({ title: "\u0414\u043e\u0433\u043e\u0432\u043e\u0440.pdf", pageStart: 12, pageEnd: 14 }),
    "\u0414\u043e\u0433\u043e\u0432\u043e\u0440.pdf, \u0441\u0442\u0440. 12-14"
  );
});

test("formatCitationLabel includes XLSX sheet name", () => {
  assert.equal(
    formatCitationLabel({ title: "\u041a\u041f.xlsx", sheetName: "\u0421\u043c\u0435\u0442\u0430", rowStart: 4, rowEnd: 8 }),
    "\u041a\u041f.xlsx, \u043b\u0438\u0441\u0442 \"\u0421\u043c\u0435\u0442\u0430\""
  );
});

test("formatCitationLabel includes document section title", () => {
  assert.equal(
    formatCitationLabel({ title: "\u0414\u043e\u043a\u0443\u043c\u0435\u043d\u0442.md", sectionTitle: "\u041e\u043f\u043b\u0430\u0442\u0430" }),
    "\u0414\u043e\u043a\u0443\u043c\u0435\u043d\u0442.md, \u0440\u0430\u0437\u0434\u0435\u043b \"\u041e\u043f\u043b\u0430\u0442\u0430\""
  );
});

test("formatCitationLabel supports nested metadata for old result wrappers", () => {
  assert.equal(
    formatCitationLabel({
      title: "\u041a\u041f.xlsx",
      metadata: { sheetName: "\u0421\u043c\u0435\u0442\u0430" }
    }),
    "\u041a\u041f.xlsx, \u043b\u0438\u0441\u0442 \"\u0421\u043c\u0435\u0442\u0430\""
  );
});

test("buildCitationTarget keeps stable chunk metadata and section label", () => {
  const target = buildCitationTarget({
    id: "chunk-123",
    fileId: "file-abc",
    sourceId: "source-a",
    title: "contract.md",
    path: "C:\\private\\contract.md",
    sectionTitle: "\u041e\u043f\u043b\u0430\u0442\u0430",
    chunkIndex: 4,
    snippet: "\u0426\u0435\u043d\u0430 \u0434\u043e\u0433\u043e\u0432\u043e\u0440\u0430"
  }, 2);

  assert.equal(target.citationId, 3);
  assert.equal(target.chunkId, "chunk-123");
  assert.equal(target.fileId, "file-abc");
  assert.equal(target.chunkIndex, 4);
  assert.equal(target.fileLabel, "contract.md");
  assert.equal(target.pathLabel, "contract.md");
  assert.match(target.label, /contract\.md/);
  assert.match(target.label, /\u041e\u043f\u043b\u0430\u0442\u0430/);
  assert.doesNotMatch(target.fileLabel, /private/);
  assert.doesNotMatch(target.pathLabel, /private/);
});

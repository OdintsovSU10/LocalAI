import assert from "node:assert/strict";
import test from "node:test";

import { matchesExclude, matchesInclude } from "../apps/rag-api/src/path-filter.js";

const defaultInclude = [
  "**/*.pdf",
  "**/*.txt",
  "**/*.md",
  "**/*.docx",
  "**/*.xlsx"
];

test("matchesInclude supports configured extension globs at root and nested paths", () => {
  assert.equal(matchesInclude("contract.pdf", defaultInclude), true);
  assert.equal(matchesInclude("docs/spec.TXT", defaultInclude), true);
  assert.equal(matchesInclude("nested/folder/report.docx", defaultInclude), true);
  assert.equal(matchesInclude("tables/budget.xlsx", defaultInclude), true);
  assert.equal(matchesInclude("notes/readme.md", defaultInclude), true);
});

test("matchesInclude rejects files outside configured globs", () => {
  assert.equal(matchesInclude("images/scan.png", defaultInclude), false);
  assert.equal(matchesInclude("archive/contract.zip", defaultInclude), false);
});

test("matchesInclude allows all files when include is empty or missing", () => {
  assert.equal(matchesInclude("anything.bin"), true);
  assert.equal(matchesInclude("anything.bin", []), true);
});

test("matchesExclude keeps existing substring exclusions", () => {
  const exclude = ["~$", "thumbs.db", ".ds_store"];

  assert.equal(matchesExclude("docs/~$draft.docx", exclude), true);
  assert.equal(matchesExclude("docs/thumbs.db", exclude), true);
  assert.equal(matchesExclude("docs/.DS_Store", exclude), true);
  assert.equal(matchesExclude("docs/contract.docx", exclude), false);
});

test("matchesExclude ignores default heavy and generated directories", () => {
  assert.equal(matchesExclude(".git/config"), true);
  assert.equal(matchesExclude("src/node_modules/pkg/index.js"), true);
  assert.equal(matchesExclude("data/cache/report.pdf"), true);
  assert.equal(matchesExclude("dist/bundle.js"), true);
  assert.equal(matchesExclude("build/output.txt"), true);
  assert.equal(matchesExclude(".cache/state.json"), true);
  assert.equal(matchesExclude(".venv/pyvenv.cfg"), true);
  assert.equal(matchesExclude("__pycache__/module.pyc"), true);
  assert.equal(matchesExclude("tmp/upload.pdf"), true);
  assert.equal(matchesExclude("temp/upload.pdf"), true);
});

test("matchesExclude does not treat directory names as arbitrary substrings", () => {
  assert.equal(matchesExclude("metadata/report.pdf"), false);
  assert.equal(matchesExclude("database/report.pdf"), false);
  assert.equal(matchesExclude("attempt/report.pdf"), false);
});

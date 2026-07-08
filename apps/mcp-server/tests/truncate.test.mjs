import assert from "node:assert/strict";
import test from "node:test";

import { makeSnippet, truncateFields, truncateText } from "../src/sanitize/truncate.js";

test("truncateText truncates long strings", () => {
  const result = truncateText("abcdefghijklmnopqrstuvwxyz", 10);
  assert.equal(result.truncated, true);
  assert.equal(result.text, "abcdefghij…");
});

test("truncateFields applies limits to selected fields", () => {
  const { record, truncated } = truncateFields(
    { excerpt: "x".repeat(100), label: "ok" },
    ["excerpt"],
    20
  );
  assert.equal(truncated, true);
  assert.equal(record.label, "ok");
  assert.equal(record.excerpt.length, 21);
});

test("makeSnippet returns bounded snippet text", () => {
  const snippet = makeSnippet("word ".repeat(200), 40);
  assert.ok(snippet.length <= 41);
});

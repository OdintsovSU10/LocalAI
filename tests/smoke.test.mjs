import assert from "node:assert/strict";
import test from "node:test";

test("smoke test runner works without external services", () => {
  assert.equal(typeof process.version, "string");
});

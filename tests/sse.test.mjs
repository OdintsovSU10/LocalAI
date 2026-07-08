import test from "node:test";
import assert from "node:assert/strict";
import { formatSseEvent } from "../apps/rag-api/src/sse.js";

test("formatSseEvent serializes JSON payloads", () => {
  assert.equal(
    formatSseEvent("status", { phase: "retrieval_started" }),
    'event: status\ndata: {"phase":"retrieval_started"}\n\n'
  );
});

test("formatSseEvent preserves multiline data using SSE data lines", () => {
  assert.equal(
    formatSseEvent("token", "line 1\nline 2"),
    "event: token\ndata: line 1\ndata: line 2\n\n"
  );
});

test("formatSseEvent sanitizes event names", () => {
  assert.equal(
    formatSseEvent("bad event:name", { ok: true }),
    'event: bad_event_name\ndata: {"ok":true}\n\n'
  );
});

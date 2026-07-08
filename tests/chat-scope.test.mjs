import assert from "node:assert/strict";
import test from "node:test";

import { hasAllSourcesIntent, resolveChatSourceScope } from "../apps/rag-api/src/chat-scope.js";

const sources = [
  {
    id: "alpha",
    title: "Alpha Tower",
    path: "C:\\projects\\Alpha Tower"
  },
  {
    id: "beta",
    title: "Beta Plaza",
    path: "C:\\projects\\Beta Plaza"
  }
];

test("generic auto chat scope searches all sources instead of requiring one project", () => {
  const scope = resolveChatSourceScope({
    question: "which email is written in the contracts",
    requestedSourceId: "",
    sources
  });

  assert.equal(scope.source, null);
  assert.equal(scope.sourceId, "");
  assert.equal(scope.searchAllSources, true);
  assert.equal(scope.requestedSourceMissing, false);
});

test("all-projects intent searches all sources even when a project is selected", () => {
  const scope = resolveChatSourceScope({
    question: "\u043f\u0440\u043e\u0432\u0435\u0440\u044c \u0432\u0441\u0435 \u043f\u0440\u043e\u0435\u043a\u0442\u044b \u0438 \u043d\u0430\u043f\u0438\u0448\u0438 email \u0438\u0437 \u0434\u043e\u0433\u043e\u0432\u043e\u0440\u043e\u0432",
    requestedSourceId: "beta",
    sources
  });

  assert.equal(scope.source, null);
  assert.equal(scope.sourceId, "");
  assert.equal(scope.searchAllSources, true);
  assert.equal(scope.requestedSourceMissing, false);
});

test("all-projects intent ignores stale selected source ids", () => {
  const scope = resolveChatSourceScope({
    question: "check all projects for contract emails",
    requestedSourceId: "missing",
    sources
  });

  assert.equal(scope.source, null);
  assert.equal(scope.sourceId, "");
  assert.equal(scope.searchAllSources, true);
  assert.equal(scope.requestedSourceMissing, false);
});

test("hasAllSourcesIntent recognizes Russian project wording", () => {
  assert.equal(
    hasAllSourcesIntent("\u043f\u043e \u0432\u0441\u0435\u043c \u043f\u0440\u043e\u0435\u043a\u0442\u0430\u043c \u043d\u0430\u0439\u0434\u0438 email"),
    true
  );
});

test("explicit chat source keeps project-scoped retrieval", () => {
  const scope = resolveChatSourceScope({
    question: "which email is written in the contracts",
    requestedSourceId: "beta",
    sources
  });

  assert.equal(scope.source.id, "beta");
  assert.equal(scope.sourceId, "beta");
  assert.equal(scope.searchAllSources, false);
  assert.equal(scope.requestedSourceMissing, false);
});

test("auto chat scope still matches a confident project name", () => {
  const scope = resolveChatSourceScope({
    question: "Alpha Tower contract email",
    requestedSourceId: "",
    sources
  });

  assert.equal(scope.source.id, "alpha");
  assert.equal(scope.sourceId, "alpha");
  assert.equal(scope.searchAllSources, false);
  assert.equal(scope.autoMatch.confident, true);
});

test("missing explicit source is not converted to all-source search", () => {
  const scope = resolveChatSourceScope({
    question: "Alpha Tower contract email",
    requestedSourceId: "missing",
    sources
  });

  assert.equal(scope.source, null);
  assert.equal(scope.sourceId, "");
  assert.equal(scope.searchAllSources, false);
  assert.equal(scope.requestedSourceMissing, true);
});

import assert from "node:assert/strict";
import test from "node:test";

import { expandedChatRetrievalQuery, hasBroadAnswerIntent } from "../apps/rag-api/src/chat-intent.js";

test("hasBroadAnswerIntent recognizes Russian contract overview requests", () => {
  assert.equal(hasBroadAnswerIntent("Какие основные условия по договору Алия Астериус?"), true);
  assert.equal(hasBroadAnswerIntent("Сделай обзор договора по проекту"), true);
});

test("expandedChatRetrievalQuery adds contract overview terms only for broad contract questions", () => {
  const expanded = expandedChatRetrievalQuery("Какие основные условия договора?");

  assert.match(expanded, /гарантийное удержание/);
  assert.match(expanded, /ответственность штраф/);
  assert.equal(expandedChatRetrievalQuery("Найди email в договоре"), "Найди email в договоре");
});

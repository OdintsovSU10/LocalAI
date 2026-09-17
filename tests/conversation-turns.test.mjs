import assert from "node:assert/strict";
import test from "node:test";

import {
  MAX_CONTEXT_TURNS,
  MAX_HISTORY_ANSWER_CHARS,
  buildConversationContext,
  buildConversationTurns,
  followUpRetrievalQuery,
  historyAnswerText,
  historyMessages,
  isFollowUpQuestion
} from "../apps/rag-api/src/answer-core/conversation-turns.js";

function messagesForTurns(count) {
  return Array.from({ length: count }, (_value, index) => [
    { role: "user", text: `Вопрос ${index + 1}` },
    { role: "assistant", text: `Ответ ${index + 1} [1].\n\nИсточники: [1].`, scope: { matchedSourceId: "p1" } }
  ]).flat();
}

test("buildConversationTurns keeps only the most recent bounded turns", () => {
  const turns = buildConversationTurns(messagesForTurns(MAX_CONTEXT_TURNS + 3));
  assert.equal(turns.length, MAX_CONTEXT_TURNS);
  assert.equal(turns[0].question, "Вопрос 4");
  assert.equal(turns.at(-1).answer, `Ответ ${MAX_CONTEXT_TURNS + 3}.`);
  assert.equal(turns.at(-1).sourceId, "p1");
});

test("buildConversationTurns skips unanswered questions", () => {
  const turns = buildConversationTurns([
    { role: "user", text: "Первый" },
    { role: "user", text: "Второй" },
    { role: "assistant", text: "Ответ на второй" },
    { role: "user", text: "Третий без ответа" }
  ]);
  assert.deepEqual(turns.map((turn) => turn.question), ["Второй"]);
});

test("historyAnswerText strips old citation numbers and truncates long answers", () => {
  assert.equal(historyAnswerText("Аванс 10% [1], срок 30 дней [2, 3].\n\nИсточники: [1], [2]."), "Аванс 10%, срок 30 дней.");
  const long = historyAnswerText("а".repeat(MAX_HISTORY_ANSWER_CHARS + 50));
  assert.equal(long.length, MAX_HISTORY_ANSWER_CHARS + 1);
  assert.ok(long.endsWith("…"));
});

test("buildConversationContext exposes the pinned project and turns", () => {
  const context = buildConversationContext({ id: "c1", pinnedSourceId: "pv2-balchug" }, messagesForTurns(1));
  assert.deepEqual(context, {
    conversationId: "c1",
    pinnedSourceId: "pv2-balchug",
    turns: [{ question: "Вопрос 1", answer: "Ответ 1.", sourceId: "p1" }]
  });
  assert.equal(buildConversationContext(null, []), null);
});

test("follow-up detection is deterministic", () => {
  assert.equal(isFollowUpQuestion("а какой срок выплаты?"), true);
  assert.equal(isFollowUpQuestion("И гарантийный срок?"), true);
  assert.equal(isFollowUpQuestion("Срок выплаты?"), true);
  assert.equal(isFollowUpQuestion("Какой размер гарантийного удержания по договору на Стромынке?"), false);
  assert.equal(isFollowUpQuestion(""), false);
});

test("followUpRetrievalQuery adds the previous question only for follow-ups", () => {
  const turns = [{ question: "Какой размер гарантийного удержания по Стромынке?", answer: "3%." }];
  assert.equal(
    followUpRetrievalQuery("а какой срок выплаты?", "а какой срок выплаты?", turns),
    "а какой срок выплаты?\nКакой размер гарантийного удержания по Стромынке?"
  );
  const standalone = "Какая цена договора по Балчугу на текущий момент?";
  assert.equal(followUpRetrievalQuery(standalone, standalone, turns), standalone);
  assert.equal(followUpRetrievalQuery("а срок?", "а срок?", []), "а срок?");
});

test("historyMessages alternates user and assistant roles", () => {
  assert.deepEqual(historyMessages([{ question: "Q", answer: "A" }, { question: "Q2", answer: "" }]), [
    { role: "user", content: "Q" },
    { role: "assistant", content: "A" },
    { role: "user", content: "Q2" },
    { role: "assistant", content: "(ответ не сохранён)" }
  ]);
});

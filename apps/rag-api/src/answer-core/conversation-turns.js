// Bounded conversation context for multi-turn answers. The model sees a few recent turns only to
// resolve what a short follow-up refers to; facts still come from the numbered evidence context.

export const MAX_CONTEXT_TURNS = 6;
export const MAX_HISTORY_ANSWER_CHARS = 600;
export const MAX_HISTORY_QUESTION_CHARS = 400;

const FOLLOW_UP_START = /^(?:а|и|ну|также|тоже|еще|ещё|тогда|то есть|а если|and|also|what about)(?:\s|,|$)/iu;
const FOLLOW_UP_MAX_WORDS = 4;

function words(text) {
  return String(text || "").toLowerCase().match(/[\p{L}\p{N}]+/gu) || [];
}

// Citation numbers belong to the old evidence list, so they are removed from history answers.
export function historyAnswerText(answer = "") {
  const text = String(answer || "")
    .replace(/(^|\n)\s*Источники\s*:[^\n]*/giu, "")
    .replace(/\s*\[\d+(?:\s*[,–-]\s*\d+)*\]/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return text.length > MAX_HISTORY_ANSWER_CHARS ? `${text.slice(0, MAX_HISTORY_ANSWER_CHARS).trim()}…` : text;
}

// Pairs stored user/assistant messages into turns and keeps the most recent ones.
export function buildConversationTurns(messages = [], { maxTurns = MAX_CONTEXT_TURNS } = {}) {
  const turns = [];
  let pendingQuestion = null;
  for (const message of messages) {
    if (message.role === "user") {
      pendingQuestion = message;
    } else if (message.role === "assistant" && pendingQuestion) {
      turns.push({
        question: String(pendingQuestion.text || "").slice(0, MAX_HISTORY_QUESTION_CHARS),
        answer: historyAnswerText(message.text),
        sourceId: String(message.scope?.matchedSourceId || "")
      });
      pendingQuestion = null;
    }
  }
  return turns.slice(-Math.max(0, maxTurns));
}

export function buildConversationContext(conversation, messages = [], options = {}) {
  if (!conversation) return null;
  return {
    conversationId: conversation.id,
    pinnedSourceId: conversation.pinnedSourceId || "",
    turns: buildConversationTurns(messages, options)
  };
}

export function isFollowUpQuestion(question = "") {
  const text = String(question || "").trim();
  if (!text) return false;
  return FOLLOW_UP_START.test(text) || words(text).length <= FOLLOW_UP_MAX_WORDS;
}

// "а какой срок выплаты?" alone retrieves poorly; the previous question supplies the subject.
export function followUpRetrievalQuery(retrievalQuery, question, turns = []) {
  const previous = turns.at(-1)?.question || "";
  if (!previous || !isFollowUpQuestion(question)) return retrievalQuery;
  return `${retrievalQuery}\n${previous}`;
}

export function historyMessages(turns = []) {
  return turns.flatMap((turn) => [
    { role: "user", content: turn.question },
    { role: "assistant", content: turn.answer || "(ответ не сохранён)" }
  ]);
}

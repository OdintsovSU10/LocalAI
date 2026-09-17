import crypto from "node:crypto";

import { buildConversationContext, MAX_CONTEXT_TURNS } from "../answer-core/conversation-turns.js";

export class ConversationNotFoundError extends Error {
  constructor() {
    super("conversation not found");
    this.statusCode = 404;
  }
}

// Until the verifier exists (Stage 07) an LLM answer is stored as "unverified", never as verified.
export function turnAnswerStatus(payload = {}) {
  if (Array.isArray(payload.projectCandidates)) return "clarification_required";
  if (payload.fallbackReason === "llm_failed") return "system_error";
  if (!Array.isArray(payload.sources) || !payload.sources.length) return "insufficient_evidence";
  return "unverified";
}

// Resolves an optional conversationId from a chat request into the store handle and bounded context.
export async function loadChatConversation(conversationId, { getStore, channel = "web" }) {
  const id = String(conversationId || "").trim();
  if (!id) return null;
  const store = await getStore();
  const conversation = store.getConversation(id, { channel });
  if (!conversation) throw new ConversationNotFoundError();
  const recentMessages = store.listMessages(conversation.id, { limit: MAX_CONTEXT_TURNS * 2 + 2 });
  return { store, conversation, context: buildConversationContext(conversation, recentMessages) };
}

// Saves the question/answer pair after a completed answer. A storage failure must not lose the answer.
export function persistChatTurn(chatConversation, input, payload) {
  const { store, conversation } = chatConversation;
  const traceId = crypto.randomUUID();
  const matchedSourceId = payload.matchedSource?.id || "";
  try {
    const ids = store.appendTurn(conversation.id, {
      question: input.question,
      answer: payload.answer,
      userScope: {
        requestedSourceId: input.requestedSourceId || "",
        contextSourceId: input.contextSourceId || "",
        pinnedSourceId: conversation.pinnedSourceId || ""
      },
      assistant: {
        sources: payload.sources,
        scope: { matchedSourceId },
        answerStatus: turnAnswerStatus(payload),
        traceId,
        pinnedSourceId: matchedSourceId
      }
    });
    return { ...payload, conversationId: conversation.id, turn: { traceId, ...ids } };
  } catch (error) {
    console.error(`Conversation turn was not saved: ${error.message}`);
    return { ...payload, conversationId: conversation.id, turn: null };
  }
}

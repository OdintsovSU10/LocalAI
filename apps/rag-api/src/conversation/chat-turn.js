import crypto from "node:crypto";

import { buildConversationContext, MAX_CONTEXT_TURNS } from "../answer-core/conversation-turns.js";
import { planSummary } from "../answer-core/query-planner.js";

export class ConversationNotFoundError extends Error {
  constructor() {
    super("conversation not found");
    this.statusCode = 404;
  }
}

// Until the verifier exists (Stage 07) an LLM answer is stored as "unverified", never as verified.
export function turnAnswerStatus(payload = {}) {
  if (payload.answerStatus) return payload.answerStatus;
  if (Array.isArray(payload.projectCandidates)) return "clarification_required";
  if (payload.fallbackReason === "llm_failed") return "system_error";
  if (!Array.isArray(payload.sources) || !payload.sources.length) return "insufficient_evidence";
  return "unverified";
}

// Stored with the assistant message: statuses and issue codes only, no claim or evidence text.
export function verificationSummary(verification) {
  if (!verification) return null;
  return {
    level: verification.level,
    verifier: verification.verifier || null,
    overall: verification.overall || "",
    repairs: verification.repairs || 0,
    shownClaims: verification.shownClaims || 0,
    droppedClaims: verification.droppedClaims || 0,
    reason: verification.reason || "",
    claims: (verification.claims || []).map(({ claimId, kind, status, shown, issues }) => ({ claimId, kind, status, shown, issues }))
  };
}

// Resolves an optional conversationId from a chat request into the store handle and bounded context.
export async function loadChatConversation(conversationId, { getStore, channel = "web" }) {
  const id = String(conversationId || "").trim();
  if (!id) return null;
  const store = await getStore();
  const conversation = store.getConversation(id, { channel });
  if (!conversation) throw new ConversationNotFoundError();
  const recentMessages = store.listMessages(conversation.id, { limit: MAX_CONTEXT_TURNS * 2 + 2 });
  const context = {
    ...buildConversationContext(conversation, recentMessages),
    pendingClarification: store.getPendingClarification(conversation.id)
  };
  return { store, conversation, context };
}

// Saves the question/answer pair after a completed answer and keeps (or clears) the pending clarification.
// A storage failure must not lose the answer.
export function persistChatTurn(chatConversation, input, payload, plan = null) {
  const { store, conversation, context } = chatConversation;
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
        scope: { matchedSourceId, plan: planSummary(plan) },
        answerStatus: turnAnswerStatus(payload),
        verifier: verificationSummary(payload.verification),
        traceId,
        pinnedSourceId: matchedSourceId
      }
    });
    // At most one clarification per turn: a new one replaces the pending state, any other answer clears it.
    if (payload.clarification || context?.pendingClarification) {
      store.setPendingClarification(conversation.id, payload.clarification || null);
    }
    return { ...payload, conversationId: conversation.id, turn: { traceId, ...ids } };
  } catch (error) {
    console.error(`Conversation turn was not saved: ${error.message}`);
    return { ...payload, conversationId: conversation.id, turn: null };
  }
}

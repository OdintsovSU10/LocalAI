import { hasBroadAnswerIntent } from "../chat-intent.js";
import { hasAllSourcesIntent } from "../chat-scope.js";
import { matchSourceForQuestion } from "../source-match.js";
import { contractSources, isTenderSource } from "../source-scope.js";
import { isFollowUpQuestion } from "./conversation-turns.js";

// Deterministic query planner (Product V2, Stage 05). It decides scope, intent and whether a question
// must be clarified before retrieval. There is no LLM planner yet: these rules are the planner, and the
// legacy scope resolution (resolveChatSourceScope / auto-match) remains the fallback when planning fails.

export const PLANNER_VERSION = "rules/1";

// Two projects "really match" when neither is a confident auto-match and both match by name
// with a comparable score (the same thresholds source-match.js uses for confidence).
const MIN_CANDIDATE_SCORE = 5;
const CANDIDATE_SCORE_SPREAD = 1.5;
const MAX_CLARIFICATION_OPTIONS = 5;
const MAX_REPLY_WORDS = 6;
// Words that may surround a project name in a choice ("проект Стромынка", "по Стромынке", "вариант 2").
const CHOICE_FILLER = new Set([
  "проект", "проекта", "проекту", "проектом", "объект", "объекта", "жк", "по", "для", "в", "во", "на", "про",
  "это", "да", "вариант", "номер", "выбираю", "нужен", "нужно"
]);
const NUMBER_REPLY = /^(?:(?:вариант|номер|пункт)\s*)?№?\s*(\d{1,2})\s*[).]?$/iu;

const ENTITY_PATTERNS = [
  ["contract_price", /цен\p{L}*\s+договор|стоимост\p{L}*\s+(?:договор|работ)|сумм\p{L}*\s+договор/iu],
  ["vat_rate", /ндс/iu],
  ["advance_percent", /аванс/iu],
  ["retention_percent", /гарантийн\p{L}*\s+удержани/iu],
  ["retention_return_term", /(?:возврат|выплат)\p{L}*[^.?]{0,40}удержани|удержани\p{L}*[^.?]{0,40}(?:возврат|выплат)|срок\p{L}*\s+выплат/iu],
  ["warranty_period", /гарантийн\p{L}*\s+срок/iu],
  ["work_start_date", /начал\p{L}*\s+работ/iu],
  ["work_end_date", /(?:окончани|заверш)\p{L}*\s+работ|срок\p{L}*\s+(?:выполнения|окончания)/iu],
  ["penalty_rate", /неустойк|пени|штраф/iu],
  ["party_customer", /заказчик/iu],
  ["party_contractor", /(?:ген)?подрядчик/iu],
  ["estimate_total", /смет/iu]
];

// JavaScript \b is ASCII-only even with the u flag, so Cyrillic word edges use Unicode lookarounds.
const HISTORICAL_VERSION = /первоначальн|изначальн|исходн\p{L}*\s+редакци|до\s+(?:подписания\s+)?(?:доп\p{L}*\s+соглашени|дс(?![\p{L}\p{N}]))|в\s+редакции\s+договора|старая\s+редакция|прежн\p{L}*\s+(?:редакци|услови)/iu;
const ALL_VERSIONS = /истори\p{L}*\s+изменени|все\s+редакции|как\s+менял|изменени\p{L}*\s+(?:по|всех)\s+(?:доп\p{L}*\s+соглашени|дс(?![\p{L}\p{N}]))/iu;
const COMPARE = /сравн|разниц|отлича|чем\s+отлича/iu;
const FIND_DOCUMENT = /(?:найди|покажи|где)\s+(?:документ|файл|договор|акт|письм|смет)|какой\s+документ|в\s+каком\s+(?:документе|файле)/iu;
const TENDER_WORDS = /(?<![\p{L}\p{N}])кп(?![\p{L}\p{N}])|коммерческ\p{L}*\s+предложени|тендер/iu;
const CONTRACT_WORDS = /договор|(?<![\p{L}\p{N}])дс(?![\p{L}\p{N}])|доп\p{L}*\s+соглашени|аванс|удержани|неустойк|гарант/iu;
const DATE = /\b\d{2}\.\d{2}\.\d{4}\b/g;

function detectEntities(question) {
  return ENTITY_PATTERNS.filter(([, pattern]) => pattern.test(question)).map(([type]) => type);
}

function detectIntent(question, { allSources, followUp }) {
  if (allSources) return "aggregate";
  if (COMPARE.test(question)) return "compare";
  if (FIND_DOCUMENT.test(question)) return "find_document";
  if (followUp) return "follow_up";
  if (hasBroadAnswerIntent(question)) return "overview";
  return "fact";
}

function detectDomain(question, sources, sourceIds) {
  if (TENDER_WORDS.test(question)) return "tender";
  const scoped = sources.filter((source) => sourceIds.includes(source.id));
  if (scoped.length && scoped.every((source) => isTenderSource(source))) return "tender";
  if (CONTRACT_WORDS.test(question) || scoped.length) return "contract";
  return "unknown";
}

function versionPolicy(question) {
  if (ALL_VERSIONS.test(question)) return "all";
  if (HISTORICAL_VERSION.test(question)) return "historical";
  return "current";
}

function comparableCandidates(autoMatch) {
  const candidates = (autoMatch?.candidates || []).filter((candidate) => candidate.matchedTokens?.length && candidate.score >= MIN_CANDIDATE_SCORE);
  if (!candidates.length) return [];
  const best = Math.max(...candidates.map((candidate) => candidate.score));
  return candidates.filter((candidate) => candidate.score >= best - CANDIDATE_SCORE_SPREAD);
}

export function projectClarification(originalQuestion, candidates) {
  const options = candidates.slice(0, MAX_CLARIFICATION_OPTIONS).map((candidate, index) => ({
    index: index + 1,
    sourceId: candidate.id,
    title: candidate.title
  }));
  const list = options.map((option) => `${option.index}) ${option.title}`).join("; ");
  return {
    kind: "project",
    originalQuestion,
    question: `Вопрос подходит к нескольким проектам: ${list}. Уточните, к какому проекту он относится — ответьте номером или названием.`,
    options
  };
}

function replyWords(text) {
  return String(text || "").toLowerCase().replaceAll("ё", "е").match(/[\p{L}\p{N}]+/gu) || [];
}

/**
 * Resolves a reply to a pending project clarification.
 * - { sourceId, question }: the reply picks an option (explicit project, option number, or a reply that is
 *   the project name alone — besides the name only filler words like "проект", "по", "ЖК" are allowed);
 * - { invalid: true, number }: an option number that does not exist — the clarification is asked again;
 * - null: the reply is a new question ("Назови цену по Стромынке" names a project but asks something else).
 */
export function resolveClarificationReply(pending, { question = "", requestedSourceId = "", sources = [] } = {}) {
  const options = Array.isArray(pending?.options) ? pending.options : [];
  if (pending?.kind !== "project" || !options.length || !pending.originalQuestion) return null;
  const chosen = (sourceId) => (options.some((option) => option.sourceId === sourceId) ? { sourceId, question: pending.originalQuestion } : null);

  if (requestedSourceId) return chosen(requestedSourceId);
  const text = String(question).trim();
  const number = text.match(NUMBER_REPLY);
  if (number) {
    const option = options.find((item) => item.index === Number(number[1]));
    return option ? chosen(option.sourceId) : { invalid: true, number: Number(number[1]) };
  }

  const words = replyWords(text);
  if (!words.length || words.length > MAX_REPLY_WORDS) return null;
  const optionSources = sources.filter((source) => options.some((option) => option.sourceId === source.id));
  const match = matchSourceForQuestion(text, optionSources);
  if (!match.source || !match.confident) return null;
  const nameWords = new Set(match.matchedTokens.flatMap((token) => replyWords(token)));
  const otherWords = words.filter((word) => !nameWords.has(word) && !CHOICE_FILLER.has(word));
  return otherWords.length ? null : chosen(match.source.id);
}

function repeatedClarification(pending, number) {
  const again = projectClarification(pending.originalQuestion, pending.options.map((option) => ({ id: option.sourceId, title: option.title })));
  return { ...again, question: `Варианта ${number} нет. ${again.question}` };
}

/**
 * Builds a query plan. `needsClarification` is set only when the question names several projects that
 * match equally well and neither an explicit project nor the conversation's pinned project decides it,
 * or when a reply to a pending clarification names an option number that does not exist.
 */
export function planQuery({ question = "", requestedSourceId = "", contextSourceId = "", conversationContext = null, sources = [] } = {}) {
  const pending = conversationContext?.pendingClarification || null;
  const reply = pending ? resolveClarificationReply(pending, { question, requestedSourceId, sources }) : null;
  const resume = reply?.sourceId ? reply : null;
  const effectiveQuestion = reply?.invalid ? pending.originalQuestion : (resume?.question || question);
  const effectiveSourceId = resume?.sourceId || requestedSourceId;
  const turns = Array.isArray(conversationContext?.turns) ? conversationContext.turns : [];
  const allSources = hasAllSourcesIntent(effectiveQuestion);
  const followUp = turns.length > 0 && isFollowUpQuestion(effectiveQuestion);
  const pinnedSourceId = contextSourceId || conversationContext?.pinnedSourceId || "";

  // A wrong option number keeps the pending clarification and asks it again instead of answering "9".
  let clarification = reply?.invalid ? repeatedClarification(pending, reply.number) : null;
  let sourceScope = effectiveSourceId ? [effectiveSourceId] : [];
  if (!clarification && !effectiveSourceId && !allSources) {
    const autoMatch = matchSourceForQuestion(effectiveQuestion, contractSources(sources));
    if (autoMatch.source) {
      sourceScope = [autoMatch.source.id];
    } else {
      const candidates = comparableCandidates(autoMatch);
      if (candidates.length >= 2 && !candidates.some((candidate) => candidate.id === pinnedSourceId)) {
        clarification = projectClarification(effectiveQuestion, candidates);
      } else if (pinnedSourceId) {
        sourceScope = [pinnedSourceId];
      }
    }
  }

  const entities = detectEntities(effectiveQuestion);
  const dates = effectiveQuestion.match(DATE) || [];
  return {
    plannerVersion: PLANNER_VERSION,
    question: effectiveQuestion,
    requestedSourceId: effectiveSourceId,
    intent: detectIntent(effectiveQuestion, { allSources, followUp }),
    domain: detectDomain(effectiveQuestion, sources, sourceScope),
    sourceScope: allSources ? "all" : sourceScope,
    documentScope: [],
    entities,
    timeScope: dates.length ? { dates } : null,
    versionPolicy: versionPolicy(effectiveQuestion),
    retrievalMode: entities.length ? "mixed" : "rag",
    subquestions: [],
    needsClarification: Boolean(clarification),
    clarification,
    resumedFromClarification: Boolean(resume)
  };
}

// Safe summary for storage/trace: no question text beyond what the conversation already stores.
export function planSummary(plan) {
  if (!plan) return null;
  return {
    plannerVersion: plan.plannerVersion,
    intent: plan.intent,
    domain: plan.domain,
    sourceScope: plan.sourceScope,
    entities: plan.entities,
    versionPolicy: plan.versionPolicy,
    retrievalMode: plan.retrievalMode,
    needsClarification: plan.needsClarification,
    resumedFromClarification: plan.resumedFromClarification,
    fallback: Boolean(plan.fallback)
  };
}

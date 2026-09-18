import assert from "node:assert/strict";
import test from "node:test";

import { planQuery, planSummary, resolveClarificationReply } from "../apps/rag-api/src/answer-core/query-planner.js";

const sources = [
  { id: "pv2-stromynka", title: "ЖК Сокольники, Стромынка", path: "fixtures/product-v2/stromynka", sourceType: "contract" },
  { id: "pv2-rusakovskaya", title: "Сокольники Парк, Русаковская", path: "fixtures/product-v2/rusakovskaya", sourceType: "contract" },
  { id: "pv2-balchug", title: "Балчуг, Садовническая", path: "fixtures/product-v2/balchug", sourceType: "contract" }
];

test("two equally matching projects produce one clarification with both candidates", () => {
  const plan = planQuery({ question: "Какой аванс по Сокольникам?", sources });
  assert.equal(plan.needsClarification, true);
  assert.equal(plan.clarification.kind, "project");
  assert.equal(plan.clarification.originalQuestion, "Какой аванс по Сокольникам?");
  assert.deepEqual(plan.clarification.options.map((option) => [option.index, option.sourceId]), [[1, "pv2-stromynka"], [2, "pv2-rusakovskaya"]]);
  assert.match(plan.clarification.question, /1\) ЖК Сокольники, Стромынка; 2\) Сокольники Парк, Русаковская/);
});

test("no clarification when an explicit project, a confident match or the pinned project decides the scope", () => {
  assert.equal(planQuery({ question: "Какой аванс по Сокольникам?", requestedSourceId: "pv2-balchug", sources }).needsClarification, false);
  assert.deepEqual(planQuery({ question: "Какой аванс по Стромынке?", sources }).sourceScope, ["pv2-stromynka"]);

  const pinned = planQuery({ question: "Какой аванс по Сокольникам?", conversationContext: { pinnedSourceId: "pv2-rusakovskaya", turns: [] }, sources });
  assert.equal(pinned.needsClarification, false);
  assert.deepEqual(pinned.sourceScope, ["pv2-rusakovskaya"]);

  // A pinned project that is not among the candidates does not decide an explicitly different name.
  const otherPin = planQuery({ question: "Какой аванс по Сокольникам?", conversationContext: { pinnedSourceId: "pv2-balchug", turns: [] }, sources });
  assert.equal(otherPin.needsClarification, true);
});

test("all-projects questions are not narrowed to one source and never clarified", () => {
  const plan = planQuery({ question: "Какой аванс по всем проектам?", sources });
  assert.equal(plan.sourceScope, "all");
  assert.equal(plan.intent, "aggregate");
  assert.equal(plan.needsClarification, false);
});

test("follow-up, entities, version policy and retrieval mode are planned deterministically", () => {
  const followUp = planQuery({
    question: "а какой срок выплаты?",
    conversationContext: { pinnedSourceId: "pv2-stromynka", turns: [{ question: "Какой размер гарантийного удержания?", answer: "3%." }] },
    sources
  });
  assert.equal(followUp.intent, "follow_up");
  assert.deepEqual(followUp.sourceScope, ["pv2-stromynka"]);
  assert.ok(followUp.entities.includes("retention_return_term"));

  const retention = planQuery({ question: "Какой размер гарантийного удержания и срок его возврата по Стромынке?", sources });
  assert.deepEqual(retention.entities, ["retention_percent", "retention_return_term"]);
  assert.equal(retention.retrievalMode, "mixed");
  assert.equal(retention.domain, "contract");
  assert.equal(retention.versionPolicy, "current");

  assert.equal(planQuery({ question: "Какой аванс был в первоначальной редакции договора по Стромынке?", sources }).versionPolicy, "historical");
  assert.equal(planQuery({ question: "Покажи историю изменений аванса по Стромынке", sources }).versionPolicy, "all");
  assert.equal(planQuery({ question: "Кто ответственный контакт?", sources }).retrievalMode, "rag");
  assert.deepEqual(planQuery({ question: "Что изменилось с 15.05.2026 по Стромынке?", sources }).timeScope, { dates: ["15.05.2026"] });
});

test("a clarification reply picks an option by number, explicit project or short name only", () => {
  const pending = planQuery({ question: "Какой аванс по Сокольникам?", sources }).clarification;
  const resolve = (question, requestedSourceId = "") => resolveClarificationReply(pending, { question, requestedSourceId, sources });

  assert.deepEqual(resolve("2"), { sourceId: "pv2-rusakovskaya", question: "Какой аванс по Сокольникам?" });
  assert.deepEqual(resolve("1)"), { sourceId: "pv2-stromynka", question: "Какой аванс по Сокольникам?" });
  assert.deepEqual(resolve("Русаковская"), { sourceId: "pv2-rusakovskaya", question: "Какой аванс по Сокольникам?" });
  assert.deepEqual(resolve("ЖК Сокольники, Стромынка"), { sourceId: "pv2-stromynka", question: "Какой аванс по Сокольникам?" });
  assert.deepEqual(resolve("", "pv2-stromynka"), { sourceId: "pv2-stromynka", question: "Какой аванс по Сокольникам?" });

  assert.deepEqual(resolve("3"), { invalid: true, number: 3 }, "number outside the options is not a new question");
  assert.equal(resolve("Балчуг"), null, "a project that was not offered");
  assert.equal(resolve("", "pv2-balchug"), null);
  assert.equal(resolve("Какая цена договора по Стромынке?"), null, "a full new question is not a choice");
});

test("a resolved reply resumes the original question for the chosen project", () => {
  const pending = planQuery({ question: "Какой аванс по Сокольникам?", sources }).clarification;
  const plan = planQuery({ question: "2", conversationContext: { pendingClarification: pending, turns: [] }, sources });
  assert.equal(plan.resumedFromClarification, true);
  assert.equal(plan.needsClarification, false);
  assert.equal(plan.question, "Какой аванс по Сокольникам?");
  assert.equal(plan.requestedSourceId, "pv2-rusakovskaya");

  const unrelated = planQuery({ question: "Какая цена договора по Балчугу?", conversationContext: { pendingClarification: pending, turns: [] }, sources });
  assert.equal(unrelated.resumedFromClarification, false);
  assert.equal(unrelated.question, "Какая цена договора по Балчугу?");
});

// Revision 1 regressions (independent verification findings).

test("a new request that names a project is not a choice, even without a question mark", () => {
  const pending = planQuery({ question: "Какой аванс по Сокольникам?", sources }).clarification;
  const resolve = (question) => resolveClarificationReply(pending, { question, sources });
  for (const newRequest of ["Назови цену по Стромынке", "Сроки по Русаковской", "Стромынка, какая цена"]) {
    assert.equal(resolve(newRequest), null, newRequest);
  }
  for (const [reply, sourceId] of [
    ["по Стромынке", "pv2-stromynka"],
    ["проект Стромынка", "pv2-stromynka"],
    ["Стромынка?", "pv2-stromynka"],
    ["вариант 1", "pv2-stromynka"],
    ["№2", "pv2-rusakovskaya"]
  ]) {
    assert.deepEqual(resolve(reply), { sourceId, question: "Какой аванс по Сокольникам?" }, reply);
  }

  const plan = planQuery({ question: "Назови цену по Стромынке", conversationContext: { pendingClarification: pending, turns: [] }, sources });
  assert.equal(plan.resumedFromClarification, false);
  assert.equal(plan.question, "Назови цену по Стромынке");
  assert.deepEqual(plan.sourceScope, ["pv2-stromynka"]);
});

test("a wrong option number asks the same clarification again and keeps the original question", () => {
  const pending = planQuery({ question: "Какой аванс по Сокольникам?", sources }).clarification;
  const invalid = planQuery({ question: "9", conversationContext: { pendingClarification: pending, turns: [] }, sources });
  assert.equal(invalid.needsClarification, true);
  assert.equal(invalid.resumedFromClarification, false);
  assert.equal(invalid.clarification.originalQuestion, "Какой аванс по Сокольникам?");
  assert.deepEqual(invalid.clarification.options, pending.options);
  assert.match(invalid.clarification.question, /^Варианта 9 нет\. Вопрос подходит к нескольким проектам/);

  const again = planQuery({ question: "8", conversationContext: { pendingClarification: invalid.clarification, turns: [] }, sources });
  assert.match(again.clarification.question, /^Варианта 8 нет\. Вопрос подходит/, "the prefix is not stacked");

  const chosen = planQuery({ question: "2", conversationContext: { pendingClarification: invalid.clarification, turns: [] }, sources });
  assert.equal(chosen.resumedFromClarification, true);
  assert.equal(chosen.question, "Какой аванс по Сокольникам?");
  assert.equal(chosen.requestedSourceId, "pv2-rusakovskaya");
});

test("Cyrillic abbreviations are matched as whole words (ДС, КП)", () => {
  assert.equal(planQuery({ question: "Какой аванс был до ДС?", sources }).versionPolicy, "historical");
  assert.equal(planQuery({ question: "Какой аванс был до ДС №1 по Стромынке?", sources }).versionPolicy, "historical");
  assert.equal(planQuery({ question: "Какой аванс по ДСК-1?", sources }).versionPolicy, "current");
  assert.equal(planQuery({ question: "Как менялся аванс, изменения по ДС", sources }).versionPolicy, "all");
  assert.equal(planQuery({ question: "Какая цена в КП?", sources }).domain, "tender");
  assert.notEqual(planQuery({ question: "Какой КПП у заказчика?", sources }).domain, "tender");
  assert.equal(planQuery({ question: "Что изменил ДС?", sources }).domain, "contract");
});

test("planSummary keeps only safe plan fields", () => {
  const summary = planSummary(planQuery({ question: "Какой аванс по Сокольникам?", sources }));
  assert.deepEqual(Object.keys(summary).sort(), [
    "domain", "entities", "fallback", "intent", "needsClarification", "plannerVersion",
    "resumedFromClarification", "retrievalMode", "sourceScope", "versionPolicy"
  ]);
  assert.equal(planSummary(null), null);
});

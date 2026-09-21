import assert from "node:assert/strict";
import test from "node:test";

import {
  DraftParseError,
  stripInlineEvidenceLabels,
  buildDraftMessages,
  evidenceBlock,
  labelEvidence,
  normalizeEvidenceLabel,
  parseDraft
} from "../apps/rag-api/src/answer-core/answer-draft.js";
import { parseVerdict, resolveVerifier } from "../apps/rag-api/src/answer-core/answer-verifier.js";

const result = (id, text, overrides = {}) => ({ id, evidenceId: `ev-${id}`, sourceId: "p1", sourceTitle: "Проект", title: "dogovor.md", text, citationLabel: "dogovor.md, п. 3", ...overrides });

test("labelEvidence numbers packet items once and keeps labels stable when evidence is added", () => {
  const first = labelEvidence([result("a", "A"), result("b", "B"), result("a", "A again")]);
  assert.deepEqual(first.items.map(({ label }) => label), ["E1", "E2"]);
  const extended = labelEvidence([result("b", "B"), result("c", "C")], first);
  assert.deepEqual(extended.items.map(({ label, item }) => `${label}:${item.id}`), ["E1:a", "E2:b", "E3:c"]);
  assert.equal(first.items.length, 2, "the original labelling is not mutated");
});

test("evidence block marks replaced and conflicting clauses and respects the context profile", () => {
  const labelled = labelEvidence([
    result("a", "Аванс 20%", { retrievalReason: "fact:advance_percent:superseded" }),
    result("b", "Цена 245 000 000", { retrievalReason: "fact:contract_price:conflict" }),
    result("c", "x".repeat(2000))
  ]);
  const block = evidenceBlock(labelled, { maxSources: 2, maxCharsPerSource: 500 });
  assert.match(block, /^\[E1\] Проект: Проект \| Место: dogovor\.md, п\. 3 \| Статус: заменённая редакция/);
  assert.match(block, /\[E2\].*Статус: значение расходится/);
  assert.ok(!block.includes("[E3]"));

  const messages = buildDraftMessages({ question: "Какой аванс?", plan: { versionPolicy: "current" }, labelled, profile: {}, feedback: [{ text: "Аванс 99%", reasons: ["number_not_in_evidence (99%)"] }] });
  assert.equal(messages.at(-1).role, "user");
  assert.match(messages.at(-1).content, /Вопрос:\nКакой аванс\?/);
  assert.match(messages.at(-1).content, /«Аванс 99%»: number_not_in_evidence \(99%\)/);
  assert.match(messages[0].content, /только JSON/);

  const overview = buildDraftMessages({ question: "Какие основные условия договора?", plan: { intent: "overview", versionPolicy: "current" }, labelled, profile: {} });
  assert.match(overview[0].content, /Вопрос обзорный/);
  assert.match(overview[0].content, /отдельное утверждение на каждое найденное условие/);
  assert.match(overview[0].content, /не больше 6/);
  assert.match(messages[0].content, /до 25 слов/);
  assert.doesNotMatch(messages[0].content, /Вопрос обзорный/);
  assert.match(messages[0].content, /Пустой список claims допустим только тогда/);
});

test("parseDraft accepts fenced or thinking output and normalises labels, kinds and duplicates", () => {
  const draft = parseDraft(`<think>план</think>\n\`\`\`json\n${JSON.stringify({
    claims: [
      { claim_id: "x", text: " Аванс  10% ", kind: "percentage", evidence_ids: ["[E1]", "e2", "3", "E1", "bad"] },
      { claim_id: "y", text: "аванс 10%", kind: "percentage", evidence_ids: ["E1"] },
      { claim_id: "z", text: "Срок 30 дней", kind: "unknown", evidence_ids: "E2" },
      { claim_id: "w", text: "", kind: "fact", evidence_ids: ["E1"] }
    ],
    summary: "Итог",
    open_questions: ["Нет ДС"]
  })}\n\`\`\``);
  assert.deepEqual(draft.claims, [
    { claimId: "c1", text: "Аванс 10%", kind: "percentage", evidenceIds: ["E1", "E2", "E3"] },
    { claimId: "c2", text: "Срок 30 дней", kind: "fact", evidenceIds: [] }
  ]);
  assert.equal(draft.summary, "Итог");
  assert.deepEqual(draft.openQuestions, ["Нет ДС"]);
  assert.equal(normalizeEvidenceLabel("Е4"), "E4", "Cyrillic Е is accepted");
});

test("parseDraft rejects non-JSON and JSON without claims", () => {
  assert.throws(() => parseDraft("Аванс 10% [1]."), DraftParseError);
  assert.throws(() => parseDraft("{\"claims\": [}"), DraftParseError);
  assert.throws(() => parseDraft("{\"summary\": \"x\"}"), DraftParseError);
});

test("parseVerdict never turns a missing verdict into supported", () => {
  const parsed = parseVerdict(JSON.stringify({
    overall: "pass",
    claims: [
      { claim_id: "c1", status: "supported", supported_by: ["E2", "x"], issues: [] },
      { claim_id: "c9", status: "supported", supported_by: [], issues: [] },
      { claim_id: "c2", status: "maybe", supported_by: [], issues: ["?"] }
    ],
    missing_evidence_queries: ["срок возврата удержания", "", "a", "b"],
    conflicts: [{ evidence_ids: ["E1", "E3"], note: "разные суммы" }, { evidence_ids: ["E1"], note: "одна" }]
  }), ["c1", "c2", "c3"]);
  assert.deepEqual(parsed.verdicts.get("c1"), { status: "supported", supportedBy: ["E2"], issues: [] });
  assert.equal(parsed.verdicts.get("c2").status, "ambiguous");
  assert.equal(parsed.verdicts.get("c3").status, "ambiguous");
  assert.equal(parsed.verdicts.has("c9"), false);
  assert.deepEqual(parsed.missingEvidenceQueries, ["срок возврата удержания", "a"]);
  assert.deepEqual(parsed.conflicts, [{ evidenceIds: ["E1", "E3"] }]);
  assert.equal(parseVerdict("{\"overall\": \"whatever\", \"claims\": []}", []).overall, "repair");
});

test("resolveVerifier uses the same model only when chosen explicitly", () => {
  const answerLlm = { provider: "local", baseUrl: "http://127.0.0.1:1234/v1", model: "answer-model", timeoutSeconds: 60 };
  assert.equal(resolveVerifier({}, answerLlm).status, "not_configured");
  assert.equal(resolveVerifier({ verifier: { mode: "separate_model", model: "" } }, answerLlm).status, "not_configured");
  assert.equal(resolveVerifier({ verifier: { mode: "off", model: "judge" } }, answerLlm).status, "disabled");

  const separate = resolveVerifier({ verifier: { mode: "separate_model", model: "judge-model" } }, answerLlm);
  assert.equal(separate.status, "ready");
  assert.equal(separate.independent, true);
  assert.equal(separate.llm.model, "judge-model");
  assert.equal(separate.llm.temperature, 0);
  assert.equal(separate.llm.baseUrl, answerLlm.baseUrl, "the verifier follows the answer route");

  const same = resolveVerifier({ verifier: { mode: "same_model" } }, answerLlm);
  assert.equal(same.status, "ready");
  assert.equal(same.independent, false);
  assert.equal(same.llm.model, "answer-model");
  assert.equal(resolveVerifier({ verifier: { mode: "separate_model", model: "answer-model" } }, answerLlm).independent, false);
});

test("evidence labels the model wrote into the sentence are moved to the citations", () => {
  // Seen with a live model: "… является ООО «СЗ Балчуг эстейт». E1, E3, E5, E7, E8."
  assert.deepEqual(stripInlineEvidenceLabels("ГУ проекта является ООО «СЗ Балчуг эстейт». E1, E3, E5."), {
    text: "ГУ проекта является ООО «СЗ Балчуг эстейт»",
    labels: ["E1", "E3", "E5"]
  });
  assert.deepEqual(stripInlineEvidenceLabels("Аванс составляет 10% от цены договора (E2)."), { text: "Аванс составляет 10% от цены договора", labels: ["E2"] });
  assert.deepEqual(stripInlineEvidenceLabels("Срок 30 дней [E1][E4]"), { text: "Срок 30 дней", labels: ["E1", "E4"] });
  // A number that is part of the fact is never treated as a label.
  for (const text of ["Гарантийный срок 5 лет", "Аванс 20% от цены договора.", "Объект Е5 корпус 2 сдан", "Бетон B30 W8 F150"]) {
    assert.deepEqual(stripInlineEvidenceLabels(text).labels, [], text);
  }
  assert.equal(stripInlineEvidenceLabels("Гарантийный срок 5 лет").text, "Гарантийный срок 5 лет");

  const draft = parseDraft(JSON.stringify({
    claims: [{ claim_id: "a", text: "ГУ — ООО «СЗ». E1, E3.", kind: "fact", evidence_ids: ["E1"] }],
    summary: "",
    open_questions: []
  }));
  assert.deepEqual(draft.claims, [{ claimId: "c1", text: "ГУ — ООО «СЗ»", kind: "fact", evidenceIds: ["E1", "E3"] }]);
});

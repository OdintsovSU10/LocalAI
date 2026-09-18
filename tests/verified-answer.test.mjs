import assert from "node:assert/strict";
import test from "node:test";

import { labelEvidence } from "../apps/rag-api/src/answer-core/answer-draft.js";
import { INSUFFICIENT_ANSWER, renderVerifiedAnswer } from "../apps/rag-api/src/answer-core/answer-renderer.js";
import { createLlmUsageTracker } from "../apps/rag-api/src/answer-core/llm-usage-tracker.js";
import { runVerifiedAnswer } from "../apps/rag-api/src/answer-core/verified-answer.js";

// Packet items as Retrieval 2.0 returns them (Stage 06), for project p1.
const item = (id, text, retrievalReason = "chunk:1", overrides = {}) => ({
  id: `chunk-${id}`, chunkId: `chunk-${id}`, evidenceId: `ev-${id}`, fileId: "f1", sourceId: "p1", sourceTitle: "Проект",
  title: "dogovor.md", path: "dogovor.md", text, retrievalReason, citationLabel: `dogovor.md, ${id}`, ...overrides
});
const RETENTION = item("5.1", "5.1. Заказчик удерживает гарантийное удержание в размере 3% от стоимости выполненных работ.", "fact:retention_percent:active");
const RETURN_TERM = item("5.2", "5.2. Сумма гарантийного удержания возвращается в течение 30 календарных дней после истечения гарантийного срока.", "fact:retention_return_term:active");
const NEW_ADVANCE = item("ds-1", "Пункт 3.1 изложить в новой редакции: аванс в размере 10% от цены договора.", "fact:advance_percent:active");
const OLD_ADVANCE = item("3.1", "3.1. Заказчик перечисляет аванс в размере 20% от цены договора.", "fact:advance_percent:superseded");
const PRICE = item("2.1", "2.1. Цена договора составляет 245 000 000 рублей.", "fact:contract_price:conflict");
const ESTIMATE = item("smeta-12", "| 12 | Итого по смете | 244 800 000 |", "fact:estimate_total:conflict", { title: "smeta.md" });
const EXTRA = item("5.3", "5.3. Гарантийное удержание может быть заменено банковской гарантией на ту же сумму.");

const claim = (text, kind, evidence_ids) => ({ claim_id: "x", text, kind, evidence_ids });
const draftText = (claims) => JSON.stringify({ claims, summary: "", open_questions: [] });

// Scripted LLM: drafts come from a queue (the last one repeats), the verifier from a function of its claims.
// rejectSchema: "once" — the first structured request fails; "always" — every structured request fails.
function scriptedLlm({ drafts, verdict = "supported", verdictFor = null, failVerifier = false, rejectSchemaOnce = false, rejectSchema = rejectSchemaOnce ? "once" : "" }) {
  const calls = [];
  let draftIndex = 0;
  let schemaRejected = false;
  const chatCompletion = async ({ llm, messages, responseFormat }) => {
    const name = responseFormat?.json_schema?.name || "plain";
    calls.push({ name, model: llm.model, content: messages.at(-1).content });
    if (responseFormat && (rejectSchema === "always" || (rejectSchema === "once" && !schemaRejected))) {
      schemaRejected = true;
      throw new Error("LLM endpoint returned 400: 'response_format' is not supported by this model");
    }
    if (name === "claim_verdicts" || messages[0].content.startsWith("Ты независимый проверяющий")) {
      if (failVerifier) throw new Error("verifier model is not loaded");
      const claims = [...messages.at(-1).content.matchAll(/^\{"claim_id".*\}$/gm)].map((line) => JSON.parse(line[0]));
      return {
        model: llm.model,
        text: JSON.stringify({
          overall: "pass",
          claims: claims.map((entry) => {
            const status = verdictFor ? verdictFor(entry) : verdict;
            return { claim_id: entry.claim_id, status, supported_by: status === "supported" ? entry.evidence_ids : [], issues: [] };
          }),
          missing_evidence_queries: verdict === "supported" && !verdictFor ? [] : ["банковская гарантия удержания"],
          conflicts: []
        })
      };
    }
    const text = drafts[Math.min(draftIndex, drafts.length - 1)];
    draftIndex += 1;
    return { model: llm.model, text: typeof text === "function" ? text(messages.at(-1).content) : text };
  };
  return { calls, chatCompletion, draftCalls: () => calls.filter((call) => !call.content.includes("Утверждения:")).length };
}

const LLM = { enabled: true, provider: "local", selectedProvider: "local", baseUrl: "http://127.0.0.1:1234/v1", model: "answer-model", timeoutSeconds: 30 };

async function run({ results = [RETENTION, RETURN_TERM], llm, verifier = { mode: "same_model" }, maxRepairs = 1, plan = { intent: "fact", versionPolicy: "current" }, retrieveMore = null, phases = [] }) {
  return runVerifiedAnswer({
    question: "Какой размер гарантийного удержания и срок его возврата?",
    plan,
    results,
    settings: { answering: { verified: true, maxRepairs }, verifier },
    llmCandidates: [LLM],
    sourceId: "p1",
    allowedSourceIds: ["p1"],
    scopeTitles: ["Проект"],
    usageTracker: createLlmUsageTracker(),
    chatCompletion: llm.chatCompletion,
    retrieveMore,
    onPhase: (phase, payload) => phases.push(`${phase}:${payload.status}`)
  });
}

test("acceptance: numeric negatives never reach the final answer even when the verifier passes everything", async () => {
  const llm = scriptedLlm({
    drafts: [draftText([
      claim("Гарантийное удержание составляет 3% от стоимости выполненных работ.", "percentage", ["E1"]),
      claim("Срок возврата гарантийного удержания — 3%.", "period", ["E1", "E2"]),
      claim("Удержание возвращается в течение 3 лет после истечения гарантийного срока.", "period", ["E2"]),
      claim("Гарантийное удержание составляет 30 дней.", "percentage", ["E2"]),
      claim("Сумма удержания составляет 3 000 000 рублей.", "amount", ["E1"]),
      claim("Удержание возвращается в течение 30 календарных дней после истечения гарантийного срока.", "period", ["E2"])
    ])]
  });
  const { payload } = await run({ llm, maxRepairs: 0 });
  assert.equal(payload.answerStatus, "verified");
  assert.equal(payload.answer, [
    "- Гарантийное удержание составляет 3% от стоимости выполненных работ. [1]",
    "- Удержание возвращается в течение 30 календарных дней после истечения гарантийного срока. [2]",
    "",
    "Не показано утверждений, не подтверждённых документами: 4."
  ].join("\n"));
  for (const wrong of ["— 3%", "3 лет", "30 дней.", "3 000 000"]) assert.ok(!payload.answer.includes(wrong), wrong);
  assert.deepEqual(payload.sources.map((source) => source.evidenceId), ["ev-5.1", "ev-5.2"]);
  assert.deepEqual(payload.verification.claims.map((entry) => entry.status), ["supported", "contradicted", "unsupported", "contradicted", "unsupported", "supported"]);
  assert.equal(payload.verification.level, "model");
  assert.equal(payload.verification.droppedClaims, 4);
});

test("acceptance: an addendum-replaced value is not shown as current; the change can be stated as history", async () => {
  const stale = scriptedLlm({ drafts: [draftText([claim("Аванс составляет 20% от цены договора.", "percentage", ["E2"])])] });
  const rejected = await run({ llm: stale, results: [NEW_ADVANCE, OLD_ADVANCE], maxRepairs: 0 });
  assert.equal(rejected.payload.answerStatus, "insufficient_evidence");
  assert.equal(rejected.payload.answer, INSUFFICIENT_ANSWER);
  assert.deepEqual(rejected.payload.verification.claims[0].issues, ["superseded_evidence"]);

  const history = scriptedLlm({ drafts: [draftText([
    claim("Аванс составляет 10% от цены договора.", "percentage", ["E1"]),
    claim("Ранее аванс составлял 20% от цены договора.", "percentage", ["E2"])
  ])] });
  const accepted = await run({ llm: history, results: [NEW_ADVANCE, OLD_ADVANCE] });
  assert.equal(accepted.payload.answerStatus, "verified");
  assert.match(accepted.payload.answer, /10% от цены договора\. \[1\]\n- Ранее аванс составлял 20% от цены договора\. \[2\]/);
});

test("a claim on conflicting documents is shown with the documented discrepancy", async () => {
  const llm = scriptedLlm({ drafts: [draftText([claim("Цена договора составляет 245 000 000 рублей.", "amount", ["E1"])])] });
  const { payload } = await run({ llm, results: [PRICE, ESTIMATE] });
  assert.equal(payload.answerStatus, "verified_with_conflict");
  assert.equal(payload.answer, "Цена договора составляет 245 000 000 рублей. [1]\n\nВ документах есть расхождение по этому вопросу: сравните [1][2].");
  assert.deepEqual(payload.sources.map((source) => source.evidenceId), ["ev-2.1", "ev-smeta-12"]);
});

test("the verifier rejects what checks cannot see; the repair loop is bounded and adds evidence", async () => {
  const phases = [];
  const queries = [];
  const llm = scriptedLlm({ drafts: [draftText([claim("Удержание можно заменить страхованием.", "condition", ["E1"])])], verdict: "unsupported" });
  const { payload } = await run({
    llm,
    maxRepairs: 2,
    phases,
    retrieveMore: async (asked) => {
      queries.push(...asked);
      return [EXTRA];
    }
  });
  assert.equal(payload.answerStatus, "insufficient_evidence");
  assert.equal(payload.verification.repairs, 2);
  assert.equal(llm.draftCalls(), 3, "one draft + two bounded repairs");
  assert.deepEqual(queries, ["банковская гарантия удержания", "банковская гарантия удержания"]);
  assert.ok(llm.calls.at(-2).content.includes("[E3]"), "the repair draft sees the added evidence");
  assert.ok(llm.calls.at(-2).content.includes("Предыдущий черновик не прошёл проверку"));
  assert.deepEqual(phases, [
    "verifying:verifying_started", "llm:repair_started",
    "verifying:verifying_started", "llm:repair_started",
    "verifying:verifying_started", "finalizing:finalizing"
  ]);
});

test("a repaired draft replaces the rejected one", async () => {
  const llm = scriptedLlm({
    drafts: [
      draftText([claim("Гарантийное удержание составляет 5%.", "percentage", ["E1"])]),
      draftText([claim("Гарантийное удержание составляет 3% от стоимости выполненных работ.", "percentage", ["E1"])])
    ]
  });
  const { payload } = await run({ llm });
  assert.equal(payload.answerStatus, "verified");
  assert.equal(payload.verification.repairs, 1);
  assert.equal(payload.answer, "Гарантийное удержание составляет 3% от стоимости выполненных работ. [1]");
});

test("without a verifier model the answer is gated by deterministic checks and says so", async () => {
  const llm = scriptedLlm({ drafts: [draftText([claim("Гарантийное удержание составляет 3% от стоимости выполненных работ.", "percentage", ["E1"])])] });
  const { payload } = await run({ llm, verifier: { mode: "separate_model", model: "" } });
  assert.equal(payload.answerStatus, "verified");
  assert.equal(payload.verification.level, "hard_checks");
  assert.equal(payload.verification.verifier.status, "not_configured");
  assert.ok(llm.calls.every((call) => !call.content.includes("Утверждения:")), "no verifier call");

  const failing = scriptedLlm({ drafts: [draftText([claim("Гарантийное удержание составляет 3% от стоимости выполненных работ.", "percentage", ["E1"])])], failVerifier: true });
  const failed = await run({ llm: failing });
  assert.equal(failed.payload.verification.level, "hard_checks");
  assert.equal(failed.payload.verification.verifier.status, "failed");
  assert.equal(failed.payload.answerStatus, "verified");
});

test("a separate verifier model is called with its own model name", async () => {
  const llm = scriptedLlm({ drafts: [draftText([claim("Гарантийное удержание составляет 3% от стоимости выполненных работ.", "percentage", ["E1"])])] });
  const { payload } = await run({ llm, verifier: { mode: "separate_model", model: "judge-model" } });
  assert.equal(payload.verification.verifier.independent, true);
  assert.deepEqual(llm.calls.map((call) => call.model), ["answer-model", "judge-model"]);
});

test("a runtime without structured output gets the plain prompt; an unparsable draft is a system error", async () => {
  const llm = scriptedLlm({ drafts: [draftText([claim("Гарантийное удержание составляет 3% от стоимости выполненных работ.", "percentage", ["E1"])])], rejectSchemaOnce: true });
  const { payload } = await run({ llm });
  assert.equal(payload.answerStatus, "verified");
  assert.deepEqual(llm.calls.map((call) => call.name), ["answer_draft", "plain", "claim_verdicts"]);

  const broken = scriptedLlm({ drafts: ["Удержание 3% [1]."] });
  const failed = await run({ llm: broken });
  assert.equal(failed.payload, undefined);
  assert.equal(failed.error.name, "DraftParseError");
  assert.equal(broken.draftCalls(), 2, "one structured and one plain attempt");
});

test("an empty draft is an honest insufficient-evidence answer", async () => {
  const llm = scriptedLlm({ drafts: [JSON.stringify({ claims: [], summary: "", open_questions: ["Нет пункта о страховании"] })] });
  const { payload } = await run({ llm, maxRepairs: 0 });
  assert.equal(payload.answerStatus, "insufficient_evidence");
  assert.equal(payload.answer, INSUFFICIENT_ANSWER);
  assert.deepEqual(payload.sources, []);
});

test("renderVerifiedAnswer cites only shown claims, narrows citations to the verifier's support and renumbers", () => {
  const labelled = labelEvidence([RETENTION, RETURN_TERM, EXTRA]);
  const claims = [
    { claimId: "c1", text: "Удержание 3%", kind: "percentage", evidenceIds: ["E1", "E2"] },
    { claimId: "c2", text: "Можно заменить гарантией", kind: "condition", evidenceIds: ["E3"] }
  ];
  const checks = new Map(claims.map((entry) => [entry.claimId, { claimId: entry.claimId, passed: true, status: "passed", issues: [], conflict: false }]));
  const verdicts = new Map([["c1", { status: "supported", supportedBy: ["E1"], issues: [] }], ["c2", { status: "ambiguous", supportedBy: [], issues: [] }]]);
  const rendered = renderVerifiedAnswer({ claims, checks, verdicts, labelled, level: "model" });
  assert.equal(rendered.answer, "Удержание 3%. [1]\n\nНе показано утверждений, не подтверждённых документами: 1.");
  assert.deepEqual(rendered.sources.map((source) => source.evidenceId), ["ev-5.1"]);
  assert.deepEqual(rendered.claims.map((entry) => [entry.status, entry.shown, entry.citations]), [["supported", true, [1]], ["ambiguous", false, []]]);
  assert.deepEqual(rendered.claims[1].issues, ["verifier:ambiguous"]);
});

test("a runtime without structured output still gets the verifier: plain retry for the verdict too", async () => {
  const llm = scriptedLlm({ drafts: [draftText([claim("Гарантийное удержание составляет 3% от стоимости выполненных работ.", "percentage", ["E1"])])], rejectSchema: "always" });
  const { payload } = await run({ llm });
  assert.equal(payload.verification.level, "model");
  assert.equal(payload.verification.verifier.status, "ok");
  assert.equal(payload.answerStatus, "verified");
  assert.deepEqual(llm.calls.map((call) => call.name), ["answer_draft", "plain", "claim_verdicts", "plain"]);
});

test("the repair limit is enforced inside the pipeline, whatever the settings say", async () => {
  const llm = scriptedLlm({ drafts: [draftText([claim("Удержание можно заменить страхованием.", "condition", ["E1"])])], verdict: "unsupported" });
  const { payload } = await run({ llm, maxRepairs: 9 });
  assert.equal(payload.verification.repairs, 2);
  assert.equal(payload.verification.maxRepairs, 2);
  assert.equal(llm.draftCalls(), 3);
});

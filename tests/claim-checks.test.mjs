import assert from "node:assert/strict";
import test from "node:test";

import { checkClaim } from "../apps/rag-api/src/answer-core/claim-checks.js";
import { compareQuantities, extractQuantities } from "../apps/rag-api/src/answer-core/claim-numbers.js";

const units = (text) => extractQuantities(text).map((quantity) => `${quantity.unit}:${quantity.value}`);

test("extractQuantities reads units, dates, fractions and skips codes and clause references", () => {
  assert.deepEqual(units("Цена 245 000 000 (двести сорок пять миллионов) рублей, НДС 20%."), ["currency:245000000", "percent:20"]);
  assert.deepEqual(units("в течение 30 календарных дней, 10 рабочих дней, 15 банковских дней"), ["day:30", "day:10", "day:15"]);
  assert.deepEqual(units("5 лет (60 месяцев), не менее 24 месяцев, 2 недели"), ["year:5", "month:60", "month:24", "week:2"]);
  assert.deepEqual(units("Окончание: 30.11.2026; подписан 1 марта 2026 года; в 2026 году"), ["date:2026-11-30", "date:2026-03-01", "calendar_year:2026"]);
  assert.deepEqual(units("пени 1/300 ключевой ставки"), ["fraction:1/300"]);
  assert.deepEqual(units("245 млн руб. и 1,5 тыс. рублей"), ["currency:245000000", "currency:1500"]);
  assert.deepEqual(units("цена 245 млн, 3 млрд руб."), ["number:245000000", "currency:3000000000"]);
  assert.deepEqual(units("бетон B30 W8 F150, акты КС-2, договор № 15-П, п. 3.1, статья 719, ДС №1"), []);
  assert.deepEqual(units("245 000 000 рублей"), ["currency:245000000"]);
});

test("compareQuantities separates a missing value from the same value with another unit", () => {
  const evidence = ["Удержание 3% от стоимости работ.", "Возврат в течение 30 календарных дней.", "Гарантийный срок 5 лет."];
  const status = (claim) => compareQuantities(claim, evidence).map((item) => item.status);
  assert.deepEqual(status("Удержание 3%, возврат через 30 дней"), ["ok", "ok"]);
  assert.deepEqual(status("Возврат в течение 3 лет"), ["unit_mismatch"]);
  assert.deepEqual(status("Удержание 3 000 000 рублей"), ["missing"]);
  assert.deepEqual(status("Гарантийный срок 60 месяцев"), ["ok"]);
  assert.deepEqual(compareQuantities("Итого 244 800 000 рублей", ["| 12 | Итого по смете | 244 800 000 |"]).map((item) => item.status), ["ok"]);
});

const item = (text, overrides = {}) => ({ text, sourceId: "p1", fileId: "f1", chunkId: "c1", retrievalReason: "chunk:1", ...overrides });
const RETENTION = item("5.1. Заказчик удерживает гарантийное удержание в размере 3% от стоимости выполненных работ.");
const RETURN_TERM = item("5.2. Сумма гарантийного удержания возвращается в течение 30 календарных дней после истечения гарантийного срока.");
const OLD_ADVANCE = item("3.1. Аванс в размере 20% от цены договора.", { retrievalReason: "fact:advance_percent:superseded" });
const NEW_ADVANCE = item("Пункт 3.1 изложить в новой редакции: аванс в размере 10% от цены договора.", { retrievalReason: "fact:advance_percent:active" });
const PRICE = item("2.1. Цена договора составляет 245 000 000 рублей.", { retrievalReason: "fact:contract_price:conflict" });
const OTHER_PROJECT = item("3.1. Аванс составляет 30% от цены договора.", { sourceId: "p2" });

const evidenceById = new Map([
  ["E1", RETENTION], ["E2", RETURN_TERM], ["E3", OLD_ADVANCE], ["E4", NEW_ADVANCE], ["E5", PRICE], ["E6", OTHER_PROJECT], ["E7", item("Текст", { fileId: "", chunkId: "", path: "" })]
]);
const check = (text, kind, evidenceIds, options = {}) => checkClaim(
  { claimId: "c1", text, kind, evidenceIds },
  { evidenceById, allowedSourceIds: ["p1"], versionPolicy: "current", ...options }
);
const codes = (result) => result.issues.map((issue) => issue.code);

test("numeric negatives: 3% vs 30 days, 3 years vs 30 days, amount vs percent", () => {
  assert.equal(check("Гарантийное удержание составляет 3% от стоимости выполненных работ.", "percentage", ["E1"]).passed, true);
  assert.equal(check("Удержание возвращается в течение 30 календарных дней после истечения гарантийного срока.", "period", ["E2"]).passed, true);

  const percentAsTerm = check("Срок возврата гарантийного удержания — 3%.", "period", ["E1", "E2"]);
  assert.equal(percentAsTerm.status, "contradicted");
  assert.ok(codes(percentAsTerm).includes("type_mismatch"));

  const daysAsSize = check("Гарантийное удержание составляет 30 дней.", "percentage", ["E2"]);
  assert.equal(daysAsSize.status, "contradicted");
  assert.ok(codes(daysAsSize).includes("type_mismatch"));

  const yearsVsDays = check("Удержание возвращается в течение 3 лет.", "period", ["E2"]);
  assert.equal(yearsVsDays.passed, false);
  assert.ok(codes(yearsVsDays).includes("number_not_in_evidence"));

  const amountVsPercent = check("Гарантийное удержание составляет 3 рубля.", "amount", ["E1"]);
  assert.equal(amountVsPercent.status, "contradicted");
  assert.ok(codes(amountVsPercent).includes("unit_mismatch"));
  assert.ok(codes(check("Гарантийное удержание составляет 3 000 000 рублей.", "amount", ["E1"])).includes("number_not_in_evidence"));

  // The other direction: a percentage presented as an amount.
  const percentAsAmount = check("Сумма аванса составляет 10% от цены договора.", "amount", ["E4"]);
  assert.equal(percentAsAmount.status, "contradicted");
  assert.ok(codes(percentAsAmount).includes("type_mismatch"));
  assert.ok(codes(check("Пени составляют 1/300 ключевой ставки.", "amount", ["E1"])).includes("type_mismatch"));
  assert.equal(check("Цена договора составляет 245 000 000 рублей, в том числе НДС 20%.", "amount", ["E5"]).issues.some((issue) => issue.code === "type_mismatch"), false);

  // A bare number is not confirmed by a percentage, duration or share with the same digits.
  const bareVsPercent = check("Сумма аванса составляет 10.", "amount", ["E4"]);
  assert.equal(bareVsPercent.status, "contradicted");
  assert.ok(codes(bareVsPercent).includes("unit_mismatch"));
  assert.ok(codes(check("Сумма удержания составляет 30.", "amount", ["E2"])).includes("unit_mismatch"));
  assert.deepEqual(compareQuantities("Пени 300", ["Пени 1/300 ключевой ставки"]).map((entry) => entry.status), ["missing"]);
  // ...but it is confirmed by a bare spreadsheet value or an amount in rubles.
  assert.deepEqual(compareQuantities("Итого 244 800 000", ["| 12 | Итого по смете | 244 800 000 |"]).map((entry) => entry.status), ["ok"]);
  assert.deepEqual(compareQuantities("Итого 245 000 000", ["Цена 245 000 000 рублей"]).map((entry) => entry.status), ["ok"]);

  // The same digits as a percentage and as an unrelated amount: which one the claim means is unknown.
  const mixed = "Аванс составляет 10% от цены договора, банковская комиссия — 10 рублей.";
  assert.deepEqual(compareQuantities("Сумма аванса составляет 10.", [mixed]).map((entry) => entry.status), ["ambiguous"]);
  assert.deepEqual(compareQuantities("Комиссия составляет 10 рублей.", [mixed]).map((entry) => entry.status), ["ok"]);
  assert.deepEqual(compareQuantities("Аванс составляет 10%.", [mixed]).map((entry) => entry.status), ["ok"]);
  const ambiguous = checkClaim(
    { claimId: "c1", text: "Сумма аванса составляет 10.", kind: "amount", evidenceIds: ["E1"] },
    { evidenceById: new Map([["E1", item(mixed)]]), allowedSourceIds: ["p1"] }
  );
  assert.equal(ambiguous.passed, false);
  assert.ok(codes(ambiguous).includes("ambiguous_number"));
});

test("money abbreviations without the currency word are the same amount", () => {
  const status = (claim, evidence) => compareQuantities(claim, [evidence]).map((entry) => entry.status);
  assert.deepEqual(status("Цена договора составляет 245 млн.", "Цена договора составляет 245 млн руб."), ["ok"]);
  assert.deepEqual(status("Цена договора составляет 245 млн.", "2.1. Цена договора составляет 245 000 000 (двести сорок пять миллионов) рублей."), ["ok"]);
  assert.deepEqual(status("Цена договора составляет 245 000 000 рублей.", "Цена договора 245 млн"), ["ok"]);
  assert.deepEqual(status("Цена договора составляет 250 млн.", "Цена договора составляет 245 млн руб."), ["missing"]);
});

test("a period word that is not the label of the value is not a type mismatch", () => {
  const penalty = checkClaim(
    { claimId: "c1", text: "Неустойка за нарушение срока окончания работ — 0,1% от цены договора за каждый день просрочки.", kind: "percentage", evidenceIds: ["E1"] },
    { evidenceById: new Map([["E1", item("7.1. За нарушение срока окончания работ Генподрядчик уплачивает неустойку в размере 0,1% от цены договора за каждый день просрочки.")]]), allowedSourceIds: ["p1"] }
  );
  assert.equal(penalty.passed, true, JSON.stringify(penalty.issues));
  assert.ok(codes(check("Удержание возвращается в течение 3%.", "fact", ["E1"])).includes("type_mismatch"));
});

test("addendum: the replaced value is contradicted as current and allowed as history", () => {
  const stale = check("Аванс составляет 20% от цены договора.", "percentage", ["E3"]);
  assert.equal(stale.status, "contradicted");
  assert.ok(codes(stale).includes("superseded_evidence"));
  assert.equal(check("Ранее аванс составлял 20% от цены договора.", "percentage", ["E3"]).passed, true);
  assert.equal(check("Аванс составлял 20%, ДС изменило его на 10%.", "comparison", ["E3", "E4"]).passed, true);
  assert.equal(check("Аванс составляет 20% от цены договора.", "percentage", ["E3"], { versionPolicy: "historical" }).passed, true);
  assert.equal(check("Аванс составляет 10% от цены договора.", "percentage", ["E4"]).passed, true);
});

test("citations must exist, stay in scope and point at a file", () => {
  assert.deepEqual(codes(check("Удержание 3%.", "percentage", [])), ["missing_evidence"]);
  assert.ok(codes(check("Удержание 3%.", "percentage", ["E99"])).includes("unknown_evidence"));
  assert.ok(codes(check("Аванс составляет 30% от цены договора.", "percentage", ["E6"])).includes("out_of_scope"));
  assert.equal(check("Аванс составляет 30% от цены договора.", "percentage", ["E6"], { allowedSourceIds: null }).passed, true);
  assert.ok(codes(check("Текст", "fact", ["E7"])).includes("no_citation_target"));
});

test("a claim citing conflicting evidence is flagged as conflict without failing", () => {
  const result = check("Цена договора составляет 245 000 000 рублей.", "amount", ["E5"]);
  assert.equal(result.passed, true);
  assert.equal(result.conflict, true);
});

import assert from "node:assert/strict";
import test from "node:test";

import { expandQueryTerms, phraseRerankBoost, scoreChunk } from "../apps/rag-api/src/search.js";

test("expandQueryTerms adds configured synonyms for known terms", () => {
  const terms = expandQueryTerms(["цена"]);

  assert.equal(terms[0], "цена");
  assert.ok(terms.includes("стоимость"));
  assert.ok(terms.includes("сумма"));
  assert.ok(terms.includes("размер"));
});

test("expandQueryTerms links contract plurals and email wording", () => {
  const contractTerms = expandQueryTerms(["\u0434\u043e\u0433\u043e\u0432\u043e\u0440\u0430\u0445"]);
  const emailTerms = expandQueryTerms(["\u043f\u043e\u0447\u0442\u0430"]);

  assert.ok(contractTerms.includes("\u0434\u043e\u0433\u043e\u0432\u043e\u0440"));
  assert.ok(contractTerms.includes("\u043a\u043e\u043d\u0442\u0440\u0430\u043a\u0442"));
  assert.ok(emailTerms.includes("email"));
  assert.ok(emailTerms.includes("e-mail"));
});

test("scoreChunk combines term frequency and exact phrase match", () => {
  const score = scoreChunk(
    { text: "Цена договора цена", terms: ["цена", "договора", "цена"] },
    ["цена", "договора"],
    "цена договора"
  );

  assert.equal(score, 8 + (2 + Math.log(3)) + (2 + Math.log(2)));
});

test("phraseRerankBoost boosts contract price wording", () => {
  assert.equal(
    phraseRerankBoost("Цена договора составляет 1 234 567,89 рублей", ["цена", "договора"]),
    0.12
  );
});

test("phraseRerankBoost does not boost without both cost and contract intent", () => {
  assert.equal(
    phraseRerankBoost("Цена договора составляет 1 234 567,89 рублей", ["цена"]),
    0
  );
});

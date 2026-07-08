import assert from "node:assert/strict";
import test from "node:test";

import { matchSourceForQuestion } from "../apps/rag-api/src/source-match.js";

const sources = [
  {
    id: "balchug",
    title: "Балчуг Эстейт (Садовническая 76)",
    path: "\\\\server\\share\\Балчуг Эстейт (Садовническая 76)"
  },
  {
    id: "wave",
    title: "ЛСР_ЖК_WAVE_2 (Борисовские пруды)",
    path: "\\\\server\\share\\ЛСР_ЖК_WAVE_2"
  }
];

test("matchSourceForQuestion confidently matches project title and address tokens", () => {
  const match = matchSourceForQuestion(
    "Балчуг, Садовническая - какие основные условия договора?",
    sources
  );

  assert.equal(match.confident, true);
  assert.equal(match.source.id, "balchug");
  assert.equal(match.score, 13);
  assert.deepEqual(match.matchedTokens, ["балчуг", "садовническая"]);
});

test("matchSourceForQuestion does not guess from generic contract questions", () => {
  const match = matchSourceForQuestion("Какие основные условия договора?", sources);

  assert.equal(match.confident, false);
  assert.equal(match.source, null);
  assert.deepEqual(match.candidates, []);
});

test("matchSourceForQuestion keeps current single-source auto-match behavior", () => {
  const match = matchSourceForQuestion("Любой вопрос", [sources[0]]);

  assert.equal(match.confident, true);
  assert.equal(match.source.id, "balchug");
  assert.equal(match.score, 100);
  assert.deepEqual(match.matchedTokens, []);
});

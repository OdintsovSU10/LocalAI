import assert from "node:assert/strict";
import test from "node:test";

import { classifyDocument, stripFrontMatter } from "../apps/rag-api/src/evidence/document-classifier.js";
import { buildEvidenceSpans } from "../apps/rag-api/src/evidence/evidence-spans.js";
import { extractDocumentFacts } from "../apps/rag-api/src/evidence/fact-extractor.js";
import { linkDocumentFamily } from "../apps/rag-api/src/evidence/version-graph.js";
import { validateEvidenceBuild } from "../apps/rag-api/src/evidence/evidence-store.js";
import { buildFixtureSourceEvidence, documentOf, factsOf, spanOf } from "./helpers/evidence-fixtures.mjs";

test("classifyDocument recognises contracts, amendments with parent reference, estimates and letters", () => {
  assert.deepEqual(
    classifyDocument({ markdown: "# Дополнительное соглашение № 2 от 01.07.2026 к договору подряда № 15-П от 10.02.2026\n\nТекст" }),
    {
      kind: "amendment",
      title: "Дополнительное соглашение № 2 от 01.07.2026 к договору подряда № 15-П от 10.02.2026",
      number: "2",
      documentDate: "2026-07-01",
      parentRef: { number: "15-П", numberKey: "15-п", date: "2026-02-10" },
      method: "title:amendment"
    }
  );
  const contract = classifyDocument({ markdown: "# Договор генерального подряда № 7-РС от 02.03.2026\n\n1. Предмет" });
  assert.equal(contract.kind, "contract");
  assert.equal(contract.number, "7-РС");
  assert.equal(contract.documentDate, "2026-03-02");
  assert.equal(classifyDocument({ markdown: "# smeta.xlsx\n\n## Лист: Сводная\n\n| 1 | a |" }).kind, "estimate");
  assert.equal(classifyDocument({ markdown: "# scan.pdf\n\n## OCR page 1\n\nИсх. № 5 от 01.02.2026" }).kind, "letter");
  assert.equal(classifyDocument({ markdown: "# Заметки\n\nТекст без реквизитов" }).kind, "other");
});

test("front matter with the absolute source path never reaches evidence spans", () => {
  const markdown = "---\nsource_path: \"D:\\\\secret\\\\folder\\\\dogovor.md\"\nindexed_at: \"2026-09-01\"\n---\n# Договор № 1 от 01.01.2026\n\nЦена договора составляет 100 рублей.";
  assert.ok(!stripFrontMatter(markdown).includes("secret"));
  const spans = buildEvidenceSpans({ sourceId: "s", fileId: "f", markdown });
  assert.equal(spans.length, 1);
  assert.ok(spans.every((span) => !span.text.includes("secret") && !span.text.includes("source_path")));
});

test("evidence spans carry their own section, sheet/row and page, independent of index chunk grouping", async () => {
  const build = await buildFixtureSourceEvidence("pv2-stromynka");
  const penalty = factsOf(build, "penalty_rate")[0];
  assert.equal(spanOf(build, penalty).sectionTitle, "7. Ответственность сторон");

  const monolith = build.spans.find((span) => span.kind === "table_row" && span.text.includes("Монолитные"));
  assert.equal(monolith.sheetName, "Сводная");
  assert.equal(monolith.rowStart, 7);
  const concrete = build.spans.find((span) => span.kind === "table_row" && span.text.includes("Бетон B30"));
  assert.equal(concrete.sheetName, "Материалы");
  assert.equal(concrete.rowStart, 4);

  const suspension = build.spans.find((span) => span.text.includes("с 01.07.2026"));
  assert.equal(suspension.pageStart, 2);
  assert.equal(suspension.pageEnd, 2);
  assert.ok(build.spans.every((span) => span.chunkId), "every fixture span maps to an index chunk for preview");
});

test("contract facts are extracted with normalized values and conditions", async () => {
  const build = await buildFixtureSourceEvidence("pv2-stromynka");
  const value = (type, status = "") => factsOf(build, type, status).map((fact) => fact.normalized);
  assert.deepEqual(value("party_contractor"), [{ name: "ООО «СтройМонолит»" }]);
  assert.deepEqual(value("vat_rate"), [{ percent: 20 }]);
  assert.deepEqual(value("retention_percent"), [{ percent: 3 }]);
  assert.deepEqual(value("warranty_period"), [{ months: 60 }]);
  assert.deepEqual(value("penalty_rate"), [{ percent: 0.1, capPercent: 10 }]);
  const retentionReturn = factsOf(build, "retention_return_term")[0];
  assert.deepEqual(retentionReturn.normalized, { days: 30, dayKind: "календарных" });
  assert.match(retentionReturn.condition, /после истечения гарантийного срока/);
  // "3%" (size) and "30 days" (term) stay different fact types.
  assert.equal(factsOf(build, "retention_percent")[0].unit, "%");
  assert.equal(retentionReturn.unit, "days");
  // A later clause mentioning the advance offset is not a second advance term.
  assert.equal(factsOf(build, "advance_term").length, 2);
});

test("amendment supersedes the base clause; the old fact keeps its evidence and validity", async () => {
  const build = await buildFixtureSourceEvidence("pv2-stromynka");
  const amendment = build.documents.find((document) => document.kind === "amendment");
  const contract = build.documents.find((document) => document.kind === "contract");
  assert.equal(amendment.relation, "amends");
  assert.equal(amendment.parentDocumentId, contract.documentId);
  assert.deepEqual(build.relations, [{ sourceId: "pv2-stromynka", fromDocumentId: amendment.documentId, toDocumentId: contract.documentId, relation: "amends", reason: "" }]);

  const [currentAdvance] = factsOf(build, "advance_percent", "active");
  const [oldAdvance] = factsOf(build, "advance_percent", "superseded");
  assert.deepEqual(currentAdvance.normalized, { percent: 10 });
  assert.equal(documentOf(build, currentAdvance).kind, "amendment");
  assert.equal(currentAdvance.clauseRef, "3.1");
  assert.equal(currentAdvance.validFrom, "2026-05-15");
  assert.equal(currentAdvance.supersedesFactId, oldAdvance.factId);
  assert.deepEqual(oldAdvance.normalized, { percent: 20 });
  assert.equal(oldAdvance.supersededByFactId, currentAdvance.factId);
  assert.equal(oldAdvance.validTo, "2026-05-15");
  assert.ok(spanOf(build, oldAdvance).text.includes("аванс в размере 20%"));

  assert.deepEqual(factsOf(build, "work_end_date", "active").map((fact) => fact.normalized.date), ["2027-03-31"]);
  assert.deepEqual(factsOf(build, "work_end_date", "superseded").map((fact) => fact.normalized.date), ["2026-11-30"]);
  assert.deepEqual(factsOf(build, "work_start_date", "active").map((fact) => fact.normalized.date), ["2026-03-01"]);
});

test("contract price and estimate total that differ are marked as a conflict, not resolved silently", async () => {
  const build = await buildFixtureSourceEvidence("pv2-stromynka");
  const price = factsOf(build, "contract_price")[0];
  const total = factsOf(build, "estimate_total")[0];
  assert.equal(price.status, "conflict");
  assert.equal(total.status, "conflict");
  assert.deepEqual(total.normalized, { amount: 244800000, currency: "" });
  assert.equal(spanOf(build, total).rowStart, 12);
  assert.equal(build.conflicts.length, 1);
  assert.equal(build.conflicts[0].typeGroup, "total_cost");
  assert.deepEqual(build.conflicts[0].factIds, [price.factId, total.factId].sort());
});

test("single-contract sources produce no relations or conflicts", async () => {
  for (const sourceId of ["pv2-rusakovskaya", "pv2-balchug"]) {
    const build = await buildFixtureSourceEvidence(sourceId);
    assert.deepEqual(build.relations, []);
    assert.deepEqual(build.conflicts, []);
    assert.ok(build.facts.every((fact) => fact.status === "active"));
  }
  const balchug = await buildFixtureSourceEvidence("pv2-balchug");
  assert.deepEqual(factsOf(balchug, "advance_percent")[0].normalized, { percent: 30 });
  assert.deepEqual(factsOf(balchug, "retention_percent"), []);
});

function syntheticDocument(documentId, markdown) {
  const classification = classifyDocument({ markdown });
  const document = { documentId, sourceId: "s1", fileId: documentId, fileLabel: `${documentId}.md`, contentHash: documentId, ...classification };
  const spans = buildEvidenceSpans({ sourceId: "s1", fileId: documentId, documentId, markdown });
  return { document, spans, facts: extractDocumentFacts(document, spans) };
}

function link(...parts) {
  return linkDocumentFamily({ documents: parts.map((part) => part.document), facts: parts.flatMap((part) => part.facts) });
}

test("an amendment whose parent contract is not in the source is linked as unknown and supersedes nothing", () => {
  const base = syntheticDocument("base", "# Договор подряда № 10 от 01.01.2026\n\n3.1. Аванс составляет 20% от цены договора.");
  const amendment = syntheticDocument("ds", "# Дополнительное соглашение № 1 от 01.03.2026 к договору подряда № 99 от 01.01.2026\n\nПункт 3.1 договора изложить в новой редакции: «Аванс составляет 10% от цены договора».");
  const graph = link(base, amendment);
  assert.equal(graph.relations[0].relation, "unknown");
  assert.match(graph.relations[0].reason, /not found/);
  assert.ok(graph.facts.every((fact) => fact.status !== "superseded"));
});

test("an undated amendment does not supersede; differing values in the family become a conflict", () => {
  const base = syntheticDocument("base", "# Договор подряда № 10 от 01.01.2026\n\n3.1. Аванс составляет 20% от цены договора.");
  const amendment = syntheticDocument("ds", "# Дополнительное соглашение № 1 к договору подряда № 10 от 01.01.2026\n\nПункт 3.1 договора изложить в новой редакции: «Аванс составляет 10% от цены договора».");
  const graph = link(base, amendment);
  assert.equal(graph.relations[0].relation, "amends");
  assert.deepEqual(graph.facts.filter((fact) => fact.factType === "advance_percent").map((fact) => fact.status), ["conflict", "conflict"]);
  assert.equal(graph.conflicts.length, 1);
});

test("with two base facts of the same type and no matching clause the amendment does not pick one", () => {
  const base = syntheticDocument("base", "# Договор подряда № 10 от 01.01.2026\n\nАванс составляет 20% от цены договора.\n\nПовторно: аванс составляет 25% от цены договора.");
  const amendment = syntheticDocument("ds", "# Дополнительное соглашение № 1 от 01.03.2026 к договору подряда № 10\n\nПункт 3.1 договора изложить в новой редакции: «Аванс составляет 10% от цены договора».");
  const graph = link(base, amendment);
  const advances = graph.facts.filter((fact) => fact.factType === "advance_percent");
  assert.equal(advances.filter((fact) => fact.status === "superseded").length, 0);
  assert.equal(advances.filter((fact) => fact.status === "conflict").length, 3);
});

test("a build with a fact that has no evidence is rejected", async () => {
  const build = await buildFixtureSourceEvidence("pv2-balchug");
  assert.doesNotThrow(() => validateEvidenceBuild(build));
  const broken = { ...build, facts: [{ ...build.facts[0], evidenceIds: [] }] };
  assert.throws(() => validateEvidenceBuild(broken), /has no evidence/);
  const dangling = { ...build, facts: [{ ...build.facts[0], evidenceIds: ["ev_missing"] }] };
  assert.throws(() => validateEvidenceBuild(dangling), /unknown evidence/);
});

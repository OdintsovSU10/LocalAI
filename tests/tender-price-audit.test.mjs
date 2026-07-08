import assert from "node:assert/strict";
import test from "node:test";

import { createMockHubTenderAdapter } from "../apps/rag-api/src/hubtender-adapter.js";
import { compareMoney } from "../apps/rag-api/src/money.js";
import {
  buildAuditEvidence,
  compareRecordWithCandidates,
  extractPriceCandidatesFromText,
  filterCommercialProposalChunks,
  isCommercialProposalChunk,
  runTenderPriceAudit
} from "../apps/rag-api/src/tender-price-audit.js";

const tenderSource = {
  id: "tender-abc",
  title: "298. Сокольники",
  path: "G:\\tenders\\В работе\\298. Сокольники",
  sourceType: "tender"
};

const cpChunk = {
  id: "chunk-kp-1",
  fileId: "file-kp-1",
  sourceId: "tender-abc",
  path: "КП поставщика.pdf",
  title: "КП поставщика.pdf",
  text: "Коммерческое предложение\nПоставка арматуры\nСтоимость: 1 250 000,00 руб.",
  sourceType: "tender",
  tenderDocumentType: "commercial_proposal",
  tenderCommercialProposal: true,
  tenderHasPriceSignals: true
};

const estimateChunk = {
  id: "chunk-est-1",
  sourceId: "tender-abc",
  text: "Локальная смета, итого 900 000 руб.",
  sourceType: "tender",
  tenderDocumentType: "cost_estimate",
  tenderCommercialProposal: false,
  tenderHasPriceSignals: true
};

test("filterCommercialProposalChunks keeps only tender KP chunks with price signals", () => {
  assert.equal(isCommercialProposalChunk(cpChunk), true);
  assert.equal(isCommercialProposalChunk(estimateChunk), false);
  assert.deepEqual(
    filterCommercialProposalChunks([cpChunk, estimateChunk]).map((item) => item.id),
    ["chunk-kp-1"]
  );
});

test("compareMoney respects tolerance without float drift", () => {
  const within = compareMoney("1250000.000000", "1245000.000000", 1);
  assert.equal(within.match, true);
  assert.equal(within.leftNormalized, "1250000.000000");
  assert.equal(within.rightNormalized, "1245000.000000");

  const outside = compareMoney("1250000.000000", "1200000.000000", 1);
  assert.equal(outside.match, false);
  assert.equal(outside.delta, "50000.000000");
});

test("compareRecordWithCandidates emits citation evidence for mismatches", () => {
  const record = {
    id: "boq-1",
    positionName: "арматура",
    quoteLink: "КП поставщика.pdf",
    totalCommercialMaterialCost: "1300000.000000"
  };
  const candidates = [{
    amount: "1250000.00",
    label: "Поставка арматуры",
    supplier: "КП поставщика.pdf",
    chunkId: "chunk-kp-1",
    fileId: "file-kp-1",
    sourceId: "tender-abc",
    title: "КП поставщика.pdf",
    path: "КП поставщика.pdf"
  }];
  const findings = compareRecordWithCandidates(record, candidates, {
    tolerancePercent: 1,
    chunkById: new Map([[cpChunk.id, cpChunk]])
  });

  assert.equal(findings.length, 1);
  assert.equal(findings[0].severity, "error");
  assert.equal(findings[0].evidence.length, 1);
  assert.equal(findings[0].evidence[0].sourceId, "tender-abc");
  assert.equal(findings[0].evidence[0].chunkId, "chunk-kp-1");
  assert.ok(findings[0].evidence[0].citationLabel.includes("КП поставщика.pdf"));
  assert.ok(findings[0].evidence[0].snippet.length > 0);
});

test("buildAuditEvidence includes source/file/chunk identifiers", () => {
  const evidence = buildAuditEvidence(cpChunk, "Стоимость: 1 250 000 руб.");
  assert.equal(evidence.sourceId, "tender-abc");
  assert.equal(evidence.fileId, "file-kp-1");
  assert.equal(evidence.chunkId, "chunk-kp-1");
  assert.match(evidence.citationLabel, /КП поставщика/);
});

test("extractPriceCandidatesFromText finds labeled KP amounts", () => {
  const candidates = extractPriceCandidatesFromText(cpChunk.text);
  assert.ok(candidates.some((item) => item.amount === "1250000.00"));
});

test("runTenderPriceAudit reports needs_review when DB records are missing", async () => {
  const adapter = createMockHubTenderAdapter({
    tenders: [{ id: "ht-1", tenderNumber: "298", title: "Сокольники" }],
    priceRecords: []
  });

  const report = await runTenderPriceAudit({
    sourceId: "tender-abc",
    hubTenderId: "ht-1",
    adapter,
    readSourcesFn: async () => [tenderSource],
    readChunksFn: async () => [cpChunk, estimateChunk]
  });

  assert.equal(report.tenderId, "tender-abc");
  assert.equal(report.status, "needs_review");
  assert.equal(report.meta.cpChunkCount, 1);
  assert.equal(report.meta.dbRecordCount, 0);
  assert.ok(report.findings.some((item) => item.field === "dbRecord"));
  assert.ok(report.findings.some((item) => item.evidence.length > 0));
});

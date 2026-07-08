import assert from "node:assert/strict";
import test from "node:test";

import { matchTenderToRagSource } from "../apps/rag-api/src/tender-audit-match.js";
import { aggregateGlobalTotals } from "../apps/rag-api/src/tender-global-audit.js";
import { createMockHubTenderAdapter } from "../apps/rag-api/src/hubtender-adapter.js";
import { startGlobalTenderAudit } from "../apps/rag-api/src/tender-global-audit.js";

test("matchTenderToRagSource matches by tender number in source title", () => {
  const match = matchTenderToRagSource(
    { id: "ht-1", tenderNumber: "298", title: "Сокольники" },
    [{ id: "tender-abc", title: "298. Сокольники", sourceType: "tender" }]
  );
  assert.equal(match.ragSource.id, "tender-abc");
  assert.equal(match.strategy, "tenderNumber");
  assert.equal(match.confidence, "high");
});

test("aggregateGlobalTotals counts severities from nested findings", () => {
  const totals = aggregateGlobalTotals([
    {
      needsReview: true,
      findings: [
        { severity: "error" },
        { severity: "warning" },
        { severity: "needs_review" }
      ]
    }
  ]);
  assert.equal(totals.tendersChecked, 1);
  assert.equal(totals.findings, 3);
  assert.equal(totals.high, 1);
  assert.equal(totals.medium, 1);
  assert.equal(totals.low, 1);
});

test("startGlobalTenderAudit runs sync dry-run over mock tenders", async () => {
  const adapter = createMockHubTenderAdapter({
    tenders: [{ id: "ht-1", tenderNumber: "298", title: "Сокольники" }],
    priceRecords: []
  });
  const cpChunk = {
    id: "chunk-1",
    sourceId: "tender-abc",
    text: "Коммерческое предложение. Стоимость: 1000 руб.",
    sourceType: "tender",
    tenderDocumentType: "commercial_proposal",
    tenderCommercialProposal: true,
    tenderHasPriceSignals: true
  };
  const run = await startGlobalTenderAudit({
    adapter,
    runInBackground: false,
    readSourcesFn: async () => [{
      id: "tender-abc",
      title: "298. Сокольники",
      sourceType: "tender"
    }],
    readChunksFn: async () => [cpChunk]
  });

  assert.equal(run.tenderReports.length, 1);
  assert.equal(run.tenderReports[0].hubTenderNumber, "298");
  assert.equal(run.tenderReports[0].ragMatch.sourceId, "tender-abc");
  assert.ok(run.totals.findings >= 1);
});

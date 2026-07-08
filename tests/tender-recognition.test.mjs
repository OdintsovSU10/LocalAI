import assert from "node:assert/strict";
import test from "node:test";

import {
  recognizeTenderDocument,
  tenderChunkMetadata
} from "../apps/rag-api/src/tender-recognition.js";

test("recognizeTenderDocument marks tender commercial proposals with price signals", () => {
  const recognition = recognizeTenderDocument({
    source: {
      id: "tender-1",
      title: "298. Сокольники",
      path: "G:\\tenders\\В работе\\298. Сокольники",
      sourceType: "tender",
      tenderCategory: "В работе"
    },
    filePath: "G:\\tenders\\В работе\\298. Сокольники\\КП поставщика.pdf",
    relativePath: "КП поставщика.pdf",
    markdown: "Коммерческое предложение. Стоимость работ итого 1 250 000 руб. с НДС."
  });

  assert.equal(recognition.documentType, "commercial_proposal");
  assert.equal(recognition.isCommercialProposal, true);
  assert.equal(recognition.hasPriceSignals, true);
  assert.ok(recognition.signalScore > 40);

  const metadata = tenderChunkMetadata(recognition);
  assert.equal(metadata.sourceType, "tender");
  assert.equal(metadata.tenderDocumentType, "commercial_proposal");
  assert.equal(metadata.tenderCommercialProposal, true);
  assert.equal(metadata.tenderHasPriceSignals, true);
});

test("recognizeTenderDocument marks tender estimate files", () => {
  const recognition = recognizeTenderDocument({
    source: { id: "tender-2", title: "Сметный тендер", sourceType: "tender" },
    filePath: "G:\\tenders\\Done\\Локальная смета.xlsx",
    relativePath: "Локальная смета.xlsx",
    markdown: "Локальная смета, ресурсная ведомость, итого по смете."
  });

  assert.equal(recognition.documentType, "cost_estimate");
  assert.equal(recognition.hasEstimateSignals, true);
});

test("recognizeTenderDocument does not classify contract sources as tender KP", () => {
  const recognition = recognizeTenderDocument({
    source: { id: "contract-1", title: "Договор A", sourceType: "contract" },
    filePath: "\\\\share\\Договор A\\КП.pdf",
    relativePath: "КП.pdf",
    markdown: "Коммерческое предложение, цена 10 руб."
  });

  assert.equal(recognition.sourceType, "contract");
  assert.equal(recognition.documentType, "");
  assert.equal(recognition.isCommercialProposal, false);
  assert.deepEqual(tenderChunkMetadata(recognition), {
    sourceType: "contract",
    relativePath: "КП.pdf"
  });
});

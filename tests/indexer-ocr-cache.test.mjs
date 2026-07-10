import assert from "node:assert/strict";
import test from "node:test";

import { ocrCacheNeedsRefresh, shouldSuppressChunksForQuality } from "../apps/rag-api/src/indexer.js";

const enabledAllPages = { builtinOcr: { enabled: true, maxPages: 0 } };
const enabledThirtyPages = { builtinOcr: { enabled: true, maxPages: 30 } };
const enabledFiftyPages = { builtinOcr: { enabled: true, maxPages: 50 } };
const disabledOcr = { builtinOcr: { enabled: false, maxPages: 0 } };

test("ocrCacheNeedsRefresh invalidates limited OCR cache when current config allows all pages", () => {
  const markdown = "## OCR status\n\nRecognized 30 of 63 pages.";

  assert.equal(ocrCacheNeedsRefresh(markdown, enabledAllPages), true);
});

test("ocrCacheNeedsRefresh keeps cache when current cap matches cached page count", () => {
  const markdown = "## OCR status\n\nRecognized 30 of 63 pages.";

  assert.equal(ocrCacheNeedsRefresh(markdown, enabledThirtyPages), false);
});

test("ocrCacheNeedsRefresh invalidates limited OCR cache when current cap is higher", () => {
  const markdown = "## OCR status\n\nRecognized 30 of 63 pages.";

  assert.equal(ocrCacheNeedsRefresh(markdown, enabledFiftyPages), true);
});

test("ocrCacheNeedsRefresh ignores complete or disabled OCR cache", () => {
  assert.equal(ocrCacheNeedsRefresh("Recognized 63 of 63 pages.", enabledAllPages), false);
  assert.equal(ocrCacheNeedsRefresh("Recognized 30 of 63 pages.", disabledOcr), false);
});

test("shouldSuppressChunksForQuality rejects recognition-noise chunks", () => {
  assert.equal(shouldSuppressChunksForQuality({ warnings: ["ocr_text_noise"] }), true);
  assert.equal(shouldSuppressChunksForQuality({ warnings: ["pdf_text_layer_noise"] }), true);
  assert.equal(shouldSuppressChunksForQuality({ warnings: ["no_usable_ocr_pages"] }), true);
  assert.equal(shouldSuppressChunksForQuality({ warnings: ["low_ocr_confidence"] }), false);
});

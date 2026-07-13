import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import XLSX from "@e965/xlsx";

const previousDotenvConfigPath = process.env.DOTENV_CONFIG_PATH;
const previousOcrMaxPages = process.env.RAG_OCR_MAX_PAGES;
process.env.DOTENV_CONFIG_PATH = path.join(os.tmpdir(), `localai-converters-test-${process.pid}.env`);
delete process.env.RAG_OCR_MAX_PAGES;

const {
  converterStatus,
  convertToMarkdownWithReport,
  pdfjsAssets,
  textQualityReport,
  usableOcrPage,
  usablePdfTextLayer
} = await import("../apps/rag-api/src/converters.js?converters-test");

if (previousDotenvConfigPath === undefined) delete process.env.DOTENV_CONFIG_PATH;
else process.env.DOTENV_CONFIG_PATH = previousDotenvConfigPath;
if (previousOcrMaxPages === undefined) delete process.env.RAG_OCR_MAX_PAGES;
else process.env.RAG_OCR_MAX_PAGES = previousOcrMaxPages;

test("converterStatus defaults builtin OCR to all pages", () => {
  assert.equal(converterStatus().builtinOcr.maxPages, 0);
});

test("textQualityReport flags weak OCR/text extraction", () => {
  const weak = textQualityReport("12 34 !!", { minChars: 40, minWords: 5 });

  assert.equal(weak.warnings.includes("too_little_text"), true);
  assert.equal(weak.warnings.includes("too_few_words"), true);
  assert.equal(weak.score < 100, true);
});

test("textQualityReport accepts dense readable text", () => {
  const strong = textQualityReport(
    "Contract payment schedule includes thirty calendar days after invoice receipt and signed acceptance documents.",
    { minChars: 40, minWords: 5 }
  );

  assert.deepEqual(strong.warnings, []);
  assert.equal(strong.score, 100);
  assert.equal(strong.words >= 10, true);
});

// Without wasmUrl, PDF.js cannot load openjpeg.wasm and every JPEG2000 scan renders as a blank
// white page, which OCR then reports as an empty PDF. PDF.js also rejects a URL that does not
// end in a forward slash, so a Windows "\" separator here breaks rendering outright.
test("pdfjsAssets exposes usable PDF.js resource urls", async () => {
  const assets = pdfjsAssets();

  assert.equal(typeof assets.wasmUrl, "string");
  for (const url of [assets.wasmUrl, assets.cMapUrl, assets.standardFontDataUrl]) {
    assert.equal(url.endsWith("/"), true, `${url} должен заканчиваться прямым слэшем`);
    assert.equal(url.includes("\\"), false, `${url} не должен содержать обратных слэшей`);
  }

  await assert.doesNotReject(fs.access(path.join(assets.wasmUrl, "openjpeg.wasm")));
});

test("usableOcrPage rejects unreadable pages and keeps decent ones", () => {
  assert.equal(usableOcrPage({ chars: 10, words: 2, confidence: 90, warnings: [] }), false);
  assert.equal(usableOcrPage({ chars: 400, words: 60, confidence: 12, warnings: [] }), false);
  assert.equal(usableOcrPage({ chars: 400, words: 60, confidence: 80, warnings: ["ocr_text_noise"] }), false);
  assert.equal(usableOcrPage({ chars: 400, words: 60, confidence: 80, warnings: [] }), true);
});

test("usablePdfTextLayer rejects a noisy text layer so OCR runs", () => {
  const noisy = textQualityReport("pa60ma pa3pa6oTaHHO HaCTpoeHHO coBMeCTHO npoBepKa o6si 3aKa3a HaCTpouKa");

  assert.equal(usablePdfTextLayer(noisy), false);
});

test("textQualityReport flags OCR-like confusable text", () => {
  const noisy = textQualityReport(
    "pa60ma pa3pa6oTaHHO HaCTpoeHHO coBMeCTHO npoBepKa o6si 3aKa3a HaCTpouKa",
    { minChars: 40, minWords: 5 }
  );

  assert.equal(noisy.warnings.includes("ocr_text_noise"), true);
  assert.equal(noisy.noisyTokens >= 3, true);
  assert.equal(noisy.score < 100, true);
});

test("convertToMarkdownWithReport reads legacy xls commercial proposal sheets", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "localai-xls-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));

  const workbook = XLSX.utils.book_new();
  const worksheet = XLSX.utils.aoa_to_sheet([
    ["Поставщик", "Цена"],
    ["ООО КП", "123 000 руб."]
  ]);
  XLSX.utils.book_append_sheet(workbook, worksheet, "КП");
  const filePath = path.join(dir, "proposal.xls");
  const buffer = XLSX.write(workbook, { bookType: "xls", type: "buffer" });
  await fs.writeFile(filePath, buffer);

  const result = await convertToMarkdownWithReport(filePath);

  assert.equal(result.recognition.method, "xls");
  assert.match(result.markdown, /ООО КП/);
  assert.match(result.markdown, /123 000 руб/);
});

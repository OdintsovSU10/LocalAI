import assert from "node:assert/strict";
import test from "node:test";

import {
  chunkHeader,
  chunkTenderPd,
  looksLikeTenderPd,
  parseFields,
  parseTenderPd
} from "../apps/rag-api/src/tender-pd-source.js";

const VOLUME = [
  "# Document: ПД-АР.pdf",
  "",
  "Path: Событие 6.1 / 3. АР / ПД-АР.pdf",
  "",
  "**Stamp:** Code: ПД-00260560-АР | Stage: ПД | Object: Корпус 1 | Organization: АМ АТРИУМ",
  "",
  "---",
  "",
  "## Page 1",
  "",
  "### BLOCK #1 [IMAGE]: blk_aaa",
  "",
  "> **Crop:** [Crop](https://example.invalid/crops/aaa)",
  "> **Stamp:** Code: ПД-00260560-АР | Sheet: 12 | Name: План этажа | Revisions: КОР1",
  "",
  "**[IMAGE]** | Type: План | Axes: 1-8 | Level: -9,300, -5,700 | Zone: А",
  "",
  "**Summary:** План перекрытия на отметке -9,300.",
  "",
  "## Page 2",
  "",
  "### BLOCK #2 [TEXT]: blk_bbb",
  "",
  "> **Stamp:** Code: ПД-00260560-АР | Sheet: 13 | Name: Ведомость",
  "",
  "Бетон В25 W6 F150.",
  ""
].join("\n");

test("looksLikeTenderPd распознаёт формат только по заголовку и странице", () => {
  assert.equal(looksLikeTenderPd(VOLUME), true);
  assert.equal(looksLikeTenderPd("# Document: x.pdf\n\nбез страниц"), false);
  assert.equal(looksLikeTenderPd("## Page 1\n\nбез заголовка документа"), false);
  assert.equal(looksLikeTenderPd(""), false);
});

test("parseFields разбирает штамп в приведённые ключи", () => {
  assert.deepEqual(
    parseFields("Code: ПД-АР | Stage: ПД | Sheet: 12"),
    { code: "ПД-АР", stage: "ПД", sheet: "12" }
  );
});

test("шифр и стадия тома берутся из шапки", () => {
  const document = parseTenderPd(VOLUME);
  assert.equal(document.documentCode, "ПД-00260560-АР");
  assert.equal(document.stage, "ПД");
  assert.equal(document.documentName, "ПД-АР.pdf");
  assert.equal(document.pages.length, 2);
});

test("страница собирает лист, тип, оси, зону и кроп", () => {
  const [page] = parseTenderPd(VOLUME).pages;
  assert.equal(page.sheet, "12");
  assert.equal(page.title, "План этажа");
  assert.equal(page.revision, "КОР1");
  assert.equal(page.sheetType, "plan");
  assert.equal(page.axes, "1-8");
  assert.equal(page.zone, "А");
  assert.equal(page.cropUrl, "https://example.invalid/crops/aaa");
  assert.equal(page.pageKind, "drawing");
});

test("запятая внутри отметки не разделяет перечисление", () => {
  const [page] = parseTenderPd(VOLUME).pages;
  assert.equal(page.levels, "-9,300|-5,700");
});

test("служебные строки блока в текст страницы не попадают, а Summary попадает", () => {
  const [first, second] = parseTenderPd(VOLUME).pages;
  assert.ok(!first.text.includes("**Stamp:"));
  assert.ok(!first.text.includes("### BLOCK"));
  assert.ok(!first.text.includes("> **Crop:"));
  assert.ok(first.text.includes("**Summary:**"));
  assert.ok(second.text.includes("Бетон В25 W6 F150."));
});

test("pageKind различает чертёж, текст и смесь", () => {
  const pages = parseTenderPd(VOLUME).pages;
  assert.equal(pages[0].pageKind, "drawing");
  assert.equal(pages[1].pageKind, "text");
  const mixed = parseTenderPd(
    "# Document: x.pdf\n\n## Page 1\n\n### BLOCK #1 [IMAGE]: blk_a\n\n### BLOCK #2 [TEXT]: blk_b\n"
  );
  assert.equal(mixed.pages[0].pageKind, "mixed");
});

test("чанк = страница, метаданные листа идут перед телом", () => {
  const { chunks } = chunkTenderPd({ markdown: VOLUME, filePath: "project/PD/AR/markdown/x.md", discipline: "AR" });
  assert.equal(chunks.length, 2);
  assert.equal(chunks[0].page, 1);
  assert.equal(chunks[0].chunkOrd, 0);
  assert.equal(chunks[0].sheetOrBlock, "12");
  assert.ok(chunks[0].text.startsWith("AR | ПД-00260560-АР | лист 12 | План этажа | plan"));
  assert.ok(chunks[0].text.includes("отметки -9,300|-5,700"));
});

test("лист без номера подписывается идентификатором блока", () => {
  const { chunks } = chunkTenderPd({
    markdown: "# Document: x.pdf\n\n## Page 1\n\n### BLOCK #1 [IMAGE]: blk_ccc\n\nтекст\n",
    filePath: "x.md"
  });
  assert.equal(chunks[0].sheetOrBlock, "blk_ccc");
});

test("длинная страница режется, но каждая часть сохраняет шапку и номер страницы", () => {
  const body = "я".repeat(5000);
  const markdown = `# Document: x.pdf\n\n## Page 7\n\n### BLOCK #1 [TEXT]: blk_d\n\n> **Stamp:** Code: КР1 | Sheet: 5\n\n${body}\n`;
  const { chunks } = chunkTenderPd({ markdown, filePath: "x.md", discipline: "KJ", maxChars: 1000 });

  assert.ok(chunks.length > 1);
  for (const chunk of chunks) {
    assert.equal(chunk.page, 7);
    assert.ok(chunk.text.startsWith("KJ | КР1 | лист 5"));
    assert.ok(chunk.text.length <= 1000);
  }
  assert.deepEqual(chunks.map((chunk) => chunk.chunkOrd), chunks.map((_, index) => index));
});

test("шапка склеивается только из заполненных полей", () => {
  assert.equal(
    chunkHeader({ discipline: "AR", documentCode: "", sheetOrBlock: "", title: "План", levels: "" }),
    "AR | План"
  );
});

test("том без страниц даёт ноль чанков, а не падение", () => {
  const { chunks } = chunkTenderPd({ markdown: "# Document: x.pdf\n\nтолько шапка\n", filePath: "x.md" });
  assert.deepEqual(chunks, []);
});

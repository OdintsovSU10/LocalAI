import assert from "node:assert/strict";
import test from "node:test";

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  encodeVectorsNpy,
  exportTenderIndex,
  indexRowsByFile,
  isTenderPdFolder,
  npyHeader,
  parseCsv
} from "../apps/rag-api/src/tender-pd-export.js";

const VOLUME_MD = [
  "# Document: PD-AR.pdf", "",
  "**Stamp:** Code: PD-AR | Stage: PD", "", "---", "",
  "## Page 1", "",
  "### BLOCK #1 [IMAGE]: blk_aaa", "",
  "**[IMAGE]** | Type: План | Level: -9,300", "",
  "**Summary:** План перекрытия.", ""
].join("\n");

/** Минимальный тендер: один том, одна страница, один графический блок. */
async function makeTender(root) {
  await fs.mkdir(path.join(root, "project", "PD", "AR", "markdown"), { recursive: true });
  await fs.writeFile(path.join(root, "project", "PD", "AR", "markdown", "t_results.md"), VOLUME_MD, "utf8");
  await fs.mkdir(path.join(root, "project", "_admin"), { recursive: true });
  await fs.writeFile(
    path.join(root, "project", "_admin", "SHEET_INDEX.csv"),
    "source_id,discipline,file_path,page\nAR-1,AR,project/PD/AR/markdown/t_results.md,1\n",
    "utf8"
  );
  return root;
}

async function writeCropText(root, blockId, body) {
  const dir = path.join(root, "project", "_admin", "CROP_TEXT", "AR");
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, `${blockId}.md`), `# Crop ${blockId}\n\n- Раздел: AR\n\n---\n\n${body}\n`, "utf8");
}

async function buildTextOnly(root) {
  const manifest = await exportTenderIndex({ tenderRoot: root, withVectors: false, settings: {} });
  const raw = await fs.readFile(path.join(root, "project/_admin/VECTOR_INDEX/chunks.jsonl"), "utf8");
  return { manifest, chunks: raw.trim().split("\n").map((line) => JSON.parse(line)) };
}

test("без CROP_TEXT сборка не меняется", async () => {
  const root = await makeTender(await tempDir());
  const { manifest, chunks } = await buildTextOnly(root);
  assert.equal(manifest.chunks_with_crop_text, 0);
  assert.equal(chunks[0].has_crop_text, false);
  assert.equal(manifest.has_vectors, false);
});

test("текст кропа дописывается в чанк страницы и меняет хеш", async () => {
  const root = await makeTender(await tempDir());
  const before = await buildTextOnly(root);

  await writeCropText(root, "blk_aaa", "Плита 200мм бетон В25 W6 отм. -9,300");
  const after = await buildTextOnly(root);

  assert.equal(after.manifest.chunks_with_crop_text, 1);
  assert.equal(after.chunks[0].has_crop_text, true);
  assert.ok(after.chunks[0].text.includes("В25 W6"));
  // Хеш обязан измениться: иначе кеш отдал бы вектор, посчитанный без размеров.
  assert.notEqual(after.chunks[0].text_hash, before.chunks[0].text_hash);
});

test("кроп другого блока не подмешивается", async () => {
  const root = await makeTender(await tempDir());
  await writeCropText(root, "blk_чужой", "Не тот блок");
  const { chunks } = await buildTextOnly(root);
  assert.equal(chunks[0].has_crop_text, false);
  assert.ok(!chunks[0].text.includes("Не тот блок"));
});

test("пустое тело кропа не считается за текст", async () => {
  const root = await makeTender(await tempDir());
  await writeCropText(root, "blk_aaa", "   ");
  const { manifest, chunks } = await buildTextOnly(root);
  assert.equal(manifest.chunks_with_crop_text, 0);
  assert.equal(chunks[0].has_crop_text, false);
});

async function tempDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), "tender-pd-"));
}

async function withSheetIndex(root, content) {
  const dir = path.join(root, "project", "_admin");
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "SHEET_INDEX.csv"), content, "utf8");
}

test("папка с постраничным индексом опознаётся как тендерная ПД", async () => {
  const root = await tempDir();
  await withSheetIndex(root, "source_id,file_path,page\nAR-1,x.md,1\n");
  assert.equal(await isTenderPdFolder(root), true);
});

test("обычная папка тендерной ПД не считается", async () => {
  const root = await tempDir();
  await fs.mkdir(path.join(root, "project"), { recursive: true });
  assert.equal(await isTenderPdFolder(root), false);
});

test("пустой индекс листов не годится: экспортировать нечего", async () => {
  const root = await tempDir();
  await withSheetIndex(root, "");
  assert.equal(await isTenderPdFolder(root), false);
});

test("несуществующий путь и пустая строка не роняют проверку", async () => {
  assert.equal(await isTenderPdFolder(path.join(os.tmpdir(), "нет-такой-папки-12345")), false);
  assert.equal(await isTenderPdFolder(""), false);
  assert.equal(await isTenderPdFolder(null), false);
});

test("parseCsv держит запятые и кавычки внутри поля", () => {
  const rows = parseCsv('a,b\n1,"текст, с запятой"\n');
  assert.deepEqual(rows, [{ a: "1", b: "текст, с запятой" }]);
});

test("parseCsv разворачивает удвоенные кавычки и перевод строки в поле", () => {
  const rows = parseCsv('a,b\n1,"он сказал ""да""\nи ушёл"\n');
  assert.equal(rows[0].b, 'он сказал "да"\nи ушёл');
});

test("parseCsv снимает BOM с первого заголовка", () => {
  const rows = parseCsv("﻿source_id,page\nAR-1,3\n");
  assert.deepEqual(rows, [{ source_id: "AR-1", page: "3" }]);
});

test("parseCsv пропускает полностью пустые строки", () => {
  assert.equal(parseCsv("a,b\n1,2\n\n").length, 1);
});

test("npyHeader выравнивает заголовок на 64 байта и объявляет float16", () => {
  const header = npyHeader(6242, 1024);
  assert.equal(header.length % 64, 0);
  assert.equal(header.subarray(0, 6).toString("latin1"), "\x93NUMPY");
  assert.equal(header[6], 1);
  assert.ok(header.toString("latin1").includes("'descr': '<f2'"));
  assert.ok(header.toString("latin1").includes("'shape': (6242, 1024), }"));
});

test("encodeVectorsNpy пишет ровно N*dim значений после заголовка", () => {
  const buffer = encodeVectorsNpy([[1, 0], [0, 1], [0.5, -0.5]], 2);
  const headerLength = buffer.readUInt16LE(8);
  const payload = buffer.length - 10 - headerLength;
  assert.equal(payload, 3 * 2 * 2);
});

test("encodeVectorsNpy дополняет короткий вектор нулями, а не сдвигает соседний", () => {
  const buffer = encodeVectorsNpy([[1], [2, 3]], 2);
  const headerLength = buffer.readUInt16LE(8);
  const values = new Float16Array(
    buffer.buffer.slice(buffer.byteOffset + 10 + headerLength, buffer.byteOffset + buffer.length)
  );
  assert.deepEqual(Array.from(values), [1, 0, 2, 3]);
});

test("indexRowsByFile группирует по файлу и запоминает номер строки индекса", () => {
  const rows = [
    { file_path: "project/PD/AR/data/x_blocks.json", page: "", source_id: "AR-1" },
    { file_path: "project/PD/AR/markdown/x.md", page: "1", source_id: "AR-1" },
    { file_path: "project/PD/AR/markdown/x.md", page: "2", source_id: "AR-1" },
    { file_path: "project/PD/KJ/markdown/y.md", page: "1", source_id: "KJ-1" }
  ];
  const byFile = indexRowsByFile(rows);

  // Строка без номера страницы — это файловая запись легаси-раскладки, чанков не даёт.
  assert.equal(byFile.size, 2);
  assert.equal(byFile.get("project/PD/AR/markdown/x.md").size, 2);
  assert.equal(byFile.get("project/PD/AR/markdown/x.md").get("2").row, 2);
  assert.equal(byFile.get("project/PD/KJ/markdown/y.md").get("1").row, 3);
});

test("indexRowsByFile приводит разделители пути к прямому слэшу", () => {
  const byFile = indexRowsByFile([{ file_path: "project\\PD\\AR\\markdown\\x.md", page: "1" }]);
  assert.ok(byFile.has("project/PD/AR/markdown/x.md"));
});

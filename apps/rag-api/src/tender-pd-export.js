/**
 * Экспорт переносимого векторного индекса тендерной ПД.
 *
 * Считает эмбеддинги на локальной машине (LM Studio через Locus) и кладёт результат
 * обычными файлами в сам тендер — `project/_admin/VECTOR_INDEX/`. Дальше индекс едет на
 * удалённую машину тем же каналом синхронизации, что и остальной тендер, и не требует
 * поднимать там ни Qdrant, ни модель.
 *
 *     manifest.json     модель, размерность, счётчики, хеш SHEET_INDEX.csv
 *     vectors.f16.npy   (N, dim) float16, L2-нормализованные
 *     chunks.jsonl      построчно метаданные листа и текст чанка
 *
 * Индекс сам себе кеш: при повторном прогоне чанк с прежним textHash берёт вектор из
 * предыдущего `vectors.f16.npy`, и GPU считает только изменившееся.
 *
 * BM25 здесь намеренно не считается. Лексический поиск живёт на стороне Python в
 * TenderSkills: стеммер, реализованный дважды на двух языках, разошёлся бы незаметно и
 * тихо испортил выдачу. Locus отдаёт векторы, метаданные и текст — этого достаточно.
 */

import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { embedTexts, normalizeEmbeddingSettings, textHash } from "./embeddings.js";
import { readSettings } from "./store.js";
import { chunkTenderPd, looksLikeTenderPd } from "./tender-pd-source.js";

export const VECTOR_INDEX_DIR = path.join("project", "_admin", "VECTOR_INDEX");
export const SHEET_INDEX_REL = path.join("project", "_admin", "SHEET_INDEX.csv");
const SCHEMA_VERSION = 1;

/**
 * Тендерная ПД опознаётся по содержимому папки, а не по типу в конфиге.
 *
 * Отдельный `sourceType` пришлось бы выставлять руками в config/sources.yaml: интерфейс
 * берёт тип из активной вкладки и знает только «договор» и «тендер». Наличие
 * постраничного индекса листов — признак самоописывающийся: он появляется ровно тогда,
 * когда экспортировать уже есть что, и исчезать сам по себе не может.
 */
export async function isTenderPdFolder(folderPath) {
  if (!folderPath) return false;
  try {
    const stats = await fs.stat(path.join(folderPath, SHEET_INDEX_REL));
    return stats.isFile() && stats.size > 0;
  } catch {
    return false;
  }
}

/**
 * Разбор CSV по RFC 4180.
 *
 * `SHEET_INDEX.csv` содержит краткое содержание листов: там и запятые, и кавычки, и
 * переводы строк внутри поля. Разбиение по запятой ломает файл молча, поэтому парсер
 * настоящий, а не split(",").
 */
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;
  const source = text.replace(/^﻿/, "");
  for (let at = 0; at < source.length; at += 1) {
    const char = source[at];
    if (quoted) {
      if (char === '"') {
        if (source[at + 1] === '"') { field += '"'; at += 1; }
        else quoted = false;
      } else field += char;
      continue;
    }
    if (char === '"') { quoted = true; continue; }
    if (char === ",") { row.push(field); field = ""; continue; }
    if (char === "\r") continue;
    if (char === "\n") { row.push(field); rows.push(row); row = []; field = ""; continue; }
    field += char;
  }
  if (field !== "" || row.length) { row.push(field); rows.push(row); }
  if (!rows.length) return [];
  const header = rows.shift();
  return rows
    .filter((values) => values.some((value) => value !== ""))
    .map((values) => Object.fromEntries(header.map((name, index) => [name, values[index] ?? ""])));
}

/** Заголовок .npy версии 1.0. Формат простой, тянуть ради него зависимость незачем. */
export function npyHeader(rows, columns) {
  const descriptor = `{'descr': '<f2', 'fortran_order': False, 'shape': (${rows}, ${columns}), }`;
  const prefix = 10;
  const padding = 64 - ((prefix + descriptor.length + 1) % 64 || 64);
  const header = descriptor + " ".repeat(padding) + "\n";
  const buffer = Buffer.alloc(prefix + header.length);
  buffer.write("\x93NUMPY", 0, "latin1");
  buffer[6] = 1;
  buffer[7] = 0;
  buffer.writeUInt16LE(header.length, 8);
  buffer.write(header, prefix, "latin1");
  return buffer;
}

export function encodeVectorsNpy(vectors, dimensions) {
  const flat = new Float16Array(vectors.length * dimensions);
  vectors.forEach((vector, index) => {
    for (let axis = 0; axis < dimensions; axis += 1) flat[index * dimensions + axis] = vector[axis] || 0;
  });
  return Buffer.concat([npyHeader(vectors.length, dimensions), Buffer.from(flat.buffer)]);
}

async function readJsonl(file) {
  try {
    const text = await fs.readFile(file, "utf8");
    return text.split("\n").filter(Boolean).map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

/**
 * Векторы предыдущего прогона как кеш: textHash -> вектор.
 *
 * Читается только если размерность и модель совпадают с текущими настройками. Иначе
 * кеш молча смешал бы векторы двух моделей в одном файле — это хуже, чем пересчитать.
 */
async function readPreviousVectors(indexDir, model, dimensions) {
  const cache = new Map();
  let manifest;
  try {
    manifest = JSON.parse(await fs.readFile(path.join(indexDir, "manifest.json"), "utf8"));
  } catch {
    return cache;
  }
  if (manifest.model !== model || Number(manifest.dim) !== dimensions) return cache;

  let raw;
  try {
    raw = await fs.readFile(path.join(indexDir, "vectors.f16.npy"));
  } catch {
    return cache;
  }
  const chunks = await readJsonl(path.join(indexDir, "chunks.jsonl"));
  const headerLength = raw.readUInt16LE(8);
  const offset = 10 + headerLength;
  const values = new Float16Array(
    raw.buffer.slice(raw.byteOffset + offset, raw.byteOffset + raw.length)
  );
  if (values.length < chunks.length * dimensions) return cache;
  chunks.forEach((chunk, index) => {
    if (!chunk.text_hash) return;
    cache.set(chunk.text_hash, Array.from(values.subarray(index * dimensions, (index + 1) * dimensions)));
  });
  return cache;
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

/**
 * Строки постраничного индекса, сгруппированные по файлу тома.
 *
 * `SHEET_INDEX.csv` — единственный источник правды о том, что вообще входит в расчёт:
 * из него берутся `source_id`, дисциплина и редакция, и по нему же чанк получает номер
 * строки, чтобы `query_sheets.py` мог вернуться к структурным фильтрам без своей схемы.
 */
export function indexRowsByFile(rows) {
  const byFile = new Map();
  rows.forEach((row, position) => {
    if (!row.page) return;
    const key = row.file_path.replace(/\\/g, "/");
    if (!byFile.has(key)) byFile.set(key, new Map());
    byFile.get(key).set(String(row.page), { ...row, row: position });
  });
  return byFile;
}

async function collectChunks(tenderRoot, byFile, onProgress) {
  const chunks = [];
  const files = [...byFile.keys()].sort();
  let done = 0;
  for (const relative of files) {
    done += 1;
    if (!relative.toLowerCase().endsWith(".md")) continue;
    const absolute = path.join(tenderRoot, relative);
    let markdown;
    try {
      markdown = await fs.readFile(absolute, "utf8");
    } catch {
      continue;
    }
    if (!looksLikeTenderPd(markdown)) continue;

    const pages = byFile.get(relative);
    const first = pages.values().next().value || {};
    const { chunks: parsed } = chunkTenderPd({
      markdown,
      filePath: relative,
      discipline: first.discipline || "",
      revision: first.revision || "",
      sourceId: first.source_id || ""
    });
    for (const chunk of parsed) {
      const indexRow = pages.get(String(chunk.page));
      // Страница, которой нет в SHEET_INDEX, в расчёт не входит: индекс — источник правды.
      if (!indexRow) continue;
      chunks.push({
        row: indexRow.row,
        source_id: indexRow.source_id || chunk.sourceId,
        file_path: relative,
        page: chunk.page,
        chunk_ord: chunk.chunkOrd,
        discipline: indexRow.discipline || chunk.discipline,
        document_code: indexRow.document_code || chunk.documentCode,
        sheet_or_block: indexRow.sheet_or_block || chunk.sheetOrBlock,
        revision: indexRow.revision || "",
        sheet_type: indexRow.sheet_type || chunk.sheetType,
        levels: indexRow.levels || chunk.levels,
        axes: indexRow.axes || chunk.axes,
        zone: indexRow.zone || chunk.zone,
        page_kind: indexRow.page_kind || chunk.pageKind,
        crop_url: indexRow.crop_url || chunk.cropUrl,
        text_hash: textHash(chunk.text),
        text: chunk.text
      });
    }
    onProgress?.({ stage: "parse", done, total: files.length, file: relative, chunks: chunks.length });
  }
  return chunks;
}

async function embedChunks({ chunks, embeddings, cache, signal, onProgress }) {
  const vectors = new Array(chunks.length);
  const pending = [];
  chunks.forEach((chunk, index) => {
    const cached = cache.get(chunk.text_hash);
    if (cached) vectors[index] = cached;
    else pending.push(index);
  });

  const batchSize = embeddings.batchSize;
  for (let at = 0; at < pending.length; at += batchSize) {
    const slice = pending.slice(at, at + batchSize);
    const computed = await embedTexts({
      embeddings,
      texts: slice.map((index) => chunks[index].text),
      signal
    });
    if (computed.length !== slice.length) {
      throw new Error(`Эндпоинт вернул ${computed.length} векторов на ${slice.length} чанков`);
    }
    slice.forEach((index, position) => { vectors[index] = computed[position]; });
    onProgress?.({
      stage: "embed",
      done: Math.min(at + batchSize, pending.length),
      total: pending.length,
      reused: chunks.length - pending.length
    });
  }
  return { vectors, computed: pending.length, reused: chunks.length - pending.length };
}

/**
 * Собрать и записать индекс. Возвращает манифест.
 *
 * `apply: false` считает всё, кроме записи файлов, — так видно объём работы и стоимость
 * прогона до того, как что-то поменяется на диске.
 */
export async function exportTenderIndex({
  tenderRoot, settings = null, signal = null, onProgress = null, apply = true, withVectors = true
}) {
  const root = path.resolve(tenderRoot);
  const sheetIndexPath = path.join(root, SHEET_INDEX_REL);

  let sheetIndexRaw;
  try {
    sheetIndexRaw = await fs.readFile(sheetIndexPath, "utf8");
  } catch {
    throw new Error(`Не найден постраничный индекс ${SHEET_INDEX_REL}. Сначала выполните bootstrap-tender.`);
  }

  const resolved = settings || await readSettings();
  const rows = parseCsv(sheetIndexRaw);
  const byFile = indexRowsByFile(rows);
  const chunks = await collectChunks(root, byFile, onProgress);
  if (!chunks.length) throw new Error("Не набрано ни одного чанка: проверьте project/PD/**/markdown");

  const indexDir = path.join(root, VECTOR_INDEX_DIR);
  let vectors = null;
  let dimensions = 0;
  let model = "";
  let computed = 0;
  let reused = 0;

  // Векторы необязательны. Поиск по словам (BM25) считается на стороне тендерных скриптов
  // прямо по chunks.jsonl и никакой модели не требует, поэтому индекс имеет смысл собрать
  // и там, где эмбеддинги считать нечем. Векторы можно досчитать позже тем же прогоном:
  // чанки не изменятся, добавится только vectors.f16.npy.
  if (withVectors) {
    const embeddings = normalizeEmbeddingSettings(resolved.embeddings);
    if (!embeddings.enabled) throw new Error("Эмбеддинги выключены в настройках Locus");
    model = embeddings.model;

    // Размерность берём с первого настоящего ответа модели, а не из настроек: настройка
    // может отстать от того, что реально загружено в LM Studio.
    const [probe] = await embedTexts({ embeddings, texts: [chunks[0].text], signal });
    if (!probe?.length) throw new Error("Эндпоинт эмбеддингов вернул пустой вектор");
    dimensions = probe.length;

    const cache = await readPreviousVectors(indexDir, model, dimensions);
    ({ vectors, computed, reused } = await embedChunks({ chunks, embeddings, cache, signal, onProgress }));

    const wrong = vectors.findIndex((vector) => !vector || vector.length !== dimensions);
    if (wrong !== -1) throw new Error(`Чанк ${wrong} получил вектор неверной размерности`);
  }

  const manifest = {
    schema_version: SCHEMA_VERSION,
    model,
    dim: dimensions,
    metric: "cosine",
    has_vectors: Boolean(vectors),
    built_at: new Date().toISOString(),
    chunk_count: chunks.length,
    page_count: byFile.size ? [...byFile.values()].reduce((sum, pages) => sum + pages.size, 0) : 0,
    document_count: byFile.size,
    sheet_index_rows: rows.length,
    sheet_index_sha256: sha256(sheetIndexRaw),
    vectors_computed: computed,
    vectors_reused: reused
  };

  if (!apply) return { ...manifest, status: "DRY_RUN", index_dir: indexDir };

  await fs.mkdir(indexDir, { recursive: true });
  const vectorsPath = path.join(indexDir, "vectors.f16.npy");
  if (vectors) {
    await fs.writeFile(vectorsPath, encodeVectorsNpy(vectors, dimensions));
  } else {
    // Векторы прошлой сборки соответствуют прежним чанкам построчно, а chunks.jsonl
    // только что переписан. Оставить файл — значит отдать поиску чужие векторы молча,
    // и при совпавшем числе чанков это даже не всплывёт как ошибка размера.
    await fs.rm(vectorsPath, { force: true });
  }
  await fs.writeFile(
    path.join(indexDir, "chunks.jsonl"),
    chunks.map((chunk) => JSON.stringify(chunk)).join("\n") + "\n",
    "utf8"
  );
  await fs.writeFile(
    path.join(indexDir, "manifest.json"),
    JSON.stringify(manifest, null, 2) + "\n",
    "utf8"
  );
  onProgress?.({ stage: "done", done: chunks.length, total: chunks.length });
  return { ...manifest, status: "APPLIED", index_dir: indexDir };
}

#!/usr/bin/env node
// Diagnose why a single PDF recognizes badly (or not at all).
//
//   node scripts/diagnose-pdf.mjs "D:\path\to\scan.pdf"
//   node scripts/diagnose-pdf.mjs "scan.pdf" --scale=2 --scale=4 --pages=1-3
//
// Prints the text-layer verdict, per-page OCR chars/confidence with the accept/reject
// verdict for each page, and the manifest entry the indexer stored for this file.

import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

function parseArgs(argv) {
  const scales = [];
  let pages = "1-3";
  let target = "";

  for (const arg of argv) {
    if (arg.startsWith("--scale=")) scales.push(Number(arg.slice(8)));
    else if (arg.startsWith("--pages=")) pages = arg.slice(8);
    else if (!arg.startsWith("--")) target = arg;
  }

  return { target, scales: scales.filter(Number.isFinite), pages };
}

function parsePageRange(value) {
  const match = String(value || "").match(/^(\d+)(?:-(\d+))?$/);
  if (!match) return { from: 1, to: 3 };
  const from = Math.max(1, Number(match[1]));
  const to = match[2] ? Math.max(from, Number(match[2])) : from;
  return { from, to };
}

async function binaryVersion(command) {
  try {
    const { stdout } = await execFileAsync(command, ["--version"], { timeout: 15000, windowsHide: true });
    return String(stdout || "").split(/\r?\n/)[0].trim() || "ok";
  } catch (error) {
    return `недоступен (${error?.code || error?.message || "error"})`;
  }
}

async function manifestEntryFor(filePath) {
  const { manifestPath } = await import("../apps/rag-api/src/paths.js");
  let manifest;
  try {
    manifest = JSON.parse(await fs.readFile(manifestPath(), "utf8"));
  } catch (error) {
    return { error: `манифест не прочитан: ${error.message}` };
  }

  const wanted = path.resolve(filePath).toLowerCase();
  for (const entry of Object.values(manifest.files || {})) {
    if (String(entry?.path || "").toLowerCase() === wanted) return { entry };
  }
  return { error: "запись в манифесте не найдена" };
}

// converters.js reads its config into consts at import time, so the env must be set
// beforehand and the module re-imported (via a unique query) for each scale.
async function loadConverters(scale) {
  if (scale) process.env.RAG_OCR_SCALE = String(scale);
  return import(`../apps/rag-api/src/converters.js?diagnose-${scale || "default"}`);
}

async function runScale(filePath, scale, range) {
  const converters = await loadConverters(scale);
  const status = converters.converterStatus();
  const effectiveScale = status.builtinOcr.scale;

  console.log(`\n=== OCR scale ${effectiveScale} (~${Math.round(effectiveScale * 72)} DPI) ===`);

  const { pdf } = await import("pdf-to-img");
  const document = await pdf(filePath, { scale: effectiveScale });
  const totalPages = Number(document.length || 0);
  const to = Math.min(range.to, totalPages);
  console.log(`Страниц в PDF: ${totalPages}; проверяем ${range.from}-${to}`);

  const worker = await (await import("tesseract.js")).createWorker(status.builtinOcr.langs, 1, {
    cachePath: process.env.RAG_OCR_CACHE_DIR || path.join(os.tmpdir(), "locus-ocr-cache")
  });

  try {
    const confidences = [];
    for (let pageNumber = range.from; pageNumber <= to; pageNumber += 1) {
      const image = await document.getPage(pageNumber);
      const result = await worker.recognize(image);
      const text = String(result?.data?.text || "");
      const report = converters.ocrPageReport(pageNumber, text, result?.data?.confidence);
      const usable = converters.usableOcrPage(report);
      confidences.push(Number(report.confidence));

      // A near-zero image size means pdf.js could not rasterize the page at all.
      console.log(
        `  стр. ${pageNumber}: изображение ${image.length} Б; символов ${report.chars}; слов ${report.words}; `
        + `уверенность ${report.confidence ?? "-"}%; шум ${report.noiseRatio}; `
        + `${usable ? "ПРИНЯТА" : "ОТБРАКОВАНА"}${report.warnings.length ? ` [${report.warnings.join(", ")}]` : ""}`
      );

      if (pageNumber === range.from) {
        const preview = path.join(os.tmpdir(), `locus-diagnose-scale${effectiveScale}-p${pageNumber}.png`);
        await fs.writeFile(preview, image);
        console.log(`  снимок страницы: ${preview}`);
        console.log(`  первые 200 символов: ${text.replace(/\s+/g, " ").slice(0, 200)}`);
      }
    }

    const valid = confidences.filter(Number.isFinite);
    if (valid.length) {
      const avg = Math.round(valid.reduce((sum, value) => sum + value, 0) / valid.length);
      console.log(`  средняя уверенность: ${avg}%`);
    }
  } finally {
    await worker.terminate();
    if (typeof document.destroy === "function") await document.destroy();
  }
}

async function main() {
  const { target, scales, pages } = parseArgs(process.argv.slice(2));
  if (!target) {
    console.error("Использование: node scripts/diagnose-pdf.mjs <файл.pdf> [--scale=N ...] [--pages=1-3]");
    process.exitCode = 1;
    return;
  }

  const filePath = path.resolve(target);
  const stat = await fs.stat(filePath);
  const range = parsePageRange(pages);

  console.log(`Файл: ${filePath}`);
  console.log(`Размер: ${(stat.size / 1024 / 1024).toFixed(1)} МБ`);

  const converters = await loadConverters(null);
  console.log("\n--- Конфигурация ---");
  console.log(JSON.stringify(converters.converterStatus(), null, 2));

  console.log("\n--- Внешние бинарники ---");
  for (const command of ["ocrmypdf", "tesseract", "gs"]) {
    console.log(`  ${command}: ${await binaryVersion(command)}`);
  }

  // Each stage is independent: a PDF that pdf-parse cannot even open is itself a finding,
  // and must not stop the OCR stage from running.
  console.log("\n--- Текстовый слой PDF (pdf-parse) ---");
  try {
    const pdfParse = (await import("pdf-parse")).default;
    const parsed = await pdfParse(await fs.readFile(filePath));
    const textQuality = converters.textQualityReport(parsed.text || "");
    const usableText = converters.usablePdfTextLayer(textQuality);
    console.log(`  страниц: ${parsed.numpages}; символов: ${textQuality.chars}; слов: ${textQuality.words}`);
    console.log(`  балл: ${textQuality.score}; предупреждения: ${textQuality.warnings.join(", ") || "нет"}`);
    console.log(`  вердикт: ${usableText ? "текстовый слой годен — OCR не запустится" : "текстовый слой негоден — пойдет OCR"}`);
  } catch (error) {
    console.log(`  pdf-parse не смог прочитать файл: ${error?.message || error}`);
    console.log("  вердикт: текстового слоя нет — пойдет OCR");
  }

  console.log("\n--- Запись в манифесте ---");
  const { entry, error } = await manifestEntryFor(filePath);
  if (error) console.log(`  ${error}`);
  else console.log(JSON.stringify({ recognition: entry.recognition, quality: entry.quality }, null, 2));

  for (const scale of (scales.length ? scales : [null])) {
    try {
      await runScale(filePath, scale, range);
    } catch (scaleError) {
      console.log(`  OCR на scale ${scale || "по умолчанию"} упал: ${scaleError?.message || scaleError}`);
    }
  }
}

main().catch((error) => {
  console.error(`Диагностика упала: ${error?.stack || error?.message || error}`);
  process.exitCode = 1;
});

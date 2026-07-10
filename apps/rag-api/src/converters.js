import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import ExcelJS from "exceljs";
import iconv from "iconv-lite";
import mammoth from "mammoth";
import pdfParse from "pdf-parse";
import { pdf } from "pdf-to-img";
import { createWorker } from "tesseract.js";
import XLSX from "@e965/xlsx";
import { dataDir } from "./paths.js";
import { normalizeText } from "./text.js";

const TEXT_EXTENSIONS = new Set([".txt", ".md", ".markdown", ".csv", ".log"]);
const PDF_TEXT_MIN_CHARS = numberFromEnv("RAG_PDF_TEXT_MIN_CHARS", 120, { min: 0, max: 10000 });
const TEXT_NOISE_RATIO = numberFromEnv("RAG_TEXT_NOISE_RATIO", 0.08, { min: 0, max: 1 });
const TEXT_NOISE_MIN_TOKENS = numberFromEnv("RAG_TEXT_NOISE_MIN_TOKENS", 3, { min: 1, max: 1000 });
const OCR_MAX_PAGES = numberFromEnv("RAG_OCR_MAX_PAGES", 0, { min: 0, max: 10000 });
const OCR_SCALE = numberFromEnv("RAG_OCR_SCALE", 2, { min: 1, max: 4 });
const OCR_LANGS = process.env.RAG_OCR_LANGS || "rus+eng";
const OCR_CACHE_DIR = process.env.RAG_OCR_CACHE_DIR || path.join(dataDir(), "ocr-cache");
const OCR_ENABLED = !["0", "false", "off", "no"].includes(String(process.env.RAG_OCR_ENABLED || "1").toLowerCase());
const PDF_CONVERTER = normalizePdfConverter(process.env.RAG_PDF_CONVERTER || "builtin");
const PDF_OCR_MODE = normalizePdfOcrMode(process.env.RAG_PDF_OCR_MODE || "auto");
const DOCLING_ENABLED = PDF_CONVERTER === "docling" || envFlag("RAG_DOCLING_ENABLED", false);
const DOCLING_COMMAND = process.env.RAG_DOCLING_COMMAND || "docling";
const DOCLING_CACHE_DIR = process.env.RAG_DOCLING_CACHE_DIR || path.join(dataDir(), "docling-cache");
const DOCLING_TIMEOUT_SECONDS = numberFromEnv("RAG_DOCLING_TIMEOUT_SECONDS", 300, { min: 15, max: 3600 });
const OCRMYPDF_ENABLED = PDF_CONVERTER === "ocrmypdf" || envFlag("RAG_OCRMYPDF_ENABLED", false);
const OCRMYPDF_COMMAND = process.env.RAG_OCRMYPDF_COMMAND || "ocrmypdf";
const OCRMYPDF_CACHE_DIR = process.env.RAG_OCRMYPDF_CACHE_DIR || path.join(dataDir(), "ocrmypdf-cache");
const OCRMYPDF_TIMEOUT_SECONDS = numberFromEnv("RAG_OCRMYPDF_TIMEOUT_SECONDS", 300, { min: 15, max: 3600 });
let ocrWorkerPromise = null;
const execFileAsync = promisify(execFile);

export const supportedExtensions = new Set([
  ".pdf",
  ".docx",
  ".xlsx",
  ".xlsm",
  ".xls",
  ".txt",
  ".md",
  ".markdown",
  ".csv"
]);

export function converterStatus() {
  return {
    pdfConverter: PDF_CONVERTER,
    pdfTextMinChars: PDF_TEXT_MIN_CHARS,
    builtinOcr: {
      enabled: OCR_ENABLED,
      langs: OCR_LANGS,
      maxPages: OCR_MAX_PAGES,
      scale: OCR_SCALE
    },
    pdfOcrMode: PDF_OCR_MODE,
    docling: {
      enabled: DOCLING_ENABLED,
      command: DOCLING_COMMAND,
      timeoutSeconds: DOCLING_TIMEOUT_SECONDS,
      cacheDir: DOCLING_CACHE_DIR
    },
    ocrmypdf: {
      enabled: OCRMYPDF_ENABLED,
      command: OCRMYPDF_COMMAND,
      timeoutSeconds: OCRMYPDF_TIMEOUT_SECONDS,
      cacheDir: OCRMYPDF_CACHE_DIR
    }
  };
}

function numberFromEnv(name, fallback, { min = Number.NEGATIVE_INFINITY, max = Number.POSITIVE_INFINITY } = {}) {
  const value = Number(process.env[name]);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

function envFlag(name, fallback = false) {
  const value = process.env[name];
  if (value === undefined || String(value).trim() === "") return fallback;
  return ["1", "true", "yes", "on"].includes(String(value).trim().toLowerCase());
}

function normalizePdfConverter(value) {
  const normalized = String(value || "builtin").trim().toLowerCase();
  return ["builtin", "docling", "ocrmypdf", "auto"].includes(normalized) ? normalized : "builtin";
}

function normalizePdfOcrMode(value) {
  const normalized = String(value || "auto").trim().toLowerCase();
  return ["auto", "force", "compare"].includes(normalized) ? normalized : "auto";
}

function reportProgress(options, progress) {
  if (typeof options?.onProgress === "function") options.onProgress(progress);
}

function average(values) {
  const numbers = values.map(Number).filter(Number.isFinite);
  if (!numbers.length) return null;
  return Math.round(numbers.reduce((sum, value) => sum + value, 0) / numbers.length);
}

function percentile(values, ratio) {
  const numbers = values.map(Number).filter(Number.isFinite).sort((left, right) => left - right);
  if (!numbers.length) return null;
  const index = Math.max(0, Math.min(numbers.length - 1, Math.floor((numbers.length - 1) * ratio)));
  return Math.round(numbers[index]);
}

function countMatches(text, pattern) {
  return String(text || "").match(pattern)?.length || 0;
}

const WORD_TOKEN_RE = /[\p{L}\p{N}]{2,}/gu;
const LETTER_RE = /\p{L}/u;
const LATIN_RE = /\p{Script=Latin}/u;
const CYRILLIC_RE = /\p{Script=Cyrillic}/u;
const DIGIT_RE = /\p{N}/u;

function recognitionNoiseReport(text) {
  const tokens = Array.from(String(text || "").matchAll(WORD_TOKEN_RE), (match) => match[0]);
  let letterTokens = 0;
  let mixedScriptTokens = 0;
  let alphaDigitTokens = 0;

  for (const token of tokens) {
    if (!LETTER_RE.test(token)) continue;
    letterTokens += 1;

    const hasLatin = LATIN_RE.test(token);
    const hasCyrillic = CYRILLIC_RE.test(token);
    const hasDigit = DIGIT_RE.test(token);

    if (hasLatin && hasCyrillic) mixedScriptTokens += 1;
    else if (token.length >= 4 && hasDigit) alphaDigitTokens += 1;
  }

  const noisyTokens = mixedScriptTokens + alphaDigitTokens;
  const noiseRatio = letterTokens ? noisyTokens / letterTokens : 0;

  return {
    letterTokens,
    noisyTokens,
    mixedScriptTokens,
    alphaDigitTokens,
    noiseRatio: Number(noiseRatio.toFixed(3)),
    severe: noisyTokens >= TEXT_NOISE_MIN_TOKENS && noiseRatio >= TEXT_NOISE_RATIO
  };
}

export function textQualityReport(markdown, options = {}) {
  const text = normalizeText(markdown);
  const chars = text.length;
  const minChars = Number(options.minChars ?? PDF_TEXT_MIN_CHARS);
  const minWords = Number(options.minWords ?? 25);
  const letters = countMatches(text, /\p{L}/gu);
  const words = countMatches(text, /[\p{L}\p{N}]{2,}/gu);
  const replacementChars = countMatches(text, /\uFFFD/g);
  const letterRatio = chars ? letters / chars : 0;
  const replacementRatio = chars ? replacementChars / chars : 0;
  const recognitionNoise = recognitionNoiseReport(text);
  const warnings = [];

  if (chars < minChars) warnings.push("too_little_text");
  if (words < minWords) warnings.push("too_few_words");
  if (chars >= minChars && letterRatio < 0.2) warnings.push("low_text_density");
  if (replacementRatio > 0.01) warnings.push("encoding_noise");
  if (recognitionNoise.severe) warnings.push("ocr_text_noise");

  let score = 100;
  if (warnings.includes("too_little_text")) score -= 30;
  if (warnings.includes("too_few_words")) score -= 20;
  if (warnings.includes("low_text_density")) score -= 20;
  if (warnings.includes("encoding_noise")) score -= 25;
  if (warnings.includes("ocr_text_noise")) score -= 35;

  return {
    score: Math.max(0, Math.min(100, score)),
    warnings,
    chars,
    words,
    letterRatio: Number(letterRatio.toFixed(3)),
    replacementRatio: Number(replacementRatio.toFixed(3)),
    noiseRatio: recognitionNoise.noiseRatio,
    noisyTokens: recognitionNoise.noisyTokens,
    mixedScriptTokens: recognitionNoise.mixedScriptTokens,
    alphaDigitTokens: recognitionNoise.alphaDigitTokens
  };
}

function usablePdfTextLayer(report) {
  return Number(report?.chars || 0) >= PDF_TEXT_MIN_CHARS
    && Number(report?.words || 0) >= 10
    && Number(report?.score || 0) >= 70
    && !report?.warnings?.includes("encoding_noise")
    && !report?.warnings?.includes("ocr_text_noise");
}

function ocrPageReport(pageNumber, text, confidence) {
  const quality = textQualityReport(text, { minChars: 20, minWords: 3 });
  const roundedConfidence = Number.isFinite(Number(confidence)) ? Math.round(Number(confidence)) : null;
  const warnings = [...quality.warnings];
  if (Number.isFinite(Number(roundedConfidence)) && roundedConfidence < 50) warnings.push("low_ocr_confidence");

  return {
    page: pageNumber,
    chars: quality.chars,
    words: quality.words,
    confidence: roundedConfidence,
    letterRatio: quality.letterRatio,
    noiseRatio: quality.noiseRatio,
    noisyTokens: quality.noisyTokens,
    warnings: [...new Set(warnings)]
  };
}

function usableOcrPage(page) {
  const warnings = new Set(page?.warnings || []);
  const confidence = Number(page?.confidence);
  if (Number(page?.chars || 0) < 20 || Number(page?.words || 0) < 3) return false;
  if (warnings.has("ocr_text_noise") || warnings.has("encoding_noise") || warnings.has("low_text_density")) return false;
  return !Number.isFinite(confidence) || confidence >= 25;
}

function recognitionReport(method, markdown, extra = {}) {
  return {
    method,
    chars: normalizeText(markdown).length,
    ...extra
  };
}

function sha1(value) {
  return crypto.createHash("sha1").update(String(value || "")).digest("hex");
}

async function fileCacheKey(filePath, namespace) {
  const stat = await fs.stat(filePath);
  return sha1(`${namespace}:${filePath}:${stat.size}:${stat.mtimeMs}:${OCR_LANGS}`);
}

function commandErrorMessage(error) {
  const details = [error?.message, error?.stderr, error?.stdout]
    .map((item) => String(item || "").trim())
    .filter(Boolean)
    .join("\n");
  return details || "external converter failed";
}

async function collectMarkdownFiles(dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
  const files = [];
  for (const entry of entries) {
    const entryPath = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...await collectMarkdownFiles(entryPath));
    else if (entry.isFile() && [".md", ".markdown"].includes(path.extname(entry.name).toLowerCase())) files.push(entryPath);
  }
  return files;
}

async function extractPdfText(filePath) {
  const buffer = await fs.readFile(filePath);
  const result = await pdfParse(buffer);
  return {
    text: normalizeText(result.text),
    pages: Number(result.numpages || 0)
  };
}

async function convertPdfWithDocling(filePath, options = {}) {
  reportProgress(options, { phase: "convert", message: `Docling: ${path.basename(filePath)}` });
  const cacheKey = await fileCacheKey(filePath, "docling");
  const outputDir = path.join(DOCLING_CACHE_DIR, cacheKey);
  await fs.rm(outputDir, { recursive: true, force: true });
  await fs.mkdir(outputDir, { recursive: true });

  await execFileAsync(DOCLING_COMMAND, [
    "convert",
    filePath,
    "--to",
    "markdown",
    "--output",
    outputDir
  ], {
    timeout: DOCLING_TIMEOUT_SECONDS * 1000,
    windowsHide: true,
    maxBuffer: 20 * 1024 * 1024
  });

  const markdownFiles = await collectMarkdownFiles(outputDir);
  if (!markdownFiles.length) throw new Error("Docling did not produce a Markdown file");

  const candidates = await Promise.all(markdownFiles.map(async (markdownPath) => ({
    markdownPath,
    stat: await fs.stat(markdownPath)
  })));
  candidates.sort((left, right) => right.stat.size - left.stat.size);
  const markdown = normalizeText(await fs.readFile(candidates[0].markdownPath, "utf8"));
  return {
    markdown,
    recognition: recognitionReport("docling", markdown, {
      doclingEnabled: true,
      doclingCommand: DOCLING_COMMAND,
      doclingOutput: candidates[0].markdownPath
    })
  };
}

async function convertPdfWithOcrmypdf(filePath, options = {}) {
  reportProgress(options, { phase: "ocr", message: `OCRmyPDF: ${path.basename(filePath)}` });
  await fs.mkdir(OCRMYPDF_CACHE_DIR, { recursive: true });
  const cacheKey = await fileCacheKey(filePath, "ocrmypdf");
  const outputPath = path.join(OCRMYPDF_CACHE_DIR, `${cacheKey}.pdf`);

  if (options.refreshRecognitionCache) {
    await fs.rm(outputPath, { force: true }).catch(() => {});
  }

  try {
    await fs.access(outputPath);
  } catch {
    await execFileAsync(OCRMYPDF_COMMAND, [
      "-l",
      OCR_LANGS,
      "--skip-text",
      filePath,
      outputPath
    ], {
      timeout: OCRMYPDF_TIMEOUT_SECONDS * 1000,
      windowsHide: true,
      maxBuffer: 20 * 1024 * 1024
    });
  }

  const extracted = await extractPdfText(outputPath);
  return {
    markdown: extracted.text,
    recognition: recognitionReport("ocrmypdf", extracted.text, {
      ocrmypdfEnabled: true,
      ocrmypdfCommand: OCRMYPDF_COMMAND,
      ocrLangs: OCR_LANGS,
      pdfPages: extracted.pages,
      ocrmypdfOutput: outputPath
    })
  };
}

async function getOcrWorker(options = {}) {
  if (!ocrWorkerPromise) {
    reportProgress(options, { phase: "ocr", message: "OCR: loading recognition model" });
    await fs.mkdir(OCR_CACHE_DIR, { recursive: true });
    ocrWorkerPromise = createWorker(OCR_LANGS, 1, { cachePath: OCR_CACHE_DIR });
  }
  return ocrWorkerPromise;
}

function columnName(index) {
  let value = index;
  let name = "";
  while (value > 0) {
    const remainder = (value - 1) % 26;
    name = String.fromCharCode(65 + remainder) + name;
    value = Math.floor((value - 1) / 26);
  }
  return name || "A";
}

function cleanCellText(value) {
  return String(value ?? "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function cellValueToText(cell) {
  const value = cell.value;
  if (value == null) return "";
  if (value instanceof Date) return value.toISOString().slice(0, 10);

  if (typeof value === "object") {
    if (Array.isArray(value.richText)) {
      return cleanCellText(value.richText.map((part) => part.text || "").join(""));
    }
    if (value.result != null) return cleanCellText(value.result);
    if (value.text != null) return cleanCellText(value.text);
    if (value.hyperlink && cell.text) return cleanCellText(cell.text);
  }

  return cleanCellText(cell.text || value);
}

function escapeMarkdownCell(value) {
  return String(value || "")
    .replaceAll("|", "\\|")
    .replace(/\n/g, "<br>");
}

function rowsToMarkdownTable(rows, maxCol) {
  const headers = ["Строка", ...Array.from({ length: maxCol }, (_, index) => columnName(index + 1))];
  const lines = [
    `| ${headers.join(" | ")} |`,
    `| ${headers.map(() => "---").join(" | ")} |`
  ];

  for (const row of rows) {
    const values = [String(row.number)];
    for (let col = 1; col <= maxCol; col += 1) {
      values.push(escapeMarkdownCell(row.cells.get(col) || ""));
    }
    lines.push(`| ${values.join(" | ")} |`);
  }

  return lines.join("\n");
}

async function convertXlsxToMarkdown(filePath) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(filePath);

  const parts = [];
  for (const worksheet of workbook.worksheets) {
    const rows = [];
    let maxCol = 0;

    worksheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
      const cells = new Map();
      row.eachCell({ includeEmpty: false }, (cell, colNumber) => {
        const text = cellValueToText(cell);
        if (!text) return;
        cells.set(colNumber, text.slice(0, 2000));
        maxCol = Math.max(maxCol, colNumber);
      });
      if (cells.size) rows.push({ number: rowNumber, cells });
    });

    if (!rows.length) continue;
    parts.push(`## Лист: ${worksheet.name}\n\n${rowsToMarkdownTable(rows, Math.min(maxCol, 80))}`);
  }

  return normalizeText(parts.join("\n\n"));
}

function xlsCellToText(cell) {
  if (!cell || cell.v === undefined || cell.v === null) return "";
  if (cell.w) return String(cell.w).trim();
  if (cell.v instanceof Date) return cell.v.toISOString().slice(0, 10);
  return String(cell.v).trim();
}

async function convertXlsToMarkdown(filePath) {
  const buffer = await fs.readFile(filePath);
  const workbook = XLSX.read(buffer, { type: "buffer", cellDates: true });
  const parts = [];

  for (const sheetName of workbook.SheetNames || []) {
    const worksheet = workbook.Sheets[sheetName];
    if (!worksheet?.["!ref"]) continue;

    const range = XLSX.utils.decode_range(worksheet["!ref"]);
    const rows = [];
    let maxCol = 0;

    for (let rowIndex = range.s.r; rowIndex <= range.e.r; rowIndex += 1) {
      const cells = new Map();
      for (let colIndex = range.s.c; colIndex <= range.e.c; colIndex += 1) {
        const cell = worksheet[XLSX.utils.encode_cell({ r: rowIndex, c: colIndex })];
        const text = xlsCellToText(cell);
        if (!text) continue;
        const colNumber = colIndex + 1;
        cells.set(colNumber, text.slice(0, 2000));
        maxCol = Math.max(maxCol, colNumber);
      }
      if (cells.size) rows.push({ number: rowIndex + 1, cells });
    }

    if (!rows.length) continue;
    parts.push(`## Лист: ${sheetName}\n\n${rowsToMarkdownTable(rows, Math.min(maxCol, 80))}`);
  }

  return normalizeText(parts.join("\n\n"));
}

async function ocrPdfToMarkdown(filePath, options = {}) {
  if (!OCR_ENABLED) {
    return {
      markdown: "",
      recognition: {
        ocrEnabled: false,
        ocrLangs: OCR_LANGS,
        ocrPages: 0,
        ocrRecognizedPages: 0,
        ocrCachedPages: 0,
        ocrNewPages: 0,
        ocrLimited: false
      }
    };
  }

  const document = await pdf(filePath, { scale: OCR_SCALE });
  try {
    const totalPages = Number(document.length || 0);
    const pageLimit = OCR_MAX_PAGES > 0 ? Math.min(totalPages, OCR_MAX_PAGES) : totalPages;
    const cacheKey = await fileCacheKey(filePath, `ocr-pages:${OCR_SCALE}`);
    const pageCacheDir = path.join(OCR_CACHE_DIR, "pages", cacheKey);
    await fs.mkdir(pageCacheDir, { recursive: true });
    let worker = null;
    const parts = [];
    const pages = [];

    for (let pageNumber = 1; pageNumber <= pageLimit; pageNumber += 1) {
      const pageCachePath = path.join(pageCacheDir, `${pageNumber}.json`);
      let cachedPage = null;
      try {
        cachedPage = JSON.parse(await fs.readFile(pageCachePath, "utf8"));
      } catch {
        cachedPage = null;
      }

      reportProgress(options, {
        phase: "ocr",
        message: `OCR: ${path.basename(filePath)} (${pageNumber}/${pageLimit})`,
        ocrPage: pageNumber,
        ocrPages: pageLimit,
        ocrTotalPages: totalPages
      });

      const hasCachedPage = Boolean(cachedPage) && Object.prototype.hasOwnProperty.call(cachedPage, "text");
      const useCachedPage = hasCachedPage && !options.refreshRecognitionCache;
      let text = useCachedPage ? normalizeText(cachedPage.text || "") : "";
      let confidence = useCachedPage ? Number(cachedPage.confidence) : Number.NaN;
      let cached = useCachedPage;

      if (!useCachedPage) {
        worker ||= await getOcrWorker(options);
        const image = await document.getPage(pageNumber);
        const result = await worker.recognize(image);
        text = normalizeText(result?.data?.text || "");
        confidence = Number(result?.data?.confidence);
        cached = false;
        await fs.writeFile(pageCachePath, JSON.stringify({
          page: pageNumber,
          text,
          confidence: Number.isFinite(confidence) ? Math.round(confidence) : null,
          recognizedAt: new Date().toISOString()
        }, null, 2), "utf8").catch(() => {});
      }

      const pageReport = { ...ocrPageReport(pageNumber, text, confidence), cached };
      pageReport.usable = usableOcrPage(pageReport);
      pages.push(pageReport);
      if (text && pageReport.usable) parts.push(`## OCR page ${pageNumber}\n\n${text}`);
    }

    if (totalPages > pageLimit) {
      parts.push(`## OCR status\n\nRecognized ${pageLimit} of ${totalPages} pages. Set RAG_OCR_MAX_PAGES=0 to OCR all pages. Cached page OCR is reused on force reindex.`);
    }

    const acceptedPages = pages.filter((page) => page.usable && page.chars > 0);
    const rejectedPages = pages.filter((page) => !page.usable && page.chars > 0);
    const markdown = normalizeText(parts.join("\n\n"));
    return {
      markdown,
      recognition: {
        ocrEnabled: true,
        ocrLangs: OCR_LANGS,
        ocrPages: pageLimit,
        ocrTotalPages: totalPages,
        ocrRecognizedPages: acceptedPages.length,
        ocrRawRecognizedPages: pages.filter((page) => page.chars > 0).length,
        ocrAcceptedPages: acceptedPages.length,
        ocrRejectedPages: rejectedPages.map((page) => page.page),
        ocrCachedPages: pages.filter((page) => page.cached).length,
        ocrNewPages: pages.filter((page) => !page.cached).length,
        ocrLimited: totalPages > pageLimit,
        ocrConfidence: average(pages.map((page) => page.confidence)),
        ocrConfidenceP10: percentile(pages.map((page) => page.confidence), 0.1),
        ocrChars: acceptedPages.reduce((sum, page) => sum + page.chars, 0),
        ocrRawChars: pages.reduce((sum, page) => sum + page.chars, 0),
        ocrLowConfidencePages: pages
          .filter((page) => Number.isFinite(Number(page.confidence)) && Number(page.confidence) < 50)
          .map((page) => page.page),
        ocrEmptyPages: pages
          .filter((page) => page.chars < 20)
          .map((page) => page.page),
        ocrPageStats: pages
      }
    };
  } finally {
    if (typeof document.destroy === "function") await document.destroy();
  }
}

function pdfTextResult(text, pdfPages, externalError) {
  const quality = textQualityReport(text);
  return {
    markdown: text,
    recognition: recognitionReport("pdf-text", text, {
      pdfOcrMode: PDF_OCR_MODE,
      pdfPages,
      textLayerChars: text.length,
      textLayerQuality: quality,
      ocrPages: 0,
      ocrTotalPages: pdfPages,
      ocrLimited: false,
      externalConverterError: externalError
    })
  };
}

function pdfOcrResult(method, textLayerText, ocrMarkdown, ocrRecognition, externalError) {
  const markdown = normalizeText(ocrMarkdown);
  const { method: _method, chars: _chars, ...recognition } = ocrRecognition || {};
  const pageCount = Number(recognition.ocrTotalPages || recognition.pdfPages || 0);
  return {
    markdown,
    recognition: recognitionReport(markdown ? method : "pdf-empty", markdown || textLayerText, {
      pdfOcrMode: PDF_OCR_MODE,
      textLayerChars: textLayerText.length,
      textLayerQuality: textQualityReport(textLayerText),
      ocrQuality: textQualityReport(markdown),
      ...recognition,
      pdfPages: pageCount,
      ocrPages: Number(recognition.ocrPages || 0) || (method === "ocrmypdf" ? pageCount : recognition.ocrPages),
      ocrTotalPages: Number(recognition.ocrTotalPages || 0) || pageCount,
      externalConverterError: externalError
    })
  };
}

function severeRecognitionNoise(report) {
  return report?.warnings?.includes("ocr_text_noise") || report?.warnings?.includes("encoding_noise");
}

function choosePdfResult(textResult, ocrResult) {
  const textQuality = textResult.recognition.textLayerQuality || textQualityReport(textResult.markdown);
  const ocrQuality = ocrResult.recognition.ocrQuality || textQualityReport(ocrResult.markdown);
  const ocrHasText = Boolean(String(ocrResult.markdown || "").trim());
  const textHasText = Boolean(String(textResult.markdown || "").trim());
  const textHasSevereNoise = severeRecognitionNoise(textQuality);
  const useOcr = PDF_OCR_MODE === "force"
    ? (ocrHasText || !textHasText || textHasSevereNoise)
    : (!textHasText && !ocrHasText) || (ocrHasText && (
      !usablePdfTextLayer(textQuality)
      || Number(ocrQuality.score || 0) > Number(textQuality.score || 0) + 10
    )) || (!ocrHasText && textHasSevereNoise);
  const selected = useOcr ? ocrResult : textResult;

  return {
    ...selected,
    recognition: {
      ...selected.recognition,
      pdfOcrMode: PDF_OCR_MODE,
      selectedPdfText: useOcr ? "ocr" : "text-layer",
      textLayerQuality: textQuality,
      ocrQuality
    }
  };
}

async function runPdfOcr(filePath, text, options, externalError) {
  if (OCRMYPDF_ENABLED || PDF_CONVERTER === "auto" || PDF_CONVERTER === "ocrmypdf") {
    try {
      const ocrmypdf = await convertPdfWithOcrmypdf(filePath, options);
      if (ocrmypdf.markdown.length >= Math.max(PDF_TEXT_MIN_CHARS, text.length) || PDF_CONVERTER === "ocrmypdf" || PDF_OCR_MODE !== "auto") {
        return {
          result: pdfOcrResult("ocrmypdf", text, ocrmypdf.markdown, ocrmypdf.recognition, externalError),
          externalError
        };
      }
    } catch (error) {
      const message = `OCRmyPDF: ${commandErrorMessage(error)}`;
      const nextExternalError = externalError ? `${externalError}\n${message}` : message;
      if (PDF_CONVERTER === "ocrmypdf") throw new Error(message);
      externalError = nextExternalError;
    }
  }

  const ocr = await ocrPdfToMarkdown(filePath, options);
  return {
    result: pdfOcrResult("ocr", text, ocr.markdown, ocr.recognition, externalError),
    externalError
  };
}

async function convertPdfToMarkdownWithReport(filePath, options = {}) {
  let externalError = "";
  if (DOCLING_ENABLED || PDF_CONVERTER === "auto") {
    try {
      const docling = await convertPdfWithDocling(filePath, options);
      if (docling.markdown.length >= PDF_TEXT_MIN_CHARS || PDF_CONVERTER === "docling") return docling;
    } catch (error) {
      externalError = `Docling: ${commandErrorMessage(error)}`;
      if (PDF_CONVERTER === "docling") throw new Error(externalError);
    }
  }

  const extracted = await extractPdfText(filePath);
  const text = extracted.text;
  const pdfPages = extracted.pages;
  const textResult = pdfTextResult(text, pdfPages, externalError);

  if (PDF_OCR_MODE === "auto" && usablePdfTextLayer(textResult.recognition.textLayerQuality)) {
    return textResult;
  }

  const ocr = await runPdfOcr(filePath, text, options, externalError);
  return choosePdfResult(textResult, ocr.result);
}

export async function convertToMarkdownWithReport(filePath, options = {}) {
  const ext = path.extname(filePath).toLowerCase();

  if (TEXT_EXTENSIONS.has(ext)) {
    const buffer = await fs.readFile(filePath);
    const utf8 = buffer.toString("utf8");
    const decoded = utf8.includes("\uFFFD") ? iconv.decode(buffer, "win1251") : utf8;
    const markdown = normalizeText(decoded);
    return { markdown, recognition: recognitionReport("text", markdown) };
  }

  if (ext === ".docx") {
    const result = await mammoth.extractRawText({ path: filePath });
    const markdown = normalizeText(result.value);
    return { markdown, recognition: recognitionReport("docx", markdown) };
  }

  if (ext === ".xlsx" || ext === ".xlsm") {
    const markdown = await convertXlsxToMarkdown(filePath);
    return { markdown, recognition: recognitionReport(ext.slice(1), markdown) };
  }

  if (ext === ".xls") {
    const markdown = await convertXlsToMarkdown(filePath);
    return { markdown, recognition: recognitionReport("xls", markdown) };
  }

  if (ext === ".pdf") {
    return convertPdfToMarkdownWithReport(filePath, options);
  }

  throw new Error(`Unsupported file type: ${ext}`);
}

export async function convertToMarkdown(filePath, options = {}) {
  const result = await convertToMarkdownWithReport(filePath, options);
  return result.markdown;
}

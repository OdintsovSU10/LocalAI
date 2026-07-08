import path from "node:path";
import { isTenderSource, normalizeSourceType } from "./source-scope.js";

export const TENDER_RECOGNITION_VERSION = 1;

const MAX_TEXT_SAMPLE = 20000;

const COMMERCIAL_PROPOSAL_PATTERNS = [
  { id: "kp_ru", pattern: /(?:^|[^\p{L}\p{N}])кп(?:[^\p{L}\p{N}]|$)/iu },
  { id: "commercial_proposal_ru", pattern: /коммерческ\p{L}{0,20}\s+предложен\p{L}{0,20}/iu },
  { id: "quotation_en", pattern: /\b(?:quote|quotation|commercial\s+proposal|proposal|offer)\b/i }
];

const PRICE_PATTERNS = [
  { id: "price_ru", pattern: /(?:^|[^\p{L}\p{N}])(?:цена|стоимость|расценк\p{L}*|сумма|итого|ндс)(?:[^\p{L}\p{N}]|$)/iu },
  { id: "currency_ru", pattern: /(?:₽|(?:^|[^\p{L}\p{N}])руб\.?|(?:^|[^\p{L}\p{N}])рубл\p{L}*)/iu },
  { id: "number_currency", pattern: /\b\d[\d\s.,]*(?:₽|руб\.?|рубл\p{L}*)/iu }
];

const ESTIMATE_PATTERNS = [
  { id: "estimate_ru", pattern: /(?:^|[^\p{L}\p{N}])(?:смета|сметн\p{L}*|локальн\p{L}*\s+смет\p{L}*)(?:[^\p{L}\p{N}]|$)/iu },
  { id: "ks_forms", pattern: /\bкс\s*-?\s*(?:2|3)\b/iu }
];

const TENDER_DOC_PATTERNS = [
  { id: "tender_docs_ru", pattern: /(?:тендерн\p{L}*\s+документац\p{L}*|документац\p{L}*\s+закупк\p{L}*)/iu },
  { id: "technical_task_ru", pattern: /(?:техническ\p{L}*\s+задан\p{L}*|(?:^|[^\p{L}\p{N}])тз(?:[^\p{L}\p{N}]|$))/iu },
  { id: "specification_ru", pattern: /(?:^|[^\p{L}\p{N}])(?:спецификац\p{L}*|ведомост\p{L}*\s+объем\p{L}*)(?:[^\p{L}\p{N}]|$)/iu }
];

function normalizeText(value = "") {
  return String(value || "")
    .replaceAll("ё", "е")
    .replaceAll("Ё", "Е")
    .replace(/\s+/g, " ")
    .trim();
}

function textSample(markdown = "") {
  return normalizeText(markdown).slice(0, MAX_TEXT_SAMPLE);
}

function pathSample({ source = {}, filePath = "", relativePath = "" } = {}) {
  return normalizeText([
    source.title || "",
    source.path || "",
    relativePath || "",
    filePath || "",
    path.basename(String(filePath || ""))
  ].join(" "));
}

function matchedSignals(patterns, text) {
  return patterns
    .filter((item) => item.pattern.test(text))
    .map((item) => item.id);
}

function chooseDocumentType({ commercialSignals, priceSignals, estimateSignals, tenderDocSignals }) {
  if (commercialSignals.length) return "commercial_proposal";
  if (estimateSignals.length) return "cost_estimate";
  if (tenderDocSignals.length) return "tender_document";
  if (priceSignals.length) return "price_table";
  return "tender_file";
}

function confidenceScore({ commercialSignals, priceSignals, estimateSignals, tenderDocSignals }) {
  const score = 10
    + commercialSignals.length * 35
    + priceSignals.length * 10
    + estimateSignals.length * 12
    + tenderDocSignals.length * 8;
  return Math.max(0, Math.min(100, score));
}

export function recognizeTenderDocument({ source = {}, filePath = "", relativePath = "", markdown = "" } = {}) {
  const sourceType = normalizeSourceType(source);
  const pathText = pathSample({ source, filePath, relativePath });
  const contentText = textSample(markdown);
  const text = `${pathText}\n${contentText}`;

  if (!isTenderSource(source)) {
    return {
      version: TENDER_RECOGNITION_VERSION,
      sourceType,
      relativePath: relativePath || "",
      documentType: "",
      isCommercialProposal: false,
      hasPriceSignals: false,
      signalScore: 0,
      signals: []
    };
  }

  const commercialSignals = matchedSignals(COMMERCIAL_PROPOSAL_PATTERNS, text);
  const priceSignals = matchedSignals(PRICE_PATTERNS, text);
  const estimateSignals = matchedSignals(ESTIMATE_PATTERNS, text);
  const tenderDocSignals = matchedSignals(TENDER_DOC_PATTERNS, text);
  const signals = [...new Set([
    ...commercialSignals,
    ...priceSignals,
    ...estimateSignals,
    ...tenderDocSignals
  ])];
  const documentType = chooseDocumentType({ commercialSignals, priceSignals, estimateSignals, tenderDocSignals });

  return {
    version: TENDER_RECOGNITION_VERSION,
    sourceType,
    tenderSourceId: source.id || "",
    tenderTitle: source.title || "",
    tenderCategory: source.tenderCategory || "",
    linkedContractId: source.linkedContractId || "",
    relativePath: relativePath || "",
    documentType,
    isCommercialProposal: documentType === "commercial_proposal",
    hasPriceSignals: priceSignals.length > 0,
    hasEstimateSignals: estimateSignals.length > 0,
    hasTenderDocSignals: tenderDocSignals.length > 0,
    signalScore: confidenceScore({ commercialSignals, priceSignals, estimateSignals, tenderDocSignals }),
    signals
  };
}

export function tenderChunkMetadata(recognition = {}) {
  const metadata = {
    sourceType: recognition.sourceType || "contract",
    relativePath: recognition.relativePath || ""
  };

  if (recognition.sourceType !== "tender") return metadata;

  return {
    ...metadata,
    tenderSourceId: recognition.tenderSourceId || "",
    tenderTitle: recognition.tenderTitle || "",
    tenderCategory: recognition.tenderCategory || "",
    linkedContractId: recognition.linkedContractId || "",
    tenderDocumentType: recognition.documentType || "tender_file",
    tenderCommercialProposal: Boolean(recognition.isCommercialProposal),
    tenderHasPriceSignals: Boolean(recognition.hasPriceSignals),
    tenderHasEstimateSignals: Boolean(recognition.hasEstimateSignals),
    tenderHasTenderDocSignals: Boolean(recognition.hasTenderDocSignals),
    tenderSignalScore: Number(recognition.signalScore || 0),
    tenderSignals: Array.isArray(recognition.signals) ? recognition.signals : []
  };
}

import { isoDate } from "./document-classifier.js";
import { sha1 } from "./evidence-spans.js";

// Deterministic starter extraction for construction contracts. Every fact is tied to the span it was read
// from; values the rules cannot read unambiguously are simply not extracted (no guessing).
export const EXTRACTION_METHOD = "rules";
export const EXTRACTION_VERSION = "rules/1";

export const FACT_TYPES = [
  "party_customer",
  "party_contractor",
  "contract_price",
  "vat_rate",
  "advance_percent",
  "advance_term",
  "retention_percent",
  "retention_return_term",
  "warranty_period",
  "work_start_date",
  "work_end_date",
  "penalty_rate",
  "estimate_total"
];

const DECIMAL = "(\\d+(?:[.,]\\d+)?)";
// The advance term is read only from the clause that sets the advance size; otherwise a later clause
// such as "offset of the advance ... within 30 days" would be misread as a second advance term.
const ADVANCE_SIZE = /аванс\p{L}*[^.%]{0,40}?(?:в\s+размере|составляет)\s+\d/iu;
const AMOUNT = "(\\d{1,3}(?:[ \\u00a0]\\d{3})+(?:[.,]\\d{1,2})?|\\d+(?:[.,]\\d{1,2})?)";
const ORGANIZATION = "((?:ООО|АО|ПАО|ЗАО|ТОО|ИП)\\s*«[^»]+»)";

function toNumber(value) {
  return Number(String(value || "").replace(/[  ]/g, "").replace(",", "."));
}

function currencyOf(text) {
  if (/тенге|₸|\bKZT\b/iu.test(text)) return "KZT";
  if (/руб|₽|\bRUB\b/iu.test(text)) return "RUB";
  return "";
}

function dayTerm(text) {
  const match = text.match(/в\s+течение\s+(\d+)\s+(рабочих|календарных|банковских)?\s*(?:дн\p{L}*)([^.;]*)/iu);
  if (!match) return null;
  return {
    raw: match[0].trim(),
    normalized: { days: Number(match[1]), dayKind: (match[2] || "").toLowerCase() || "unspecified" },
    condition: match[3].trim()
  };
}

function periodMonths(amount, unit) {
  return /^(?:лет|год)/iu.test(unit) ? Number(amount) * 12 : Number(amount);
}

// Each rule reads one fact type from a paragraph; `text` is the clause body (amendment quotes unwrapped).
const PARAGRAPH_RULES = [
  {
    type: "party_customer",
    read: (text) => {
      const match = text.match(new RegExp(`Заказчик\\s*:\\s*${ORGANIZATION}`, "u"));
      return match ? { raw: match[0], normalized: { name: match[1] } } : null;
    }
  },
  {
    type: "party_contractor",
    read: (text) => {
      const match = text.match(new RegExp(`(?:Генподрядчик|Подрядчик)\\s*:\\s*${ORGANIZATION}`, "u"));
      return match ? { raw: match[0], normalized: { name: match[1] } } : null;
    }
  },
  {
    type: "contract_price",
    read: (text) => {
      const match = text.match(new RegExp(`цена\\s+договора\\s+составляет\\s+${AMOUNT}`, "iu"));
      if (!match) return null;
      const sentence = text.slice(match.index).split(/[.;](?:\s|$)/)[0];
      return { raw: match[0], normalized: { amount: toNumber(match[1]), currency: currencyOf(sentence) }, unit: currencyOf(sentence) };
    }
  },
  {
    type: "vat_rate",
    read: (text) => {
      const match = text.match(new RegExp(`НДС\\s*${DECIMAL}\\s*%`, "iu"));
      return match ? { raw: match[0], normalized: { percent: toNumber(match[1]) }, unit: "%" } : null;
    }
  },
  {
    type: "advance_percent",
    read: (text) => {
      const match = text.match(new RegExp(`аванс\\p{L}*[^.%]{0,40}?(?:в\\s+размере|составляет)\\s+${DECIMAL}\\s*%`, "iu"));
      return match ? { raw: match[0], normalized: { percent: toNumber(match[1]) }, unit: "%" } : null;
    }
  },
  {
    type: "advance_term",
    read: (text) => {
      if (!ADVANCE_SIZE.test(text)) return null;
      const term = dayTerm(text);
      return term ? { ...term, unit: "days" } : null;
    }
  },
  {
    type: "retention_percent",
    read: (text) => {
      const match = text.match(new RegExp(`гарантийн\\p{L}*\\s+удержани\\p{L}*[^.%]{0,60}?(?:в\\s+размере|составляет)\\s+${DECIMAL}\\s*%`, "iu"));
      return match ? { raw: match[0], normalized: { percent: toNumber(match[1]) }, unit: "%" } : null;
    }
  },
  {
    type: "retention_return_term",
    read: (text) => {
      if (!/гарантийн\p{L}*\s+удержани/iu.test(text) || !/возвра/iu.test(text)) return null;
      const term = dayTerm(text);
      return term ? { ...term, unit: "days" } : null;
    }
  },
  {
    type: "warranty_period",
    read: (text) => {
      const match = text.match(/гарантийный\s+срок[^.]{0,80}?составляет\s+(\d+)\s*(лет|года|год|месяц\p{L}*)/iu);
      return match ? { raw: match[0], normalized: { months: periodMonths(match[1], match[2]) }, unit: "months" } : null;
    }
  },
  {
    type: "work_start_date",
    read: (text) => {
      const match = text.match(/начало\s+(?:выполнения\s+)?работ\s*:\s*(\d{2}\.\d{2}\.\d{4})/iu);
      return match ? { raw: match[0], normalized: { date: isoDate(match[1]) }, unit: "date" } : null;
    }
  },
  {
    type: "work_end_date",
    read: (text) => {
      const match = text.match(/окончание\s+(?:выполнения\s+)?работ\s*:\s*(\d{2}\.\d{2}\.\d{4})/iu);
      return match ? { raw: match[0], normalized: { date: isoDate(match[1]) }, unit: "date" } : null;
    }
  },
  {
    type: "penalty_rate",
    read: (text) => {
      const match = text.match(new RegExp(`неустойк\\p{L}*\\s+в\\s+размере\\s+${DECIMAL}\\s*%`, "iu"));
      if (!match) return null;
      const cap = text.slice(match.index).match(new RegExp(`не\\s+более\\s+${DECIMAL}\\s*%`, "iu"));
      return {
        raw: match[0],
        normalized: { percent: toNumber(match[1]), ...(cap ? { capPercent: toNumber(cap[1]) } : {}) },
        unit: "%"
      };
    }
  }
];

const AMENDING_CLAUSE = /пункт\p{L}*\s+(\d+(?:\.\d+)*)\s+договора\s+изложить\s+в\s+новой\s+редакции\s*:?\s*(?:«([\s\S]*)»)?/iu;
const CLAUSE_NUMBER = /^(\d+(?:\.\d+)+)\.?\s/;

function clauseContext(span) {
  const amending = span.text.match(AMENDING_CLAUSE);
  if (amending) return { clauseRef: amending[1], amends: true, text: amending[2] || span.text };
  const clause = span.text.match(CLAUSE_NUMBER);
  return { clauseRef: clause?.[1] || "", amends: false, text: span.text };
}

function tableRowFact(span) {
  if (!/итого/iu.test(span.text)) return null;
  const cells = span.text.split("|").map((cell) => cell.trim()).filter(Boolean);
  const amountCell = [...cells].reverse().find((cell) => new RegExp(`^${AMOUNT}$`, "u").test(cell));
  if (!amountCell) return null;
  return { type: "estimate_total", raw: span.text.trim(), normalized: { amount: toNumber(amountCell), currency: currencyOf(span.text) }, unit: "" };
}

export function normalizedKey(normalized = {}) {
  return JSON.stringify(Object.keys(normalized).sort().map((key) => [key, normalized[key]]));
}

function makeFact(document, span, context, found) {
  const normalizedJson = normalizedKey(found.normalized);
  return {
    factId: `fact_${sha1(`${document.documentId}|${found.type}|${span.evidenceId}|${normalizedJson}`).slice(0, 16)}`,
    documentId: document.documentId,
    sourceId: document.sourceId,
    factType: found.type,
    rawValue: String(found.raw || "").slice(0, 500),
    normalized: found.normalized,
    unit: found.unit || "",
    condition: found.condition || "",
    clauseRef: context.clauseRef,
    amends: context.amends,
    validFrom: document.documentDate || null,
    validTo: null,
    status: "active",
    supersedesFactId: null,
    supersededByFactId: null,
    extractionMethod: EXTRACTION_METHOD,
    extractionVersion: EXTRACTION_VERSION,
    evidenceIds: [span.evidenceId]
  };
}

// The same value of the same type read twice in one document becomes one fact with several evidence spans.
export function extractDocumentFacts(document, spans = []) {
  const byKey = new Map();
  const add = (span, context, found) => {
    if (!found) return;
    const key = `${found.type}|${normalizedKey(found.normalized)}`;
    const existing = byKey.get(key);
    if (existing) {
      if (!existing.evidenceIds.includes(span.evidenceId)) existing.evidenceIds.push(span.evidenceId);
      return;
    }
    byKey.set(key, makeFact(document, span, context, found));
  };

  for (const span of spans) {
    if (span.kind === "table_row") {
      add(span, { clauseRef: "", amends: false }, tableRowFact(span));
      continue;
    }
    const context = clauseContext(span);
    for (const rule of PARAGRAPH_RULES) {
      const found = rule.read(context.text);
      if (found) add(span, context, { type: rule.type, ...found });
    }
  }
  return [...byKey.values()];
}

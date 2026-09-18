// Deterministic quantity extraction for claim checks (Product V2, Stage 07): numbers with their unit
// class (percent, duration, currency, date), so "3%" can never be confirmed by "30 дней" or "3 года".

const MONTHS = ["январ", "феврал", "март", "апрел", "ма", "июн", "июл", "август", "сентябр", "октябр", "ноябр", "декабр"];
const MONTH_NAME = "января|февраля|марта|апреля|мая|июня|июля|августа|сентября|октября|ноября|декабря";

const NUMBER = String.raw`\d{1,3}(?:[ \u00a0\u202f]\d{3})+(?:[.,]\d+)?|\d+(?:[.,]\d+)?`;
// Not a quantity: part of a code or name (B30, КС-2, 15-П, W8) or a reference (п. 3.1, № 2, статья 719).
const NOT_AFTER = String.raw`(?<![\p{L}\d.,/\-])`;
// Whole words only: "НДС 20%" is a percentage, not a reference to "ДС".
const REFERENCE_BEFORE = /(?:(?<![\p{L}])(?:п\.|пп\.|пункт\p{L}*|N|ст\.|стать\p{L}*|раздел\p{L}*|глав\p{L}*|приложени\p{L}*|абзац\p{L}*|дс|акт\p{L}*)|№)\s*$/iu;
// A parenthetical between the number and its unit: "245 000 000 (двести сорок пять миллионов) рублей".
const PARENTHETICAL = String.raw`(?:\s*\([^)]{0,120}\))?`;

const UNIT_RULES = [
  ["percent", /^\s*(?:%|процент)/iu],
  ["day", /^\s*(?:(?:календарн|рабоч|банковск)\p{L}*\s+)?(?:дн(?![\p{L}])|дн[яеи]\p{L}*|день|сут\p{L}*)/iu],
  ["week", /^\s*недел\p{L}*/iu],
  ["month", /^\s*(?:месяц\p{L}*|мес\.?(?![\p{L}]))/iu],
  ["year", /^\s*(?:год\p{L}*|лет(?![\p{L}])|г\.)/iu],
  ["currency", /^\s*(?:(?:тыс|млн|млрд)\.?\s*)?(?:руб\p{L}*|₽|р\.)/iu]
];

const MULTIPLIER = [[/^\s*тыс/iu, 1e3], [/^\s*млн/iu, 1e6], [/^\s*млрд/iu, 1e9]];
const DURATION_IN_MONTHS = { month: 1, year: 12 };

export const DURATION_UNITS = new Set(["day", "week", "month", "year"]);

function parseNumber(raw) {
  return Number(String(raw).replace(/[ \u00a0\u202f]/g, "").replace(",", "."));
}

function isoDate(day, month, year) {
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/**
 * @returns {Array<{ unit: string, value: number|string, raw: string, index: number }>}
 * unit: percent | day | week | month | year | currency | date | calendar_year | fraction | number
 */
export function extractQuantities(text = "") {
  const source = String(text || "");
  const quantities = [];
  const taken = [];
  const overlaps = (start, end) => taken.some(([from, to]) => start < to && end > from);
  const take = (start, end, quantity) => {
    taken.push([start, end]);
    quantities.push({ ...quantity, index: start });
  };

  for (const match of source.matchAll(/(?<!\d)(\d{2})\.(\d{2})\.(\d{4})(?!\d)/g)) {
    take(match.index, match.index + match[0].length, { unit: "date", value: isoDate(match[1], match[2], match[3]), raw: match[0] });
  }
  for (const match of source.matchAll(new RegExp(`(?<!\\d)(\\d{1,2})\\s+(${MONTH_NAME})\\s+(\\d{4})`, "giu"))) {
    const month = MONTHS.findIndex((stem) => match[2].toLowerCase().startsWith(stem)) + 1;
    if (month > 0) take(match.index, match.index + match[0].length, { unit: "date", value: isoDate(match[1], month, match[3]), raw: match[0] });
  }
  for (const match of source.matchAll(/(?<![\d/])(\d+)\s*\/\s*(\d+)(?![\d/])/g)) {
    if (overlaps(match.index, match.index + match[0].length)) continue;
    take(match.index, match.index + match[0].length, { unit: "fraction", value: `${match[1]}/${match[2]}`, raw: match[0] });
  }

  for (const match of source.matchAll(new RegExp(`${NOT_AFTER}(${NUMBER})(?![\\p{L}\\d]|-\\p{L})`, "gu"))) {
    const start = match.index;
    const end = start + match[0].length;
    if (overlaps(start, end)) continue;
    if (REFERENCE_BEFORE.test(source.slice(Math.max(0, start - 14), start))) continue;
    let value = parseNumber(match[1]);
    const rest = source.slice(end).replace(new RegExp(`^${PARENTHETICAL}`, "u"), "");
    const [unit = "number"] = UNIT_RULES.find(([, pattern]) => pattern.test(rest)) || [];
    if (unit === "currency") {
      const multiplier = MULTIPLIER.find(([pattern]) => pattern.test(rest));
      if (multiplier) value *= multiplier[1];
    }
    if (unit === "year" && Number.isInteger(value) && value >= 1900 && value <= 2100) {
      take(start, end, { unit: "calendar_year", value, raw: match[0] });
      continue;
    }
    take(start, end, { unit, value, raw: match[0] });
  }
  return quantities.sort((left, right) => left.index - right.index);
}

function sameNumber(left, right) {
  return Math.abs(Number(left) - Number(right)) < 1e-9;
}

function durationMonths(quantity) {
  const factor = DURATION_IN_MONTHS[quantity.unit];
  return factor ? Number(quantity.value) * factor : null;
}

// true when the evidence quantity states the same thing as the claim quantity (value and unit class).
function supports(claim, evidence) {
  if (claim.unit === "date") return evidence.unit === "date" && evidence.value === claim.value;
  if (claim.unit === "calendar_year") {
    return (evidence.unit === "calendar_year" && sameNumber(evidence.value, claim.value))
      || (evidence.unit === "date" && evidence.value.startsWith(`${claim.value}-`));
  }
  if (claim.unit === "fraction") return evidence.unit === "fraction" && evidence.value === claim.value;
  if (claim.unit === "number") return typeof evidence.value === "number" && sameNumber(evidence.value, claim.value);
  if (claim.unit === "currency") {
    // Spreadsheet rows carry amounts without a currency word ("| Итого по смете | 244 800 000 |").
    return (evidence.unit === "currency" || (evidence.unit === "number" && Number(claim.value) >= 1000))
      && sameNumber(evidence.value, claim.value);
  }
  if (evidence.unit === claim.unit) return sameNumber(evidence.value, claim.value);
  const claimMonths = durationMonths(claim);
  const evidenceMonths = durationMonths(evidence);
  return claimMonths !== null && evidenceMonths !== null && sameNumber(claimMonths, evidenceMonths);
}

/**
 * Compares every quantity of a claim with the quantities of its cited evidence.
 * @returns {Array<{ quantity, status: "ok" | "unit_mismatch" | "missing" }>}
 */
export function compareQuantities(claimText, evidenceTexts = []) {
  const evidence = evidenceTexts.flatMap((text) => extractQuantities(text));
  return extractQuantities(claimText).map((quantity) => {
    if (evidence.some((item) => supports(quantity, item))) return { quantity, status: "ok" };
    const sameValue = typeof quantity.value === "number"
      && evidence.some((item) => typeof item.value === "number" && sameNumber(item.value, quantity.value));
    return { quantity, status: sameValue ? "unit_mismatch" : "missing" };
  });
}

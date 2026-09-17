// Rule-based document classification for construction contract folders. Unknown stays "other":
// the version graph never assumes a legal relation that the text does not state.

export const DOCUMENT_KINDS = ["contract", "amendment", "appendix", "estimate", "act", "letter", "other"];

const NUMBER = "([A-Za-zА-Яа-яЁё0-9][A-Za-zА-Яа-яЁё0-9\\-/.]*?)";
const DATE = "(\\d{2}\\.\\d{2}\\.\\d{4})";

const AMENDMENT = new RegExp(`дополнительн\\p{L}*\\s+соглашени\\p{L}*\\s*№\\s*${NUMBER}(?:\\s+от\\s+${DATE})?(?=[\\s,.]|$)`, "iu");
const APPENDIX = new RegExp(`^приложени\\p{L}*\\s*№\\s*${NUMBER}(?:\\s+от\\s+${DATE})?(?=[\\s,.]|$)`, "iu");
const CONTRACT = new RegExp(`договор\\p{L}*[^№\\n]{0,60}№\\s*${NUMBER}(?:\\s+от\\s+${DATE})?(?=[\\s,.]|$)`, "iu");
const PARENT_CONTRACT = new RegExp(`к\\s+договор\\p{L}*[^№\\n]{0,60}№\\s*${NUMBER}(?:\\s+от\\s+${DATE})?(?=[\\s,.]|$)`, "iu");

export function isoDate(value = "") {
  const match = String(value || "").match(/^(\d{2})\.(\d{2})\.(\d{4})$/);
  return match ? `${match[3]}-${match[2]}-${match[1]}` : null;
}

export function normalizeDocumentNumber(value = "") {
  return String(value || "").trim().replace(/[.,;:]+$/, "").toLowerCase().replaceAll("ё", "е");
}

// Converter output starts with YAML front matter that holds the absolute source path; it never reaches evidence.
export function stripFrontMatter(markdown = "") {
  return String(markdown || "").replace(/^﻿?---\r?\n[\s\S]*?\r?\n---\r?\n/, "");
}

export function documentTitle(markdown = "", fileLabel = "") {
  const heading = String(markdown || "").match(/^\s{0,3}#\s+(.+?)\s*#*\s*$/m);
  return (heading?.[1] || fileLabel || "").trim();
}

function parentRef(text) {
  const match = text.match(PARENT_CONTRACT);
  return match ? { number: match[1], numberKey: normalizeDocumentNumber(match[1]), date: isoDate(match[2]) } : null;
}

export function classifyDocument({ markdown = "", fileLabel = "" } = {}) {
  const body = stripFrontMatter(markdown);
  const title = documentTitle(body, fileLabel);
  const head = body.slice(0, 1500);
  const titleOrHead = `${title}\n${head}`;

  const amendment = title.match(AMENDMENT);
  if (amendment) {
    return {
      kind: "amendment",
      title,
      number: amendment[1],
      documentDate: isoDate(amendment[2]),
      parentRef: parentRef(titleOrHead),
      method: "title:amendment"
    };
  }

  const appendix = title.match(APPENDIX);
  if (appendix) {
    return {
      kind: "appendix",
      title,
      number: appendix[1],
      documentDate: isoDate(appendix[2]),
      parentRef: parentRef(titleOrHead),
      method: "title:appendix"
    };
  }

  const contract = title.match(CONTRACT);
  if (contract && !/^\s*(?:письм|акт\b|исх)/iu.test(title)) {
    return { kind: "contract", title, number: contract[1], documentDate: isoDate(contract[2]), parentRef: null, method: "title:contract" };
  }

  if (/(?:^|\s)смет\p{L}*/iu.test(title) || /\.xlsx?$/i.test(title) || /^\s{0,3}#{1,6}\s+(?:Лист|sheet)\s*:/imu.test(head)) {
    return { kind: "estimate", title, number: "", documentDate: null, parentRef: null, method: "content:estimate" };
  }
  if (/(?:^|\s)акт\p{L}*\s|КС-2|КС-3/iu.test(title)) {
    return { kind: "act", title, number: "", documentDate: null, parentRef: parentRef(titleOrHead), method: "title:act" };
  }
  if (/исх\.\s*№/iu.test(head) || /(?:^|\s)письм\p{L}*/iu.test(title)) {
    const outgoing = head.match(new RegExp(`исх\\.\\s*№\\s*${NUMBER}(?:\\s+от\\s+${DATE})?(?=[\\s,.]|$)`, "iu"));
    return {
      kind: "letter",
      title,
      number: outgoing?.[1] || "",
      documentDate: isoDate(outgoing?.[2]),
      parentRef: parentRef(head),
      method: "content:letter"
    };
  }
  return { kind: "other", title, number: "", documentDate: null, parentRef: null, method: "none" };
}

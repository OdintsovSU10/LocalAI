import crypto from "node:crypto";

import { normalizeText } from "../text.js";
import { stripFrontMatter } from "./document-classifier.js";
import { redactEvidenceText } from "./evidence-redaction.js";

export const MAX_SPAN_CHARS = 2000;
const CHUNK_PROBE_CHARS = 120;

export function sha1(value) {
  return crypto.createHash("sha1").update(String(value)).digest("hex");
}

function headingText(line) {
  const match = String(line || "").match(/^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/);
  return match ? { level: match[1].length, text: match[2].trim() } : null;
}

function locationState(state, heading) {
  const page = heading.text.match(/^(?:OCR\s+)?page\s+(\d+)$/i);
  if (page) return { ...state, page: Number(page[1]) };
  const sheet = heading.text.match(/^(?:Лист|sheet)\s*:\s*(.+)$/iu);
  if (sheet) return { ...state, sheet: sheet[1].trim(), section: "" };
  return { ...state, section: heading.text };
}

function compact(text) {
  return String(text || "").replace(/\s+/g, " ").trim();
}

// Finds the index chunk that contains the span so a citation can open the exact preview fragment.
function chunkForSpan(chunks, spanText) {
  const probe = compact(spanText).slice(0, CHUNK_PROBE_CHARS);
  if (!probe) return null;
  return chunks.find((chunk) => compact(redactEvidenceText(chunk.text)).includes(probe)) || null;
}

/**
 * Splits a converted markdown document into evidence spans: one per paragraph, one per table row.
 * Each span carries its own section/page/sheet/row, independent of how the indexer grouped chunks.
 * Absolute paths and secret-like values in the text are masked before spans are cut.
 */
export function buildEvidenceSpans({ sourceId, fileId, documentId = fileId, markdown = "", chunks = [], recognition = {} }) {
  const body = normalizeText(redactEvidenceText(stripFrontMatter(markdown)));
  const fileChunks = chunks
    .filter((chunk) => chunk.fileId === fileId)
    .sort((left, right) => Number(left.chunkIndex || 0) - Number(right.chunkIndex || 0));
  const spans = [];
  let state = { section: "", page: null, sheet: "" };
  let paragraph = [];
  let paragraphStart = 0;
  let offset = 0;

  const pushSpan = ({ kind, text, charStart, row = null }) => {
    const clean = String(text || "").trim();
    if (!clean) return;
    const bounded = clean.length > MAX_SPAN_CHARS ? clean.slice(0, MAX_SPAN_CHARS) : clean;
    const contentHash = sha1(bounded);
    const location = [kind, state.page ?? "", state.sheet, row ?? "", spans.length].join("|");
    const chunk = chunkForSpan(fileChunks, bounded);
    spans.push({
      evidenceId: `ev_${sha1(`${documentId}|${location}|${contentHash}`).slice(0, 16)}`,
      documentId,
      sourceId,
      fileId,
      chunkId: chunk?.id || null,
      kind,
      ordinal: spans.length,
      pageStart: state.page,
      pageEnd: state.page,
      sheetName: state.sheet || null,
      rowStart: row,
      rowEnd: row,
      sectionTitle: state.section || null,
      text: bounded,
      contentHash,
      charStart,
      charEnd: charStart + clean.length,
      recognition
    });
  };

  const flushParagraph = () => {
    if (paragraph.length) pushSpan({ kind: "paragraph", text: paragraph.join("\n"), charStart: paragraphStart });
    paragraph = [];
  };

  for (const line of body.split("\n")) {
    const lineStart = offset;
    offset += line.length + 1;
    const heading = headingText(line);
    if (heading) {
      flushParagraph();
      state = locationState(state, heading);
      continue;
    }
    if (!line.trim()) {
      flushParagraph();
      continue;
    }
    const row = line.match(/^\|\s*(\d+)\s*\|/);
    if (row) {
      flushParagraph();
      pushSpan({ kind: "table_row", text: line, charStart: lineStart, row: Number(row[1]) });
      continue;
    }
    if (/^\|[\s:|-]+\|?\s*$/.test(line)) continue;
    if (!paragraph.length) paragraphStart = lineStart;
    paragraph.push(line);
  }
  flushParagraph();
  return spans;
}

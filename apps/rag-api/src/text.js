const WORD_RE = /[\p{L}\p{N}_-]+/gu;

export function normalizeText(text) {
  return String(text || "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{4,}/g, "\n\n\n")
    .trim();
}

export function tokenize(text) {
  return Array.from(String(text || "").toLowerCase().matchAll(WORD_RE), (match) => match[0])
    .filter((token) => token.length > 1);
}

function normalizeHeading(line) {
  const match = String(line || "").match(/^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/);
  return match ? match[1].trim() : "";
}

function numberOrNull(value) {
  if (value === undefined || value === null || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function mergeRange(target, startKey, endKey, start, end = start) {
  const normalizedStart = numberOrNull(start);
  const normalizedEnd = numberOrNull(end);
  if (normalizedStart === null) return target;
  const safeEnd = normalizedEnd === null ? normalizedStart : normalizedEnd;
  return {
    ...target,
    [startKey]: target[startKey] == null ? normalizedStart : Math.min(target[startKey], normalizedStart),
    [endKey]: target[endKey] == null ? safeEnd : Math.max(target[endKey], safeEnd)
  };
}

function mergeChunkMetadata(left = {}, right = {}) {
  let merged = { ...left, ...right };
  merged = mergeRange(merged, "pageStart", "pageEnd", left.pageStart, left.pageEnd);
  merged = mergeRange(merged, "pageStart", "pageEnd", right.pageStart, right.pageEnd);
  merged = mergeRange(merged, "rowStart", "rowEnd", left.rowStart, left.rowEnd);
  merged = mergeRange(merged, "rowStart", "rowEnd", right.rowStart, right.rowEnd);
  return merged;
}

function compactChunkMetadata(metadata = {}) {
  return Object.fromEntries(
    Object.entries(metadata)
      .filter(([, value]) => value !== undefined && value !== null && value !== "")
  );
}

function metadataForMarkdownPart(text, state = {}) {
  let nextState = { ...state };
  let metadata = { ...state };
  const lines = String(text || "").split("\n");
  const rows = [];

  for (const line of lines) {
    const heading = normalizeHeading(line);
    if (heading) {
      const pageMatch = heading.match(/^OCR\s+page\s+(\d+)$/i) || heading.match(/^page\s+(\d+)$/i);
      const sheetMatch = heading.match(/^\u041b\u0438\u0441\u0442\s*:\s*(.+)$/i) || heading.match(/^sheet\s*:\s*(.+)$/i);

      if (pageMatch) {
        const page = Number(pageMatch[1]);
        nextState = { ...nextState, pageStart: page, pageEnd: page };
        metadata = mergeChunkMetadata(metadata, { pageStart: page, pageEnd: page });
      } else if (sheetMatch) {
        nextState = { ...nextState, sheetName: sheetMatch[1].trim(), rowStart: null, rowEnd: null };
        metadata = { ...metadata, sheetName: nextState.sheetName };
      } else {
        nextState = { ...nextState, sectionTitle: heading };
        metadata = { ...metadata, sectionTitle: heading };
      }
    }

    const rowMatch = line.match(/^\|\s*(\d+)\s*\|/);
    if (rowMatch) rows.push(Number(rowMatch[1]));
  }

  if (rows.length) {
    metadata = mergeChunkMetadata(metadata, {
      rowStart: Math.min(...rows),
      rowEnd: Math.max(...rows)
    });
  }

  return { metadata, nextState };
}

function chunkValue(text, metadata, withMetadata) {
  const clean = normalizeText(text);
  if (!clean) return null;
  if (!withMetadata) return clean;
  return {
    text: clean,
    ...compactChunkMetadata(metadata)
  };
}

export function chunkMarkdown(markdown, maxChars = 1800, overlapChars = 220, baseMetadata = null) {
  const clean = normalizeText(markdown);
  if (!clean) return [];

  const withMetadata = baseMetadata && typeof baseMetadata === "object";
  let metadataState = withMetadata ? { ...baseMetadata } : {};
  const paragraphs = clean.split(/\n{2,}/);
  const chunks = [];
  let current = "";
  let currentMetadata = { ...metadataState };

  for (const paragraph of paragraphs) {
    const paragraphContext = withMetadata
      ? metadataForMarkdownPart(paragraph, metadataState)
      : { metadata: {}, nextState: metadataState };
    metadataState = paragraphContext.nextState;
    const next = current ? `${current}\n\n${paragraph}` : paragraph;
    if (next.length <= maxChars) {
      current = next;
      currentMetadata = current
        ? mergeChunkMetadata(currentMetadata, paragraphContext.metadata)
        : paragraphContext.metadata;
      continue;
    }

    if (current) {
      const item = chunkValue(current, currentMetadata, withMetadata);
      if (item) chunks.push(item);
    }

    if (paragraph.length <= maxChars) {
      current = paragraph;
      currentMetadata = paragraphContext.metadata;
    } else {
      for (let i = 0; i < paragraph.length; i += maxChars - overlapChars) {
        const slice = paragraph.slice(i, i + maxChars);
        const sliceMetadata = withMetadata
          ? mergeChunkMetadata(paragraphContext.metadata, metadataForMarkdownPart(slice, metadataState).metadata)
          : {};
        const item = chunkValue(slice, sliceMetadata, withMetadata);
        if (item) chunks.push(item);
      }
      current = "";
      currentMetadata = { ...metadataState };
    }
  }

  if (current) {
    const item = chunkValue(current, currentMetadata, withMetadata);
    if (item) chunks.push(item);
  }
  return withMetadata ? chunks : chunks.map(normalizeText).filter(Boolean);
}

export function snippet(text, query, radius = 260) {
  const lower = String(text || "").toLowerCase();
  const terms = tokenize(query);
  let index = -1;

  for (const term of terms) {
    index = lower.indexOf(term.toLowerCase());
    if (index >= 0) break;
  }

  if (index < 0) return normalizeText(text).slice(0, radius * 2);

  const start = Math.max(0, index - radius);
  const end = Math.min(text.length, index + radius);
  const prefix = start > 0 ? "..." : "";
  const suffix = end < text.length ? "..." : "";
  return `${prefix}${normalizeText(text.slice(start, end))}${suffix}`;
}

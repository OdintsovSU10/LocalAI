function fileName(filePath) {
  return String(filePath || "").split(/[\\/]/).filter(Boolean).pop() || "";
}

function compact(value, maxLength = 90) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength - 1).trim()}...`;
}

function quoted(value) {
  return `"${compact(value).replaceAll('"', "'")}"`;
}

function firstValue(item, ...keys) {
  for (const key of keys) {
    const direct = item?.[key];
    if (direct !== undefined && direct !== null && direct !== "") return direct;
    const nested = item?.metadata?.[key];
    if (nested !== undefined && nested !== null && nested !== "") return nested;
  }
  return "";
}

function numberValue(item, ...keys) {
  const value = firstValue(item, ...keys);
  if (value === undefined || value === null || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function extensionFor(item) {
  const path = String(item?.path || item?.title || "");
  const match = path.toLowerCase().match(/\.([a-z0-9]+)(?:$|[?#])/);
  return match ? `.${match[1]}` : "";
}

export function citationFileName(item = {}) {
  return String(item.title || fileName(item.path) || "source").trim();
}

export function buildCitationTarget(item = {}, index = null) {
  const metadata = item.metadata || {};
  const chunkId = String(item.chunkId || item.id || "").trim();
  const fileId = String(item.fileId || metadata.fileId || "").trim();
  const sourceId = String(item.sourceId || metadata.sourceId || "").trim();
  const chunkIndex = item.chunkIndex ?? metadata.chunkIndex;
  const fileLabel = citationFileName(item);
  const label = item.citationLabel || formatCitationLabel(item);

  return {
    citationId: Number.isInteger(index) ? index + 1 : undefined,
    index: Number.isInteger(index) ? index : undefined,
    sourceId,
    chunkId,
    chunkIndex: chunkIndex === undefined || chunkIndex === null || chunkIndex === "" ? undefined : Number(chunkIndex),
    fileId,
    fileLabel,
    pathLabel: fileLabel,
    label,
    documentType: firstValue(item, "documentType"),
    pageStart: numberValue(item, "pageStart") ?? undefined,
    pageEnd: numberValue(item, "pageEnd") ?? undefined,
    totalPages: numberValue(item, "totalPages") ?? undefined,
    sheetName: firstValue(item, "sheetName"),
    rowStart: numberValue(item, "rowStart") ?? undefined,
    rowEnd: numberValue(item, "rowEnd") ?? undefined,
    sectionTitle: firstValue(item, "sectionTitle"),
    snippet: String(item.snippet || item.text || "").slice(0, 1200)
  };
}

export function formatCitationLabel(item = {}) {
  const label = citationFileName(item);
  const ext = extensionFor(item);
  const pageStart = numberValue(item, "pageStart");
  const pageEnd = numberValue(item, "pageEnd");
  const sheetName = firstValue(item, "sheetName");
  const sectionTitle = firstValue(item, "sectionTitle");

  if ((ext === ".pdf" || pageStart !== null) && pageStart !== null) {
    const pageLabel = pageEnd !== null && pageEnd > pageStart
      ? `${pageStart}-${pageEnd}`
      : `${pageStart}`;
    return `${label}, \u0441\u0442\u0440. ${pageLabel}`;
  }

  if ((ext === ".xlsx" || sheetName) && sheetName) {
    return `${label}, \u043b\u0438\u0441\u0442 ${quoted(sheetName)}`;
  }

  if (sectionTitle) {
    return `${label}, \u0440\u0430\u0437\u0434\u0435\u043b ${quoted(sectionTitle)}`;
  }

  return label;
}

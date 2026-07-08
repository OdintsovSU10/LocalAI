import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { convertToMarkdownWithReport } from "./converters.js";
import { normalizeText } from "./text.js";

const GOOGLE_EXPORT_TIMEOUT_MS = 12000;
const GOOGLE_EXPORT_MAX_BYTES = 8 * 1024 * 1024;
const GOOGLE_DRIVE_MAX_BYTES = 25 * 1024 * 1024;
const GOOGLE_FETCH_HOSTS = new Set([
  "docs.google.com",
  "drive.google.com",
  "accounts.google.com",
  "sheets.googleapis.com",
  "www.googleapis.com"
]);
const DRIVE_MIME_EXTENSIONS = new Map([
  ["application/pdf", ".pdf"],
  ["application/vnd.openxmlformats-officedocument.wordprocessingml.document", ".docx"],
  ["application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", ".xlsx"],
  ["text/plain", ".txt"],
  ["text/markdown", ".md"],
  ["text/csv", ".csv"],
  ["application/csv", ".csv"]
]);
const DRIVE_SUPPORTED_EXTENSIONS = new Set([".pdf", ".docx", ".xlsx", ".txt", ".md", ".markdown", ".csv"]);

function isGoogleusercontentHost(hostname) {
  const host = String(hostname || "").toLowerCase();
  return host === "googleusercontent.com" || host.endsWith(".googleusercontent.com");
}

function isAllowedGoogleFetchHost(url) {
  const host = url.hostname.toLowerCase();
  return GOOGLE_FETCH_HOSTS.has(host) || isGoogleusercontentHost(host);
}

function parseGoogleContextUrl(rawUrl) {
  let url;
  try {
    url = new URL(String(rawUrl || "").trim());
  } catch {
    return null;
  }

  const hashParams = new URLSearchParams(String(url.hash || "").replace(/^#\??/, ""));
  const param = (name) => url.searchParams.get(name) || hashParams.get(name) || "";
  const host = url.hostname.toLowerCase();
  if (host === "docs.google.com") {
    const docsMatch = url.pathname.match(/^\/(document|spreadsheets|presentation)\/d\/([^/]+)/);
    if (!docsMatch) return null;
    return {
      url,
      app: docsMatch[1],
      id: docsMatch[2],
      gid: param("gid"),
      resourceKey: param("resourcekey")
    };
  }

  if (host === "drive.google.com") {
    const fileMatch = url.pathname.match(/^\/file\/d\/([^/]+)/);
    const id = fileMatch?.[1] || url.searchParams.get("id") || "";
    if (!id) return null;
    return {
      url,
      app: "drive-file",
      id,
      resourceKey: param("resourcekey")
    };
  }

  return null;
}

function withResourceKey(exportUrl, parsed) {
  if (parsed.resourceKey) exportUrl.searchParams.set("resourcekey", parsed.resourceKey);
  return exportUrl.toString();
}

export function googleContextExportTarget(link = {}) {
  const parsed = parseGoogleContextUrl(link.url);
  if (!parsed) return null;

  if (parsed.app === "document") {
    const exportUrl = new URL(`https://docs.google.com/document/d/${encodeURIComponent(parsed.id)}/export`);
    exportUrl.searchParams.set("format", "txt");
    return {
      kind: "doc",
      id: parsed.id,
      documentType: "gdoc",
      extension: ".gdoc",
      exportUrl: withResourceKey(exportUrl, parsed)
    };
  }

  if (parsed.app === "spreadsheets") {
    const exportUrl = new URL(`https://docs.google.com/spreadsheets/d/${encodeURIComponent(parsed.id)}/export`);
    exportUrl.searchParams.set("format", "csv");
    if (parsed.gid) exportUrl.searchParams.set("gid", parsed.gid);
    return {
      kind: "sheet",
      id: parsed.id,
      gid: parsed.gid,
      documentType: "gsheet",
      extension: ".gsheet",
      exportUrl: withResourceKey(exportUrl, parsed),
      sheetName: link.title || "Sheet"
    };
  }

  if (parsed.app === "drive-file") {
    const exportUrl = new URL("https://drive.google.com/uc");
    exportUrl.searchParams.set("export", "download");
    exportUrl.searchParams.set("id", parsed.id);
    return {
      kind: "drive-file",
      id: parsed.id,
      documentType: "gdrive",
      extension: "",
      exportUrl: withResourceKey(exportUrl, parsed)
    };
  }

  return null;
}

function collapseTitle(title, fallback = "Google document") {
  return String(title || fallback)
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120) || fallback;
}

export function sanitizeGoogleContextTitle(title, fallback = "Google document") {
  return collapseTitle(title, fallback)
    .replace(/[<>:"\/\\|?*\u0000-\u001f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[. ]+$/g, "")
    .slice(0, 100) || fallback;
}

function markdownEscapeCell(value) {
  return String(value ?? "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/\|/g, "\\|")
    .replace(/\n+/g, " ")
    .trim();
}

function contentTypeBase(value) {
  return String(value || "").split(";")[0].trim().toLowerCase();
}

function decodeContentDispositionValue(value) {
  const raw = String(value || "").trim();
  const rfc5987 = raw.match(/^utf-8''(.+)$/i);
  if (rfc5987) {
    try {
      return decodeURIComponent(rfc5987[1]);
    } catch {
      return rfc5987[1];
    }
  }
  return raw.replace(/^"(.*)"$/s, "$1");
}

function filenameFromContentDisposition(value) {
  const text = String(value || "");
  const star = text.match(/filename\*\s*=\s*([^;]+)/i);
  if (star) return decodeContentDispositionValue(star[1]);
  const regular = text.match(/filename\s*=\s*("[^"]+"|[^;]+)/i);
  return regular ? decodeContentDispositionValue(regular[1]) : "";
}

function extensionFromContentType(contentType) {
  return DRIVE_MIME_EXTENSIONS.get(contentTypeBase(contentType)) || "";
}

function titleWithExtension(title, extension) {
  const cleanTitle = sanitizeGoogleContextTitle(title, "Google Drive file");
  if (path.posix.extname(cleanTitle).toLowerCase()) return cleanTitle;
  return `${cleanTitle}${extension}`;
}

function inferDriveFileName({ link = {}, contentDisposition = "", contentType = "" } = {}) {
  const headerName = filenameFromContentDisposition(contentDisposition);
  const rawName = headerName || link.title || "Google Drive file";
  let extension = path.posix.extname(rawName).toLowerCase();
  if (!extension) extension = extensionFromContentType(contentType);
  if (!DRIVE_SUPPORTED_EXTENSIONS.has(extension)) return { supported: false, fileName: rawName, extension };
  return {
    supported: true,
    fileName: titleWithExtension(rawName, extension),
    extension
  };
}

export function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = "";
  let quoted = false;

  for (let index = 0; index < String(text || "").length; index += 1) {
    const char = text[index];
    const next = text[index + 1];

    if (quoted) {
      if (char === "\"" && next === "\"") {
        cell += "\"";
        index += 1;
      } else if (char === "\"") {
        quoted = false;
      } else {
        cell += char;
      }
      continue;
    }

    if (char === "\"") {
      quoted = true;
    } else if (char === ",") {
      row.push(cell);
      cell = "";
    } else if (char === "\n") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else if (char !== "\r") {
      cell += char;
    }
  }

  if (cell || row.length) {
    row.push(cell);
    rows.push(row);
  }

  return rows.filter((items) => items.some((item) => String(item || "").trim()));
}

function csvToMarkdown(text, { title = "Google Sheet", sheetName = "" } = {}) {
  const rows = parseCsv(text);
  return sheetRowsToMarkdown(rows, { title, sheetName });
}

function sheetRowsToMarkdown(rows, { title = "Google Sheet", sheetName = "" } = {}) {
  const maxColumns = Math.max(0, ...rows.map((row) => row.length));
  const body = rows.map((row, index) => {
    const cells = Array.from({ length: maxColumns }, (_, cellIndex) => markdownEscapeCell(row[cellIndex]));
    return `| ${index + 1} | ${cells.join(" | ")} |`;
  });

  return normalizeText([
    `# ${title}`,
    sheetName ? `## Sheet: ${sheetName}` : "",
    body.join("\n")
  ].filter(Boolean).join("\n\n"));
}

function textToMarkdown(text, { title = "Google Doc" } = {}) {
  const clean = normalizeText(text);
  return normalizeText([
    `# ${title}`,
    clean
  ].filter(Boolean).join("\n\n"));
}

function responseHeader(response, name) {
  return response?.headers?.get?.(name) || "";
}

async function responseBuffer(response) {
  if (typeof response.arrayBuffer === "function") {
    return Buffer.from(await response.arrayBuffer());
  }
  return Buffer.from(await response.text(), "utf8");
}

async function fetchGoogleExportText(exportUrl, {
  fetchImpl = globalThis.fetch,
  timeoutMs = GOOGLE_EXPORT_TIMEOUT_MS,
  maxBytes = GOOGLE_EXPORT_MAX_BYTES
} = {}) {
  if (typeof fetchImpl !== "function") throw new Error("fetch is unavailable");

  let current = new URL(exportUrl);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      if (!isAllowedGoogleFetchHost(current)) throw new Error("Google export redirected outside Google");

      const response = await fetchImpl(current.toString(), {
        headers: {
          Accept: "text/plain,text/csv,text/tab-separated-values,*/*",
          "User-Agent": "Mozilla/5.0 LocalAI-RAG google context indexer"
        },
        redirect: "manual",
        signal: controller.signal
      });

      if (response.status >= 300 && response.status < 400) {
        const location = responseHeader(response, "location");
        if (!location) throw new Error(`Google export returned HTTP ${response.status}`);
        current = new URL(location, current);
        continue;
      }

      if (!response.ok) throw new Error(`Google export returned HTTP ${response.status}`);

      const contentType = responseHeader(response, "content-type");
      if (/text\/html/i.test(contentType)) {
        throw new Error("Google export returned an HTML page instead of document text");
      }

      const contentLength = Number(responseHeader(response, "content-length") || 0);
      if (contentLength > maxBytes) throw new Error("Google export is too large");

      const buffer = await responseBuffer(response);
      if (buffer.byteLength > maxBytes) throw new Error("Google export is too large");

      return new TextDecoder("utf-8").decode(buffer);
    }
  } finally {
    clearTimeout(timeout);
  }

  throw new Error("Google export redirected too many times");
}

async function fetchGoogleApiJson(apiUrl, {
  authFetchImpl,
  timeoutMs = GOOGLE_EXPORT_TIMEOUT_MS,
  maxBytes = GOOGLE_EXPORT_MAX_BYTES
} = {}) {
  if (typeof authFetchImpl !== "function") throw new Error("Google OAuth login is required");

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await authFetchImpl(apiUrl, {
      headers: {
        Accept: "application/json"
      },
      signal: controller.signal
    });
    if (!response.ok) throw new Error(`Google API returned HTTP ${response.status}`);

    const contentLength = Number(responseHeader(response, "content-length") || 0);
    if (contentLength > maxBytes) throw new Error("Google API response is too large");

    const buffer = await responseBuffer(response);
    if (buffer.byteLength > maxBytes) throw new Error("Google API response is too large");

    return JSON.parse(new TextDecoder("utf-8").decode(buffer) || "{}");
  } finally {
    clearTimeout(timeout);
  }
}

function googleSheetRange(sheetTitle) {
  return `'${String(sheetTitle || "Sheet1").replaceAll("'", "''")}'`;
}

function chooseGoogleSheet(sheets = [], gid = "") {
  if (gid !== "") {
    const sheetId = Number(gid);
    const matched = sheets.find((sheet) => Number(sheet?.properties?.sheetId) === sheetId);
    if (matched) return matched;
  }
  return sheets[0] || null;
}

async function fetchGoogleSheetWithApi(link = {}, target = {}, options = {}) {
  const metadataUrl = new URL(`https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(target.id)}`);
  metadataUrl.searchParams.set("fields", "properties(title),sheets(properties(sheetId,title))");
  const metadata = await fetchGoogleApiJson(metadataUrl.toString(), options);
  const sheet = chooseGoogleSheet(metadata.sheets || [], target.gid);
  const sheetTitle = sheet?.properties?.title || "";
  if (!sheetTitle) {
    return {
      ok: false,
      reason: "empty_google_context_export",
      message: "Google Sheet did not expose a readable sheet."
    };
  }

  const valuesUrl = new URL(
    `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(target.id)}/values/${encodeURIComponent(googleSheetRange(sheetTitle))}`
  );
  valuesUrl.searchParams.set("majorDimension", "ROWS");
  valuesUrl.searchParams.set("valueRenderOption", "FORMATTED_VALUE");
  const values = await fetchGoogleApiJson(valuesUrl.toString(), options);
  const rows = Array.isArray(values.values) ? values.values : [];
  const title = collapseTitle(link.title || metadata.properties?.title, "Google Sheet");
  const markdown = sheetRowsToMarkdown(rows, { title, sheetName: sheetTitle });

  if (!markdown || markdown.length < 20 || !rows.length) {
    return {
      ok: false,
      reason: "empty_google_context_export",
      message: "Google Sheet did not contain enough text."
    };
  }

  return {
    ok: true,
    title,
    markdown,
    extension: target.extension,
    documentType: target.documentType,
    recognition: {
      method: "google-sheet-api",
      documentType: target.documentType,
      chars: markdown.length,
      exportFormat: "sheets-api",
      sheetTitle,
      sheetId: sheet?.properties?.sheetId ?? null
    }
  };
}

async function fetchGoogleDocWithApi(link = {}, target = {}, options = {}) {
  const exportUrl = new URL(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(target.id)}/export`);
  exportUrl.searchParams.set("mimeType", "text/plain");
  const title = collapseTitle(link.title, "Google Doc");
  const exported = await fetchGoogleExportText(exportUrl.toString(), {
    ...options,
    fetchImpl: options.authFetchImpl
  });
  const markdown = textToMarkdown(exported, { title });

  if (!markdown || markdown.length < 20) {
    return {
      ok: false,
      reason: "empty_google_context_export",
      message: "Google Doc did not contain enough text."
    };
  }

  return {
    ok: true,
    title,
    markdown,
    extension: target.extension,
    documentType: target.documentType,
    recognition: {
      method: "google-doc-api",
      documentType: target.documentType,
      chars: markdown.length,
      exportFormat: "drive-api-text"
    }
  };
}

async function fetchGoogleDriveFileBuffer(downloadUrl, {
  fetchImpl = globalThis.fetch,
  timeoutMs = GOOGLE_EXPORT_TIMEOUT_MS,
  maxBytes = GOOGLE_DRIVE_MAX_BYTES
} = {}) {
  if (typeof fetchImpl !== "function") throw new Error("fetch is unavailable");

  let current = new URL(downloadUrl);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      if (!isAllowedGoogleFetchHost(current)) throw new Error("Google Drive download redirected outside Google");

      const response = await fetchImpl(current.toString(), {
        headers: {
          Accept: "application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/plain,text/csv,*/*",
          "User-Agent": "Mozilla/5.0 LocalAI-RAG google drive indexer"
        },
        redirect: "manual",
        signal: controller.signal
      });

      if (response.status >= 300 && response.status < 400) {
        const location = responseHeader(response, "location");
        if (!location) throw new Error(`Google Drive download returned HTTP ${response.status}`);
        current = new URL(location, current);
        continue;
      }

      if (!response.ok) throw new Error(`Google Drive download returned HTTP ${response.status}`);

      const contentType = responseHeader(response, "content-type");
      if (/text\/html/i.test(contentType)) {
        throw new Error("Google Drive returned an HTML page instead of a downloadable file");
      }

      const contentLength = Number(responseHeader(response, "content-length") || 0);
      if (contentLength > maxBytes) throw new Error("Google Drive file is too large");

      const buffer = await responseBuffer(response);
      if (buffer.byteLength > maxBytes) throw new Error("Google Drive file is too large");

      return {
        buffer,
        contentType,
        contentDisposition: responseHeader(response, "content-disposition")
      };
    }
  } finally {
    clearTimeout(timeout);
  }

  throw new Error("Google Drive download redirected too many times");
}

async function convertDriveBufferToMarkdown(buffer, { fileName, extension, onProgress } = {}) {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "localai-google-drive-"));
  const tempFile = path.join(tempDir, titleWithExtension(fileName, extension));

  try {
    await fs.writeFile(tempFile, buffer);
    return await convertToMarkdownWithReport(tempFile, { onProgress });
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}

async function fetchGoogleDriveContextMarkdown(link = {}, target = {}, options = {}) {
  const downloaded = await fetchGoogleDriveFileBuffer(target.exportUrl, options);
  const inferred = inferDriveFileName({
    link,
    contentDisposition: downloaded.contentDisposition,
    contentType: downloaded.contentType
  });

  if (!inferred.supported) {
    return {
      ok: false,
      reason: "unsupported_google_drive_file",
      message: "Google Drive file type is not supported for indexing yet."
    };
  }

  const converted = await convertDriveBufferToMarkdown(downloaded.buffer, {
    fileName: inferred.fileName,
    extension: inferred.extension,
    onProgress: options.onProgress
  });
  const title = collapseTitle(inferred.fileName.replace(/\.[^.]+$/i, ""), link.title || "Google Drive file");
  const markdown = normalizeText([
    `# ${title}`,
    converted.markdown
  ].filter(Boolean).join("\n\n"));

  if (!markdown || markdown.length < 20) {
    return {
      ok: false,
      reason: "empty_google_drive_export",
      message: "Google Drive file did not contain enough text."
    };
  }

  return {
    ok: true,
    title,
    markdown,
    extension: inferred.extension,
    documentType: inferred.extension.replace(".", "") || "gdrive",
    recognition: {
      ...(converted.recognition || {}),
      method: `google-drive-${converted.recognition?.method || inferred.extension.replace(".", "") || "file"}`,
      documentType: inferred.extension.replace(".", "") || "gdrive",
      chars: markdown.length,
      contentType: contentTypeBase(downloaded.contentType)
    }
  };
}

async function fetchGoogleDriveContextMarkdownWithApi(link = {}, target = {}, options = {}) {
  const metadataUrl = new URL(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(target.id)}`);
  metadataUrl.searchParams.set("fields", "name,mimeType");
  const metadata = await fetchGoogleApiJson(metadataUrl.toString(), options);
  const downloadUrl = new URL(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(target.id)}`);
  downloadUrl.searchParams.set("alt", "media");
  const downloaded = await fetchGoogleDriveFileBuffer(downloadUrl.toString(), {
    ...options,
    fetchImpl: options.authFetchImpl
  });
  const inferred = inferDriveFileName({
    link: {
      ...link,
      title: metadata.name || link.title
    },
    contentDisposition: downloaded.contentDisposition,
    contentType: downloaded.contentType || metadata.mimeType
  });

  if (!inferred.supported) {
    return {
      ok: false,
      reason: "unsupported_google_drive_file",
      message: "Google Drive file type is not supported for indexing yet."
    };
  }

  const converted = await convertDriveBufferToMarkdown(downloaded.buffer, {
    fileName: inferred.fileName,
    extension: inferred.extension,
    onProgress: options.onProgress
  });
  const title = collapseTitle(inferred.fileName.replace(/\.[^.]+$/i, ""), link.title || "Google Drive file");
  const markdown = normalizeText([
    `# ${title}`,
    converted.markdown
  ].filter(Boolean).join("\n\n"));

  if (!markdown || markdown.length < 20) {
    return {
      ok: false,
      reason: "empty_google_drive_export",
      message: "Google Drive file did not contain enough text."
    };
  }

  return {
    ok: true,
    title,
    markdown,
    extension: inferred.extension,
    documentType: inferred.extension.replace(".", "") || "gdrive",
    recognition: {
      ...(converted.recognition || {}),
      method: `google-drive-api-${converted.recognition?.method || inferred.extension.replace(".", "") || "file"}`,
      documentType: inferred.extension.replace(".", "") || "gdrive",
      chars: markdown.length,
      contentType: contentTypeBase(downloaded.contentType || metadata.mimeType)
    }
  };
}

export async function fetchGoogleContextMarkdown(link = {}, options = {}) {
  const target = googleContextExportTarget(link);
  if (!target) {
    return {
      ok: false,
      reason: "unsupported_google_context_link",
      message: "Only public Google Docs, Google Sheets, and Google Drive file links can be indexed right now."
    };
  }

  if (typeof options.authFetchImpl === "function") {
    if (target.kind === "sheet") return fetchGoogleSheetWithApi(link, target, options);
    if (target.kind === "doc") return fetchGoogleDocWithApi(link, target, options);
    if (target.kind === "drive-file") return fetchGoogleDriveContextMarkdownWithApi(link, target, options);
  }

  if (target.kind === "drive-file") {
    return fetchGoogleDriveContextMarkdown(link, target, options);
  }

  const title = collapseTitle(link.title, target.kind === "sheet" ? "Google Sheet" : "Google Doc");
  const exported = await fetchGoogleExportText(target.exportUrl, options);
  const markdown = target.kind === "sheet"
    ? csvToMarkdown(exported, { title, sheetName: target.sheetName || title })
    : textToMarkdown(exported, { title });

  if (!markdown || markdown.length < 20) {
    return {
      ok: false,
      reason: "empty_google_context_export",
      message: "Google export did not contain enough text."
    };
  }

  return {
    ok: true,
    title,
    markdown,
    extension: target.extension,
    documentType: target.documentType,
    recognition: {
      method: `google-${target.kind}`,
      documentType: target.documentType,
      chars: markdown.length,
      exportFormat: target.kind === "sheet" ? "csv" : "txt"
    }
  };
}

export function googleContextVirtualPath(link = {}, extension = ".gdoc") {
  const title = sanitizeGoogleContextTitle(link.title, "Google document");
  const cleanExtension = String(extension || ".gdoc").startsWith(".") ? extension : `.${extension}`;
  return path.posix.join("Google context", `${title}${cleanExtension}`);
}

import { matchSourceForQuestion } from "./source-match.js";

export function parseDriveFolderId(rawUrl = "") {
  try {
    const url = new URL(String(rawUrl || "").trim());
    const match = url.pathname.match(/\/folders\/([^/?#]+)/i);
    return match?.[1] || "";
  } catch {
    return "";
  }
}

export function parseSpreadsheetId(rawUrl = "") {
  try {
    const url = new URL(String(rawUrl || "").trim());
    const match = url.pathname.match(/\/spreadsheets\/d\/([^/?#]+)/i);
    return match?.[1] || "";
  } catch {
    return "";
  }
}

export function classifyGoogleDriveUrl(rawUrl = "") {
  const text = String(rawUrl || "").trim();
  if (!text) return "unsupported";

  try {
    const url = new URL(text);
    const host = url.hostname.toLowerCase();
    const pathValue = url.pathname.toLowerCase();

    if (host === "docs.google.com") {
      if (pathValue.includes("/spreadsheets/")) return "spreadsheet";
      if (pathValue.includes("/document/")) return "document";
      if (pathValue.includes("/presentation/")) return "unsupported";
    }

    if (host === "drive.google.com") {
      if (pathValue.includes("/folders/")) return "folder";
      if (pathValue.includes("/file/d/") || url.searchParams.get("id")) return "drive-file";
    }
  } catch {
    return "unsupported";
  }

  return "unsupported";
}

export function normalizeContextLinkUrl(rawUrl = "") {
  const text = String(rawUrl || "").trim();
  if (!text) return "";

  try {
    const url = new URL(text);
    url.hash = "";
    url.search = "";
    return url.toString().replace(/\/edit$/, "/edit").replace(/\/view$/, "/edit");
  } catch {
    return text;
  }
}

export function spreadsheetContextUrl(spreadsheetId, { gid = "", title = "" } = {}) {
  const id = String(spreadsheetId || "").trim();
  if (!id) return "";

  const url = new URL(`https://docs.google.com/spreadsheets/d/${encodeURIComponent(id)}/edit`);
  if (gid !== "" && gid !== null && gid !== undefined) {
    url.hash = `gid=${gid}`;
  }
  return url.toString();
}

export function contextLinkDedupKey(rawUrl = "") {
  const text = String(rawUrl || "").trim().toLowerCase();
  if (!text) return "";

  try {
    const url = new URL(text);
    const host = url.hostname.toLowerCase();
    const spreadsheetId = parseSpreadsheetId(text);
    if (spreadsheetId) {
      const hashParams = new URLSearchParams(String(url.hash || "").replace(/^#\??/, ""));
      const gid = hashParams.get("gid") || "";
      return `sheet:${spreadsheetId}:${gid}`;
    }

    if (host === "docs.google.com") {
      const docsMatch = url.pathname.match(/\/(document)\/d\/([^/?#]+)/i);
      if (docsMatch) return `doc:${docsMatch[2]}`;
    }

    if (host === "drive.google.com") {
      const fileMatch = url.pathname.match(/\/file\/d\/([^/?#]+)/i);
      const fileId = fileMatch?.[1] || url.searchParams.get("id") || "";
      if (fileId) return `drive:${fileId}`;
    }

    url.hash = "";
    return `url:${url.toString().toLowerCase()}`;
  } catch {
    return text;
  }
}

export function matchDriveNameToSource(name, sources = [], options = {}) {
  const minScore = Number(options.minScore ?? 5);
  const requireConfident = options.requireConfident !== false;
  const result = matchSourceForQuestion(String(name || ""), sources);

  if (!result.source) {
    return {
      source: null,
      score: result.score,
      matchedTokens: result.matchedTokens,
      confident: false,
      candidates: result.candidates
    };
  }

  const confident = requireConfident ? result.confident : result.score >= minScore;
  if (!confident || result.score < minScore) {
    return {
      source: null,
      score: result.score,
      matchedTokens: result.matchedTokens,
      confident: false,
      candidates: result.candidates
    };
  }

  return {
    source: result.source,
    score: result.score,
    matchedTokens: result.matchedTokens,
    confident: true,
    candidates: result.candidates
  };
}

export function buildSpreadsheetContextLinks(spreadsheetId, {
  title = "",
  tabs = []
} = {}) {
  const id = String(spreadsheetId || "").trim();
  if (!id) return [];

  const baseTitle = String(title || "Google Sheet").trim() || "Google Sheet";
  const normalizedTabs = Array.isArray(tabs) ? tabs.filter((tab) => tab && (tab.gid !== undefined || tab.title)) : [];

  if (!normalizedTabs.length) {
    return [{
      url: spreadsheetContextUrl(id),
      title: baseTitle,
      kind: "sheet"
    }];
  }

  if (normalizedTabs.length === 1) {
    const tab = normalizedTabs[0];
    return [{
      url: spreadsheetContextUrl(id, { gid: tab.gid ?? "" }),
      title: baseTitle,
      kind: "sheet"
    }];
  }

  return normalizedTabs.map((tab) => {
    const sheetTitle = String(tab.title || "").trim();
    const linkTitle = sheetTitle ? `${baseTitle} — ${sheetTitle}` : baseTitle;
    return {
      url: spreadsheetContextUrl(id, { gid: tab.gid ?? "" }),
      title: linkTitle,
      kind: "sheet"
    };
  });
}

export function buildDriveFileContextLink({ url, title = "", kind = "auto" } = {}) {
  const cleanUrl = String(url || "").trim();
  if (!cleanUrl) return null;

  const detectedKind = kind === "auto" ? classifyGoogleDriveUrl(cleanUrl) : kind;
  if (detectedKind === "unsupported" || detectedKind === "folder") return null;

  return {
    url: cleanUrl,
    title: String(title || "").trim() || "Google document",
    kind: detectedKind === "spreadsheet" ? "sheet" : detectedKind === "document" ? "doc" : "link"
  };
}

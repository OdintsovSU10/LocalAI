import crypto from "node:crypto";

const GOOGLE_TITLE_TIMEOUT_MS = 2500;
const GOOGLE_TITLE_MAX_CHARS = 120000;
const GOOGLE_CONTEXT_HOSTS = new Set(["docs.google.com", "drive.google.com"]);
const GENERIC_GOOGLE_TITLES = [
  /^google\s+(docs|sheets|slides|drive|forms)$/i,
  /^google$/i,
  /^sign in\b/i,
  /^log in\b/i,
  /^access denied\b/i,
  /^error\b/i,
  /^вход\b/i,
  /^доступ запрещен\b/i,
  /^ошибка\b/i
];

export function contextLinkIdForUrl(url) {
  return `ctx-${crypto.createHash("sha1").update(url.toLowerCase()).digest("hex").slice(0, 10)}`;
}

export function normalizeContextLinkKind(kind, url, title = "") {
  const value = String(kind || "auto").trim().toLowerCase();
  if (["doc", "sheet", "kp", "link"].includes(value)) return value;

  const haystack = `${url} ${title}`.toLowerCase();
  if (haystack.includes("spreadsheets")) return "sheet";
  if (haystack.includes("document")) return "doc";
  if (/(^|[\s_-])kp([\s_.-]|$)|кп/i.test(`${title} ${url}`)) return "kp";
  return "link";
}

function isGoogleContextUrl(url) {
  return GOOGLE_CONTEXT_HOSTS.has(url.hostname.toLowerCase());
}

function decodeHtmlEntities(text) {
  const named = {
    amp: "&",
    apos: "'",
    gt: ">",
    lt: "<",
    nbsp: " ",
    quot: "\""
  };

  const decodeCodePoint = (value) => {
    if (!Number.isInteger(value) || value < 0 || value > 0x10ffff) return "";
    return String.fromCodePoint(value);
  };

  return String(text || "").replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, entity) => {
    const key = entity.toLowerCase();
    if (key.startsWith("#x")) return decodeCodePoint(Number.parseInt(key.slice(2), 16)) || match;
    if (key.startsWith("#")) return decodeCodePoint(Number.parseInt(key.slice(1), 10)) || match;
    return Object.prototype.hasOwnProperty.call(named, key) ? named[key] : match;
  });
}

function stripGoogleTitleSuffix(title) {
  return String(title || "")
    .replace(/\s+[-–]\s+Google\s+(Docs|Sheets|Slides|Drive|Forms)\s*$/i, "")
    .replace(/\s+[-–]\s+Google\s+(Документы|Таблицы|Презентации|Диск|Формы)\s*$/i, "")
    .trim();
}

function cleanContextTitle(title) {
  const clean = stripGoogleTitleSuffix(
    decodeHtmlEntities(title)
      .replace(/<[^>]*>/g, " ")
      .replace(/\s+/g, " ")
      .trim()
  );

  if (!clean) return "";
  if (GENERIC_GOOGLE_TITLES.some((pattern) => pattern.test(clean))) return "";
  return clean.slice(0, 160);
}

function attributesForTag(tag) {
  const attributes = {};
  for (const match of tag.matchAll(/\s([a-z:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi)) {
    attributes[match[1].toLowerCase()] = match[2] ?? match[3] ?? match[4] ?? "";
  }
  return attributes;
}

function metaTitleCandidates(html) {
  const candidates = [];
  for (const match of html.matchAll(/<meta\b[^>]*>/gi)) {
    const attrs = attributesForTag(match[0]);
    const name = String(attrs.property || attrs.name || "").toLowerCase();
    if (["og:title", "twitter:title", "title"].includes(name) && attrs.content) {
      candidates.push(attrs.content);
    }
  }
  return candidates;
}

export function extractGoogleDocumentTitle(html) {
  const text = String(html || "").slice(0, GOOGLE_TITLE_MAX_CHARS);
  const candidates = metaTitleCandidates(text);
  const titleMatch = text.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i);
  if (titleMatch) candidates.push(titleMatch[1]);

  for (const candidate of candidates) {
    const title = cleanContextTitle(candidate);
    if (title) return title;
  }
  return "";
}

function fallbackContextLinkTitle(parsed, kind) {
  if (parsed.hostname.toLowerCase() === "docs.google.com") {
    if (parsed.pathname.includes("/spreadsheets/")) return "Google Sheet";
    if (parsed.pathname.includes("/document/")) return "Google Doc";
    if (parsed.pathname.includes("/presentation/")) return "Google Slides";
  }
  if (parsed.hostname.toLowerCase() === "drive.google.com") return "Google Drive";
  if (kind === "sheet") return "Google Sheet";
  if (kind === "doc") return "Google Doc";
  if (kind === "kp") return "KP";
  return parsed.hostname;
}

export function normalizeContextLink(input = {}, existing = null) {
  const url = String(input.url || existing?.url || "").trim();
  if (!url) throw new Error("url is required");

  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("url must be a valid URL");
  }

  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new Error("url must use http or https");
  }

  const now = new Date().toISOString();
  const rawTitle = String(input.title || existing?.title || "").trim();
  const kind = normalizeContextLinkKind(input.kind || existing?.kind, url, rawTitle);
  const title = rawTitle || fallbackContextLinkTitle(parsed, kind);
  return {
    id: String(input.id || existing?.id || contextLinkIdForUrl(url)).trim(),
    title,
    url,
    kind,
    createdAt: existing?.createdAt || now,
    updatedAt: input === existing ? (existing?.updatedAt || now) : now
  };
}

export function publicContextLinks(source) {
  const links = Array.isArray(source.contextLinks) ? source.contextLinks : [];
  return links
    .map((link) => {
      try {
        return normalizeContextLink(link, link);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

export async function fetchGoogleContextTitle(rawUrl, {
  fetchImpl = globalThis.fetch,
  timeoutMs = GOOGLE_TITLE_TIMEOUT_MS
} = {}) {
  if (typeof fetchImpl !== "function") return "";

  let current;
  try {
    current = new URL(String(rawUrl || "").trim());
  } catch {
    return "";
  }

  if (!isGoogleContextUrl(current)) return "";

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      if (!isGoogleContextUrl(current)) return "";

      const response = await fetchImpl(current.toString(), {
        headers: {
          Accept: "text/html,application/xhtml+xml",
          "User-Agent": "Mozilla/5.0 LocalAI-RAG title resolver"
        },
        redirect: "manual",
        signal: controller.signal
      });

      if (response.status >= 300 && response.status < 400) {
        const location = response.headers?.get?.("location");
        if (!location) return "";
        current = new URL(location, current);
        continue;
      }

      if (!response.ok) return "";
      const contentType = response.headers?.get?.("content-type") || "";
      if (contentType && !/text\/html|application\/xhtml\+xml/i.test(contentType)) return "";
      return extractGoogleDocumentTitle(await response.text());
    }
  } catch {
    return "";
  } finally {
    clearTimeout(timeout);
  }

  return "";
}

export async function resolveContextLinkTitle(input = {}, options = {}) {
  const title = String(input.title || "").trim();
  if (title) return { ...input, title };

  const resolvedTitle = await fetchGoogleContextTitle(input.url, options);
  return resolvedTitle ? { ...input, title: resolvedTitle } : input;
}

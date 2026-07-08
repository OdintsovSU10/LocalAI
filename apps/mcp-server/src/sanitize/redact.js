import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";

const BEARER_RE = /Bearer\s+[A-Za-z0-9._~+/=-]+/gi;
const API_KEY_RE = /api[_-]?key["'\s:=]+[^"',\s]+/gi;
const TOKEN_QUERY_RE = /([?&](?:token|access_token|api_key|key|id)=)[^&\s#]+/gi;
const GOOGLE_DOC_ID_RE = /(\/d\/)([a-zA-Z0-9_-]{8,})/g;

function homePathPrefix() {
  const home = os.homedir();
  return home ? path.normalize(home).toLowerCase() : "";
}

export function redactBearer(value = "") {
  return String(value).replace(BEARER_RE, "Bearer [redacted]");
}

export function redactApiKeys(value = "") {
  return String(value).replace(API_KEY_RE, "apiKey=[redacted]");
}

export function redactUrlUserinfo(value = "") {
  return String(value).replace(/\/\/[^/@\s:]+:[^/@\s]+@/g, "//[redacted]@");
}

export function redactQueryTokensInUrl(value = "") {
  return String(value)
    .replace(TOKEN_QUERY_RE, "$1[redacted]")
    .replace(GOOGLE_DOC_ID_RE, "$1[redacted]");
}

export function redactHomePaths(value = "") {
  const home = homePathPrefix();
  if (!home) return String(value);

  const pattern = new RegExp(home.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
  return String(value).replace(pattern, "[home]");
}

export function redactString(value = "") {
  return redactHomePaths(
    redactQueryTokensInUrl(
      redactUrlUserinfo(
        redactApiKeys(
          redactBearer(String(value))
        )
      )
    )
  );
}

export function redactLine(value = "") {
  return redactString(value)
    .split(/\r?\n/)
    .slice(-6)
    .join("\n");
}

export function maskPathValue(filePath = "") {
  const normalized = String(filePath || "").trim();
  if (!normalized) return "";
  const base = path.basename(normalized);
  const hash = crypto.createHash("sha256").update(normalized).digest("hex").slice(0, 8);
  return `${base}#${hash}`;
}

const SECRET_KEYS = new Set([
  "apiKey",
  "api_key",
  "token",
  "authToken",
  "password",
  "secret",
  "authorization"
]);

export function sanitizeValue(value, options = {}) {
  const { maskPaths = false } = options;

  if (value == null) return value;
  if (typeof value === "string") {
    if (maskPaths && (value.includes("\\") || value.includes("/"))) {
      return maskPathValue(value);
    }
    return redactString(value);
  }
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeValue(item, options));
  }
  if (typeof value === "object") {
    const output = {};
    for (const [key, nested] of Object.entries(value)) {
      if (SECRET_KEYS.has(key)) {
        output[key] = "[redacted]";
        continue;
      }
      if (key === "path" && maskPaths) {
        output[key] = maskPathValue(nested);
        continue;
      }
      if (key === "url" || key === "href" || key === "baseUrl") {
        output[key] = redactQueryTokensInUrl(redactUrlUserinfo(redactString(String(nested || ""))));
        continue;
      }
      output[key] = sanitizeValue(nested, options);
    }
    return output;
  }
  return value;
}

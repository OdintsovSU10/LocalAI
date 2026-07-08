import { isLoopbackHost } from "../../../apps/rag-api/src/security.js";

const DEFAULT_API_URL = "http://127.0.0.1:8787";
const DEFAULT_TIMEOUT_MS = 30_000;

function parsePositiveInt(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function resolveApiBaseUrl(env = process.env) {
  const raw = String(env.RAG_API_URL || DEFAULT_API_URL).trim();
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error("RAG_API_URL must be a valid HTTP(S) URL");
  }

  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new Error("RAG_API_URL must use http or https");
  }

  if (!isLoopbackHost(parsed.hostname)) {
    throw new Error("RAG_API_URL must point to loopback (127.0.0.1, localhost, or ::1)");
  }

  parsed.hash = "";
  parsed.username = "";
  parsed.password = "";
  return parsed.toString().replace(/\/$/, "");
}

export function readMcpConfig(env = process.env) {
  const authToken = String(env.RAG_AUTH_TOKEN || "").trim();
  const phase = String(env.LOCALAI_MCP_PHASE || "1").trim() || "1";

  return {
    apiBaseUrl: resolveApiBaseUrl(env),
    authToken,
    phase,
    requestTimeoutMs: parsePositiveInt(env.LOCALAI_MCP_TIMEOUT_MS, DEFAULT_TIMEOUT_MS)
  };
}

export function isPhaseOne(config) {
  return String(config.phase || "1") === "1";
}

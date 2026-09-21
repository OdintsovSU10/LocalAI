import { isLoopbackHost } from "../../rag-api/src/security.js";

// Telegram bot configuration (Product V2, Stage 08). Everything sensitive comes from the environment:
// the bot token and the allowlist are never read from the repo and never logged.

const DEFAULT_API_URL = "http://127.0.0.1:8787";
const DEFAULT_TELEGRAM_API = "https://api.telegram.org";

function positiveInt(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

export function parseAllowlist(value = "") {
  return [...new Set(String(value)
    .split(/[\s,;]+/)
    .map((entry) => entry.trim())
    .filter((entry) => /^-?\d+$/.test(entry)))];
}

export function resolveLocalApiUrl(raw = DEFAULT_API_URL) {
  let parsed;
  try {
    parsed = new URL(String(raw || DEFAULT_API_URL).trim());
  } catch {
    throw new Error("LOCALAI_API_URL must be a valid HTTP(S) URL");
  }
  if (!["http:", "https:"].includes(parsed.protocol)) throw new Error("LOCALAI_API_URL must use http or https");
  // The bot is a thin adapter to the local portal; it must not reach a remote backend.
  if (!isLoopbackHost(parsed.hostname)) throw new Error("LOCALAI_API_URL must point to loopback (127.0.0.1, localhost or ::1)");
  parsed.hash = "";
  parsed.username = "";
  parsed.password = "";
  return parsed.toString().replace(/\/$/, "");
}

/**
 * @returns {{ config: object|null, problems: string[] }} config is null when the bot must not start.
 */
export function readBotConfig(env = process.env) {
  const problems = [];
  const token = String(env.TELEGRAM_BOT_TOKEN || "").trim();
  if (!token) problems.push("TELEGRAM_BOT_TOKEN is not set");
  const rawAllowlist = String(env.TELEGRAM_ALLOWED_USER_IDS || "").trim();
  const allowedUserIds = parseAllowlist(rawAllowlist);
  if (!allowedUserIds.length) {
    // A username can be changed or released and taken by someone else; the numeric id cannot.
    problems.push(rawAllowlist
      ? "TELEGRAM_ALLOWED_USER_IDS has no numeric id: it must be a number like 123456789 (ask @userinfobot), not a @username"
      : "TELEGRAM_ALLOWED_USER_IDS is empty: the bot would answer anyone");
  }

  let apiBaseUrl = "";
  try {
    apiBaseUrl = resolveLocalApiUrl(env.LOCALAI_API_URL || DEFAULT_API_URL);
  } catch (error) {
    problems.push(error.message);
  }

  if (problems.length) return { config: null, problems };
  return {
    problems,
    config: {
      token,
      allowedUserIds,
      apiBaseUrl,
      authToken: String(env.RAG_AUTH_TOKEN || "").trim(),
      telegramApiBaseUrl: String(env.TELEGRAM_API_URL || DEFAULT_TELEGRAM_API).trim().replace(/\/$/, ""),
      pollTimeoutSeconds: positiveInt(env.TELEGRAM_POLL_TIMEOUT_SECONDS, 25),
      requestTimeoutSeconds: positiveInt(env.TELEGRAM_REQUEST_TIMEOUT_SECONDS, 600),
      rateLimitPerMinute: positiveInt(env.TELEGRAM_RATE_LIMIT_PER_MINUTE, 10)
    }
  };
}

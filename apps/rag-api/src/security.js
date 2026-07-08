import crypto from "node:crypto";

function parseBoolean(value) {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (!normalized) return null;
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return null;
}

function constantTimeEqual(left, right) {
  const leftBuffer = Buffer.from(String(left || ""));
  const rightBuffer = Buffer.from(String(right || ""));
  return leftBuffer.length === rightBuffer.length && crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

export function isLoopbackHost(host) {
  const value = String(host || "").trim().toLowerCase().replace(/^\[|\]$/g, "");
  return value === "localhost"
    || value === "::1"
    || value === "0:0:0:0:0:0:0:1"
    || value === "127.0.0.1"
    || value.startsWith("127.");
}

export function isAllowedApiOrigin(origin) {
  const value = String(origin || "").trim();
  if (!value) return true;

  try {
    return isLoopbackHost(new URL(value).hostname);
  } catch {
    return false;
  }
}

export function readApiSecurityConfig(env = process.env) {
  const authToken = String(env.RAG_AUTH_TOKEN || "").trim();
  const requireAuthFlag = parseBoolean(env.RAG_REQUIRE_AUTH);
  return {
    authToken,
    requireAuth: Boolean(authToken) || requireAuthFlag === true
  };
}

function bearerTokenFromHeader(header) {
  const match = String(header || "").match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : "";
}

function isPublicGoogleAuthCallback(req) {
  return String(req.method || "GET").toUpperCase() === "GET"
    && String(req.path || req.url || "").split("?")[0] === "/google/auth/callback";
}

export function createApiSecurityMiddleware(config = readApiSecurityConfig()) {
  const authToken = String(config.authToken || "").trim();
  const requireAuth = Boolean(authToken) || Boolean(config.requireAuth);

  return function apiSecurity(req, res, next) {
    if (!isAllowedApiOrigin(req.headers.origin)) {
      return res.status(403).json({ error: "API origin is not allowed" });
    }

    if (isPublicGoogleAuthCallback(req)) return next();

    if (!requireAuth) return next();

    if (!authToken) {
      return res.status(503).json({ error: "API auth is required but RAG_AUTH_TOKEN is not configured" });
    }

    const incomingToken = bearerTokenFromHeader(req.headers.authorization);
    if (!incomingToken || !constantTimeEqual(incomingToken, authToken)) {
      res.set("WWW-Authenticate", "Bearer");
      return res.status(401).json({ error: "API auth token is required" });
    }

    return next();
  };
}

export function shouldWarnMissingAuthForHost(host, config = readApiSecurityConfig()) {
  return !config.authToken && !isLoopbackHost(host);
}

export function warnIfUnsafeNetworkBinding(host, config = readApiSecurityConfig(), logger = console) {
  if (!shouldWarnMissingAuthForHost(host, config)) return false;
  logger.warn("WARNING: Locus is listening on a non-loopback host without RAG_AUTH_TOKEN. Set RAG_AUTH_TOKEN before exposing /api endpoints.");
  return true;
}

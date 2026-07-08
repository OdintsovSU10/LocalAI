import crypto from "node:crypto";

const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_USERINFO_URL = "https://openidconnect.googleapis.com/v1/userinfo";
const GOOGLE_SCOPES = [
  "openid",
  "email",
  "profile",
  "https://www.googleapis.com/auth/drive.readonly",
  "https://www.googleapis.com/auth/spreadsheets.readonly",
  "https://www.googleapis.com/auth/documents.readonly"
];
const AUTH_STATE_TTL_MS = 10 * 60 * 1000;
const TOKEN_REFRESH_SKEW_MS = 60 * 1000;

const pendingStates = new Map();
const tokenState = {
  accessToken: String(process.env.RAG_GOOGLE_OAUTH_ACCESS_TOKEN || ""),
  refreshToken: String(process.env.RAG_GOOGLE_OAUTH_REFRESH_TOKEN || ""),
  expiresAt: Number(process.env.RAG_GOOGLE_OAUTH_ACCESS_TOKEN_EXPIRES_AT || 0),
  email: String(process.env.RAG_GOOGLE_OAUTH_EMAIL || ""),
  source: process.env.RAG_GOOGLE_OAUTH_REFRESH_TOKEN ? "env" : (process.env.RAG_GOOGLE_OAUTH_ACCESS_TOKEN ? "env" : "")
};

function base64Url(buffer) {
  return Buffer.from(buffer)
    .toString("base64")
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/g, "");
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest();
}

function randomToken(bytes = 32) {
  return base64Url(crypto.randomBytes(bytes));
}

function googleOAuthConfig(env = process.env) {
  return {
    clientId: String(env.RAG_GOOGLE_OAUTH_CLIENT_ID || "").trim(),
    clientSecret: String(env.RAG_GOOGLE_OAUTH_CLIENT_SECRET || "").trim(),
    redirectUri: String(env.RAG_GOOGLE_OAUTH_REDIRECT_URI || `http://127.0.0.1:${env.RAG_PORT || 8787}/api/google/auth/callback`).trim()
  };
}

function cleanupExpiredStates(now = Date.now()) {
  for (const [state, entry] of pendingStates.entries()) {
    if (!entry || Number(entry.expiresAt || 0) <= now) pendingStates.delete(state);
  }
}

function tokenPayload() {
  return {
    authorized: Boolean(tokenState.accessToken || tokenState.refreshToken),
    hasRefreshToken: Boolean(tokenState.refreshToken),
    email: tokenState.email || "",
    expiresAt: tokenState.expiresAt ? new Date(tokenState.expiresAt).toISOString() : "",
    source: tokenState.source || ""
  };
}

export function googleAuthPublicStatus(env = process.env) {
  const config = googleOAuthConfig(env);
  return {
    configured: Boolean(config.clientId),
    redirectUri: config.redirectUri,
    scopes: GOOGLE_SCOPES.filter((scope) => !["openid", "email", "profile"].includes(scope)),
    pendingLogins: pendingStates.size,
    ...tokenPayload()
  };
}

export function googleAuthCanFetch(env = process.env) {
  const config = googleOAuthConfig(env);
  return Boolean(config.clientId && (tokenState.accessToken || tokenState.refreshToken));
}

async function fetchJson(url, options = {}, fetchImpl = globalThis.fetch) {
  if (typeof fetchImpl !== "function") throw new Error("fetch is unavailable");
  const response = await fetchImpl(url, options);
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = payload.error_description || payload.error || `HTTP ${response.status}`;
    throw new Error(`Google OAuth request failed: ${message}`);
  }
  return payload;
}

async function requestToken(params, config, fetchImpl = globalThis.fetch) {
  const body = new URLSearchParams(params);
  body.set("client_id", config.clientId);
  if (config.clientSecret) body.set("client_secret", config.clientSecret);
  return fetchJson(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body
  }, fetchImpl);
}

async function loadUserEmail(accessToken, fetchImpl = globalThis.fetch) {
  try {
    const user = await fetchJson(GOOGLE_USERINFO_URL, {
      headers: { Authorization: `Bearer ${accessToken}` }
    }, fetchImpl);
    return String(user.email || "").trim();
  } catch {
    return "";
  }
}

function applyTokenResponse(payload = {}, { preserveRefreshToken = true, source = "memory" } = {}) {
  tokenState.accessToken = String(payload.access_token || tokenState.accessToken || "");
  if (payload.refresh_token || !preserveRefreshToken) {
    tokenState.refreshToken = String(payload.refresh_token || "");
  }
  const expiresIn = Number(payload.expires_in || 0);
  tokenState.expiresAt = expiresIn > 0 ? Date.now() + expiresIn * 1000 : 0;
  tokenState.source = source;
}

export function startGoogleAuth({ env = process.env } = {}) {
  const config = googleOAuthConfig(env);
  if (!config.clientId) {
    throw new Error("RAG_GOOGLE_OAUTH_CLIENT_ID is required for Google login");
  }

  cleanupExpiredStates();
  const state = randomToken(24);
  const codeVerifier = randomToken(64);
  const expiresAt = Date.now() + AUTH_STATE_TTL_MS;
  pendingStates.set(state, {
    codeVerifier,
    redirectUri: config.redirectUri,
    expiresAt
  });

  const authUrl = new URL(GOOGLE_AUTH_URL);
  authUrl.searchParams.set("client_id", config.clientId);
  authUrl.searchParams.set("redirect_uri", config.redirectUri);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("scope", GOOGLE_SCOPES.join(" "));
  authUrl.searchParams.set("access_type", "offline");
  authUrl.searchParams.set("prompt", "consent");
  authUrl.searchParams.set("state", state);
  authUrl.searchParams.set("code_challenge", base64Url(sha256(codeVerifier)));
  authUrl.searchParams.set("code_challenge_method", "S256");

  return {
    authUrl: authUrl.toString(),
    expiresAt: new Date(expiresAt).toISOString(),
    status: googleAuthPublicStatus(env)
  };
}

export async function completeGoogleAuth({ code = "", state = "" } = {}, { env = process.env, fetchImpl = globalThis.fetch } = {}) {
  const config = googleOAuthConfig(env);
  if (!config.clientId) throw new Error("Google OAuth is not configured");
  cleanupExpiredStates();

  const pending = pendingStates.get(String(state || ""));
  if (!pending) throw new Error("Google OAuth state expired or was not started from this app");
  pendingStates.delete(String(state || ""));

  const payload = await requestToken({
    grant_type: "authorization_code",
    code: String(code || ""),
    redirect_uri: pending.redirectUri,
    code_verifier: pending.codeVerifier
  }, config, fetchImpl);

  applyTokenResponse(payload, { preserveRefreshToken: false, source: "memory" });
  tokenState.email = await loadUserEmail(tokenState.accessToken, fetchImpl);
  return googleAuthPublicStatus(env);
}

export function clearGoogleAuth() {
  tokenState.accessToken = "";
  tokenState.refreshToken = "";
  tokenState.expiresAt = 0;
  tokenState.email = "";
  tokenState.source = "";
  pendingStates.clear();
  return googleAuthPublicStatus();
}

async function refreshGoogleAccessToken({ env = process.env, fetchImpl = globalThis.fetch } = {}) {
  const config = googleOAuthConfig(env);
  if (!config.clientId || !tokenState.refreshToken) throw new Error("Google OAuth login is required");

  const payload = await requestToken({
    grant_type: "refresh_token",
    refresh_token: tokenState.refreshToken
  }, config, fetchImpl);

  applyTokenResponse(payload, { preserveRefreshToken: true, source: tokenState.source || "memory" });
  if (!tokenState.email) tokenState.email = await loadUserEmail(tokenState.accessToken, fetchImpl);
  return tokenState.accessToken;
}

export async function googleAccessToken(options = {}) {
  if (tokenState.accessToken && (!tokenState.expiresAt || Date.now() + TOKEN_REFRESH_SKEW_MS < tokenState.expiresAt)) {
    return tokenState.accessToken;
  }
  return refreshGoogleAccessToken(options);
}

export async function googleAuthFetch(url, options = {}) {
  const { fetchImpl = globalThis.fetch, ...requestOptions } = options;
  const accessToken = await googleAccessToken({ fetchImpl });
  const headers = new Headers(requestOptions.headers || {});
  headers.set("Authorization", `Bearer ${accessToken}`);
  return fetchImpl(url, {
    ...requestOptions,
    headers
  });
}

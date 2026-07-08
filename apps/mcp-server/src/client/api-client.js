import { resolveApiBaseUrl } from "../config.js";
import { isLoopbackHost } from "../../../rag-api/src/security.js";
import { redactString } from "../sanitize/redact.js";

export class ApiClientError extends Error {
  constructor(code, message, status = 0) {
    super(message);
    this.name = "ApiClientError";
    this.code = code;
    this.status = status;
  }
}

function assertLoopbackUrl(urlString) {
  const parsed = new URL(urlString);
  if (!isLoopbackHost(parsed.hostname)) {
    throw new ApiClientError("LOOPBACK_REQUIRED", "API requests are allowed only to loopback hosts");
  }
  return parsed;
}

function buildHeaders(authToken) {
  const headers = { Accept: "application/json" };
  if (authToken) {
    headers.Authorization = `Bearer ${authToken}`;
  }
  return headers;
}

function sanitizeErrorMessage(message = "", authToken = "") {
  let value = redactString(message);
  const token = String(authToken || "").trim();
  if (token && value.includes(token)) {
    value = value.split(token).join("[redacted]");
  }
  return value;
}

async function parseJsonResponse(response, authToken = "") {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    throw new ApiClientError(
      "INVALID_JSON",
      sanitizeErrorMessage(`API returned non-JSON response (HTTP ${response.status})`, authToken),
      response.status
    );
  }
}

export function createApiClient(config) {
  const baseUrl = resolveApiBaseUrl({ RAG_API_URL: config.apiBaseUrl });
  const authToken = String(config.authToken || "").trim();
  const timeoutMs = Number(config.requestTimeoutMs || 30_000);

  async function request(path, { method = "GET", query = {} } = {}) {
    const url = new URL(path, `${baseUrl}/`);
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined || value === null || value === "") continue;
      url.searchParams.set(key, String(value));
    }

    assertLoopbackUrl(url.toString());

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(url, {
        method,
        headers: buildHeaders(authToken),
        signal: controller.signal
      });

      const payload = await parseJsonResponse(response, authToken);
      if (!response.ok) {
        const message = sanitizeErrorMessage(
          payload?.error || payload?.message || `HTTP ${response.status}`,
          authToken
        );
        throw new ApiClientError("API_ERROR", message, response.status);
      }
      return payload;
    } catch (error) {
      if (error instanceof ApiClientError) throw error;
      if (error?.name === "AbortError") {
        throw new ApiClientError("TIMEOUT", `Request timed out after ${timeoutMs}ms`);
      }
      throw new ApiClientError(
        "NETWORK_ERROR",
        sanitizeErrorMessage(error?.message || "Network request failed", authToken)
      );
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    baseUrl,
    get(path, query) {
      return request(path, { method: "GET", query });
    }
  };
}

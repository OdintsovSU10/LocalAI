import assert from "node:assert/strict";
import test from "node:test";

import {
  createApiSecurityMiddleware,
  isAllowedApiOrigin,
  isLoopbackHost,
  readApiSecurityConfig,
  shouldWarnMissingAuthForHost,
  warnIfUnsafeNetworkBinding
} from "../apps/rag-api/src/security.js";

function runMiddleware(config, headers = {}, request = {}) {
  const middleware = createApiSecurityMiddleware(config);
  const result = {
    nextCalled: false,
    statusCode: 200,
    headers: {},
    body: null
  };
  const req = { method: "GET", path: "/test", headers, ...request };
  const res = {
    set(name, value) {
      result.headers[name] = value;
      return res;
    },
    status(code) {
      result.statusCode = code;
      return res;
    },
    json(body) {
      result.body = body;
      return result;
    }
  };

  middleware(req, res, () => {
    result.nextCalled = true;
  });

  return result;
}

test("readApiSecurityConfig requires auth when token is configured", () => {
  assert.deepEqual(readApiSecurityConfig({ RAG_AUTH_TOKEN: "secret" }), {
    authToken: "secret",
    requireAuth: true
  });
});

test("API security allows requests without auth when auth is not configured", () => {
  const result = runMiddleware({ authToken: "", requireAuth: false });

  assert.equal(result.nextCalled, true);
  assert.equal(result.statusCode, 200);
});

test("API security requires Bearer token when token is configured", () => {
  const missing = runMiddleware({ authToken: "secret", requireAuth: true });
  const wrong = runMiddleware({ authToken: "secret", requireAuth: true }, {
    authorization: "Bearer wrong"
  });
  const ok = runMiddleware({ authToken: "secret", requireAuth: true }, {
    authorization: "Bearer secret"
  });

  assert.equal(missing.statusCode, 401);
  assert.equal(wrong.statusCode, 401);
  assert.equal(ok.nextCalled, true);
});

test("API security allows only Google OAuth callback without Bearer", () => {
  const callback = runMiddleware({ authToken: "secret", requireAuth: true }, {}, {
    method: "GET",
    path: "/google/auth/callback"
  });
  const start = runMiddleware({ authToken: "secret", requireAuth: true }, {}, {
    method: "POST",
    path: "/google/auth/start"
  });

  assert.equal(callback.nextCalled, true);
  assert.equal(start.statusCode, 401);
});

test("API security lets the Dify adapter endpoint use its own Bearer token", () => {
  const result = runMiddleware({ authToken: "rag-token", requireAuth: true }, {
    authorization: "Bearer dify-adapter-token"
  }, {
    method: "POST",
    path: "/dify/retrieval"
  });

  assert.equal(result.nextCalled, true);
  assert.equal(result.statusCode, 200);
});

test("API security rejects dangerous browser origins", () => {
  const blocked = runMiddleware({ authToken: "secret", requireAuth: true }, {
    origin: "https://evil.example",
    authorization: "Bearer secret"
  });
  const allowed = runMiddleware({ authToken: "secret", requireAuth: true }, {
    origin: "http://127.0.0.1:8787",
    authorization: "Bearer secret"
  });

  assert.equal(blocked.statusCode, 403);
  assert.equal(allowed.nextCalled, true);
});

test("API security returns misconfigured status when auth is required without token", () => {
  const result = runMiddleware({ authToken: "", requireAuth: true });

  assert.equal(result.statusCode, 503);
  assert.match(result.body.error, /RAG_AUTH_TOKEN/);
});

test("loopback and origin helpers allow only local browser origins", () => {
  assert.equal(isLoopbackHost("localhost"), true);
  assert.equal(isLoopbackHost("127.0.0.1"), true);
  assert.equal(isLoopbackHost("0.0.0.0"), false);
  assert.equal(isAllowedApiOrigin("http://localhost:8787"), true);
  assert.equal(isAllowedApiOrigin("http://[::1]:8787"), true);
  assert.equal(isAllowedApiOrigin("http://192.168.1.10:8787"), false);
  assert.equal(isAllowedApiOrigin(""), true);
});

test("non-loopback host warning does not include token values", () => {
  const messages = [];
  const logger = { warn: (message) => messages.push(message) };

  assert.equal(shouldWarnMissingAuthForHost("0.0.0.0", { authToken: "" }), true);
  assert.equal(warnIfUnsafeNetworkBinding("0.0.0.0", { authToken: "" }, logger), true);
  assert.equal(warnIfUnsafeNetworkBinding("0.0.0.0", { authToken: "secret-token" }, logger), false);
  assert.equal(messages.some((message) => message.includes("secret-token")), false);
});

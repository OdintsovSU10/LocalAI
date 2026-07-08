import assert from "node:assert/strict";
import test from "node:test";

const previousEnv = {
  RAG_GOOGLE_OAUTH_CLIENT_ID: process.env.RAG_GOOGLE_OAUTH_CLIENT_ID,
  RAG_GOOGLE_OAUTH_CLIENT_SECRET: process.env.RAG_GOOGLE_OAUTH_CLIENT_SECRET,
  RAG_GOOGLE_OAUTH_REFRESH_TOKEN: process.env.RAG_GOOGLE_OAUTH_REFRESH_TOKEN,
  RAG_GOOGLE_OAUTH_ACCESS_TOKEN: process.env.RAG_GOOGLE_OAUTH_ACCESS_TOKEN,
  RAG_GOOGLE_OAUTH_EMAIL: process.env.RAG_GOOGLE_OAUTH_EMAIL,
  RAG_PORT: process.env.RAG_PORT
};

process.env.RAG_GOOGLE_OAUTH_CLIENT_ID = "google-client-id";
delete process.env.RAG_GOOGLE_OAUTH_CLIENT_SECRET;
delete process.env.RAG_GOOGLE_OAUTH_REFRESH_TOKEN;
delete process.env.RAG_GOOGLE_OAUTH_ACCESS_TOKEN;
delete process.env.RAG_GOOGLE_OAUTH_EMAIL;
process.env.RAG_PORT = "8787";

const { googleAuthPublicStatus, startGoogleAuth } = await import("../apps/rag-api/src/google-auth.js?google-auth-test");

for (const [key, value] of Object.entries(previousEnv)) {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

test("googleAuthPublicStatus exposes configuration without tokens", () => {
  const status = googleAuthPublicStatus({ RAG_GOOGLE_OAUTH_CLIENT_ID: "google-client-id" });
  const serialized = JSON.stringify(status);

  assert.equal(status.configured, true);
  assert.equal(status.authorized, false);
  assert.equal(serialized.includes("refresh_token"), false);
  assert.equal(serialized.includes("access_token"), false);
});

test("startGoogleAuth builds a PKCE Google login URL", () => {
  const started = startGoogleAuth({
    env: {
      RAG_GOOGLE_OAUTH_CLIENT_ID: "google-client-id",
      RAG_GOOGLE_OAUTH_REDIRECT_URI: "http://127.0.0.1:8787/api/google/auth/callback"
    }
  });
  const url = new URL(started.authUrl);

  assert.equal(url.hostname, "accounts.google.com");
  assert.equal(url.searchParams.get("client_id"), "google-client-id");
  assert.equal(url.searchParams.get("redirect_uri"), "http://127.0.0.1:8787/api/google/auth/callback");
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.match(url.searchParams.get("scope"), /spreadsheets\.readonly/);
  assert.match(url.searchParams.get("scope"), /drive\.readonly/);
});

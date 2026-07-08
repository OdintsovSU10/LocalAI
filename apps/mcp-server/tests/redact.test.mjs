import assert from "node:assert/strict";
import test from "node:test";

import {
  maskPathValue,
  redactApiKeys,
  redactBearer,
  redactHomePaths,
  redactQueryTokensInUrl,
  redactString,
  redactUrlUserinfo,
  sanitizeValue
} from "../src/sanitize/redact.js";

test("redactBearer masks bearer tokens", () => {
  const input = "Authorization: Bearer secret-token-123";
  assert.match(redactBearer(input), /Bearer \[redacted\]/);
  assert.doesNotMatch(redactBearer(input), /secret-token-123/);
});

test("redactApiKeys masks api key assignments", () => {
  const input = 'apiKey="super-secret"';
  assert.match(redactApiKeys(input), /apiKey=\[redacted\]/);
});

test("redactUrlUserinfo masks credentials in URLs", () => {
  const input = "https://user:pass@127.0.0.1:6333/collections";
  assert.match(redactUrlUserinfo(input), /\/\/\[redacted\]@/);
  assert.doesNotMatch(redactUrlUserinfo(input), /user:pass/);
});

test("redactQueryTokensInUrl masks private query tokens and Google doc ids", () => {
  const query = "https://docs.google.com/document/d/abc123XYZ/edit?id=secret-id&token=abc";
  const redacted = redactQueryTokensInUrl(query);
  assert.match(redacted, /\/d\/\[redacted\]/);
  assert.match(redacted, /id=\[redacted\]/);
  assert.match(redacted, /token=\[redacted\]/);
});

test("redactHomePaths masks user home directory", () => {
  const home = process.env.USERPROFILE || process.env.HOME || "";
  if (!home) return;
  const input = `${home}\\Projects\\LocalAI\\data\\state`;
  const redacted = redactHomePaths(input);
  assert.match(redacted, /\[home\]/);
  assert.doesNotMatch(redacted, new RegExp(home.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("sanitizeValue redacts nested secrets and masks optional paths", () => {
  const value = sanitizeValue({
    apiKey: "secret",
    path: "C:\\Users\\demo\\file.pdf",
    nested: { token: "abc", message: "Bearer xyz" }
  }, { maskPaths: true });

  assert.equal(value.apiKey, "[redacted]");
  assert.equal(value.nested.token, "[redacted]");
  assert.match(value.nested.message, /Bearer \[redacted\]/);
  assert.match(value.path, /file\.pdf#/);
});

test("maskPathValue keeps basename and hash", () => {
  const masked = maskPathValue("C:\\secret\\contracts\\deal.pdf");
  assert.equal(masked.startsWith("deal.pdf#"), true);
});

test("redactString applies full sanitization chain", () => {
  const input = "Bearer abc api_key=xyz https://x:y@host/?token=zzz";
  const output = redactString(input);
  assert.match(output, /Bearer \[redacted\]/);
  assert.match(output, /apiKey=\[redacted\]/i);
  assert.match(output, /token=\[redacted\]/);
});

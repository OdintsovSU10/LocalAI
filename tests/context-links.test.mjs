import assert from "node:assert/strict";
import test from "node:test";

import {
  extractGoogleDocumentTitle,
  fetchGoogleContextTitle,
  normalizeContextLink,
  resolveContextLinkTitle
} from "../apps/rag-api/src/context-links.js";

function htmlResponse(html, { status = 200, contentType = "text/html; charset=utf-8", location = "" } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get(name) {
        const key = String(name || "").toLowerCase();
        if (key === "content-type") return contentType;
        if (key === "location") return location;
        return "";
      }
    },
    text: async () => html
  };
}

test("extractGoogleDocumentTitle prefers Google metadata title", () => {
  const title = extractGoogleDocumentTitle(`
    <html>
      <head>
        <meta property="og:title" content="Форма Вопрос-ответ">
        <title>Ignored - Google Sheets</title>
      </head>
    </html>
  `);

  assert.equal(title, "Форма Вопрос-ответ");
});

test("extractGoogleDocumentTitle removes Google product suffixes", () => {
  assert.equal(
    extractGoogleDocumentTitle("<title>Форма Вопрос-ответ - Google Sheets</title>"),
    "Форма Вопрос-ответ"
  );
});

test("resolveContextLinkTitle fills missing title from Google HTML", async () => {
  const input = {
    kind: "auto",
    url: "https://docs.google.com/spreadsheets/d/test-id/edit?usp=drive_link"
  };
  const output = await resolveContextLinkTitle(input, {
    fetchImpl: async () => htmlResponse("<title>Форма Вопрос-ответ - Google Sheets</title>")
  });

  assert.equal(output.title, "Форма Вопрос-ответ");
  assert.equal(normalizeContextLink(output).kind, "sheet");
});

test("fetchGoogleContextTitle does not fetch non-Google URLs", async () => {
  let calls = 0;
  const title = await fetchGoogleContextTitle("https://example.test/document", {
    fetchImpl: async () => {
      calls += 1;
      return htmlResponse("<title>Example</title>");
    }
  });

  assert.equal(title, "");
  assert.equal(calls, 0);
});

test("normalizeContextLink uses Google kind fallback instead of hostname", () => {
  const link = normalizeContextLink({
    url: "https://docs.google.com/spreadsheets/d/test-id/edit?usp=drive_link",
    kind: "auto"
  });

  assert.equal(link.title, "Google Sheet");
  assert.equal(link.kind, "sheet");
});

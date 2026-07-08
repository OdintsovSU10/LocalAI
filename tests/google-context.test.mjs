import assert from "node:assert/strict";
import test from "node:test";

import {
  fetchGoogleContextMarkdown,
  googleContextExportTarget,
  googleContextVirtualPath,
  parseCsv,
  sanitizeGoogleContextTitle
} from "../apps/rag-api/src/google-context.js";

function textResponse(text, { status = 200, contentType = "text/plain; charset=utf-8", contentDisposition = "" } = {}) {
  const buffer = new TextEncoder().encode(text).buffer;
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get(name) {
        const key = String(name || "").toLowerCase();
        if (key === "content-type") return contentType;
        if (key === "content-length") return String(buffer.byteLength);
        if (key === "content-disposition") return contentDisposition;
        return "";
      }
    },
    arrayBuffer: async () => buffer
  };
}

function jsonResponse(payload, options = {}) {
  return textResponse(JSON.stringify(payload), { contentType: "application/json; charset=utf-8", ...options });
}

test("googleContextExportTarget builds public Google Docs export URL", () => {
  const target = googleContextExportTarget({
    url: "https://docs.google.com/document/d/doc-id/edit?usp=sharing"
  });

  assert.equal(target.kind, "doc");
  assert.equal(target.documentType, "gdoc");
  assert.equal(target.exportUrl, "https://docs.google.com/document/d/doc-id/export?format=txt");
});

test("googleContextExportTarget preserves Google Sheet gid hash and resource key", () => {
  const target = googleContextExportTarget({
    url: "https://docs.google.com/spreadsheets/d/sheet-id/edit?resourcekey=resource-key#gid=42"
  });

  assert.equal(target.kind, "sheet");
  assert.equal(
    target.exportUrl,
    "https://docs.google.com/spreadsheets/d/sheet-id/export?format=csv&gid=42&resourcekey=resource-key"
  );
});

test("googleContextExportTarget preserves Google Drive resource key", () => {
  const target = googleContextExportTarget({
    url: "https://drive.google.com/file/d/file-id/view?resourcekey=resource-key"
  });

  assert.equal(target.kind, "drive-file");
  assert.equal(
    target.exportUrl,
    "https://drive.google.com/uc?export=download&id=file-id&resourcekey=resource-key"
  );
});

test("fetchGoogleContextMarkdown converts public Google Drive text file", async () => {
  const result = await fetchGoogleContextMarkdown({
    title: "Drive notes",
    url: "https://drive.google.com/file/d/file-id/view",
    kind: "link"
  }, {
    fetchImpl: async (url) => {
      assert.match(url, /drive\.google\.com\/uc\?export=download&id=file-id/);
      return textResponse("Drive file mentions payment deadline and project budget.", {
        contentType: "text/plain; charset=utf-8",
        contentDisposition: "attachment; filename=\"drive-notes.txt\""
      });
    }
  });

  assert.equal(result.ok, true);
  assert.equal(result.extension, ".txt");
  assert.equal(result.documentType, "txt");
  assert.match(result.recognition.method, /^google-drive-/);
  assert.match(result.markdown, /payment deadline/);
});

test("fetchGoogleContextMarkdown converts Google Sheet CSV to searchable markdown", async () => {
  const link = {
    title: "Форма Вопрос-ответ",
    url: "https://docs.google.com/spreadsheets/d/sheet-id/edit?gid=42#gid=42",
    kind: "sheet"
  };
  const result = await fetchGoogleContextMarkdown(link, {
    fetchImpl: async (url) => {
      assert.match(url, /format=csv/);
      assert.match(url, /gid=42/);
      return textResponse("Вопрос,Ответ\nЦена,12345\nСрок,\"10 дней\"");
    }
  });

  assert.equal(result.ok, true);
  assert.equal(result.documentType, "gsheet");
  assert.match(result.markdown, /# Форма Вопрос-ответ/);
  assert.match(result.markdown, /\| 2 \| Цена \| 12345 \|/);
});

test("fetchGoogleContextMarkdown uses Google Sheets API when auth fetch is available", async () => {
  const link = {
    title: "Private Q&A",
    url: "https://docs.google.com/spreadsheets/d/sheet-id/edit#gid=42",
    kind: "sheet"
  };
  const calls = [];
  const result = await fetchGoogleContextMarkdown(link, {
    fetchImpl: async () => {
      throw new Error("public export should not be used");
    },
    authFetchImpl: async (url) => {
      calls.push(url);
      if (String(url).includes("/values/")) {
        return jsonResponse({
          values: [
            ["Question", "Answer"],
            ["Price", "12345"]
          ]
        });
      }
      return jsonResponse({
        properties: { title: "Private Sheet" },
        sheets: [
          { properties: { sheetId: 1, title: "Other" } },
          { properties: { sheetId: 42, title: "Answers" } }
        ]
      });
    }
  });

  assert.equal(result.ok, true);
  assert.equal(result.recognition.method, "google-sheet-api");
  assert.equal(result.recognition.sheetTitle, "Answers");
  assert.equal(calls.length, 2);
  assert.match(result.markdown, /\| 2 \| Price \| 12345 \|/);
});

test("fetchGoogleContextMarkdown rejects unsupported Google context links without fetching", async () => {
  let calls = 0;
  const result = await fetchGoogleContextMarkdown({
    title: "Drive folder",
    url: "https://drive.google.com/drive/folders/folder-id",
    kind: "link"
  }, {
    fetchImpl: async () => {
      calls += 1;
      return textResponse("ignored");
    }
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, "unsupported_google_context_link");
  assert.equal(calls, 0);
});

test("parseCsv handles quoted commas and escaped quotes", () => {
  assert.deepEqual(parseCsv("A,B\n\"one, two\",\"say \"\"hi\"\"\""), [
    ["A", "B"],
    ["one, two", "say \"hi\""]
  ]);
});

test("googleContextVirtualPath uses a safe synthetic path", () => {
  const title = sanitizeGoogleContextTitle("Q/A: План / бюджет?");
  assert.equal(title, "Q A План бюджет");
  assert.equal(
    googleContextVirtualPath({ title }, ".gsheet"),
    "Google context/Q A План бюджет.gsheet"
  );
});

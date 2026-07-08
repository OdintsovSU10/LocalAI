import assert from "node:assert/strict";
import test from "node:test";

import {
  buildSpreadsheetContextLinks,
  classifyGoogleDriveUrl,
  contextLinkDedupKey,
  matchDriveNameToSource,
  parseDriveFolderId,
  spreadsheetContextUrl
} from "../apps/rag-api/src/google-drive-match.js";
import {
  applyContextLinkPlan,
  planContextLinkUpdates
} from "../apps/rag-api/src/google-discovery-sync.js";

const sources = [
  { id: "solar", title: "ЖК Солнечный", path: "D:\\Projects\\Solar" },
  { id: "north", title: "Северный квартал", path: "D:\\Projects\\North" }
];

test("parseDriveFolderId extracts folder id from Drive URL", () => {
  assert.equal(
    parseDriveFolderId("https://drive.google.com/drive/u/0/folders/abc123?q=shared"),
    "abc123"
  );
});

test("classifyGoogleDriveUrl detects spreadsheets, folders and docs", () => {
  assert.equal(classifyGoogleDriveUrl("https://docs.google.com/spreadsheets/d/abc/edit"), "spreadsheet");
  assert.equal(classifyGoogleDriveUrl("https://docs.google.com/document/d/abc/edit"), "document");
  assert.equal(classifyGoogleDriveUrl("https://drive.google.com/drive/folders/abc"), "folder");
  assert.equal(classifyGoogleDriveUrl("https://drive.google.com/file/d/abc/view"), "drive-file");
});

test("matchDriveNameToSource matches folder name to project title", () => {
  const match = matchDriveNameToSource("Солнечный — рабочие таблицы", sources);
  assert.equal(match.source?.id, "solar");
  assert.equal(match.confident, true);
});

test("matchDriveNameToSource rejects ambiguous folder names", () => {
  const match = matchDriveNameToSource("общие документы", sources, { requireConfident: true });
  assert.equal(match.source, null);
});

test("buildSpreadsheetContextLinks creates one link for single-tab sheet", () => {
  const links = buildSpreadsheetContextLinks("sheet-id", {
    title: "КП Солнечный",
    tabs: [{ gid: "0", title: "Лист1" }]
  });
  assert.equal(links.length, 1);
  assert.match(links[0].url, /gid=0/);
  assert.equal(links[0].title, "КП Солнечный");
});

test("buildSpreadsheetContextLinks creates links for each sheet tab", () => {
  const links = buildSpreadsheetContextLinks("sheet-id", {
    title: "Смета",
    tabs: [
      { gid: "0", title: "Свод" },
      { gid: "123", title: "Детализация" }
    ]
  });
  assert.equal(links.length, 2);
  assert.equal(links[0].title, "Смета — Свод");
  assert.equal(links[1].title, "Смета — Детализация");
});

test("contextLinkDedupKey treats different sheet gids as different links", () => {
  const first = contextLinkDedupKey(spreadsheetContextUrl("sheet-id", { gid: "0" }));
  const second = contextLinkDedupKey(spreadsheetContextUrl("sheet-id", { gid: "123" }));
  assert.notEqual(first, second);
});

test("planContextLinkUpdates skips already registered links", () => {
  const existingSources = [{
    id: "solar",
    title: "ЖК Солнечный",
    path: "D:\\Projects\\Solar",
    contextLinks: [{
      id: "ctx-1",
      title: "КП",
      url: spreadsheetContextUrl("sheet-id"),
      kind: "sheet",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z"
    }]
  }];

  const plan = planContextLinkUpdates(existingSources, [{
    sourceId: "solar",
    folderName: "Солнечный",
    links: [{
      title: "КП",
      url: spreadsheetContextUrl("sheet-id"),
      kind: "sheet"
    }, {
      title: "Договор",
      url: "https://docs.google.com/document/d/doc-id/edit",
      kind: "doc"
    }]
  }]);

  assert.equal(plan[0].added.length, 1);
  assert.equal(plan[0].skipped.length, 1);
});

test("applyContextLinkPlan appends new context links to source", async () => {
  const mutableSources = [{
    id: "solar",
    title: "ЖК Солнечный",
    path: "D:\\Projects\\Solar",
    contextLinks: []
  }];

  const plan = planContextLinkUpdates(mutableSources, [{
    sourceId: "solar",
    folderName: "Солнечный",
    links: [{
      title: "КП",
      url: spreadsheetContextUrl("sheet-id"),
      kind: "sheet"
    }]
  }]);

  const results = await applyContextLinkPlan(mutableSources, plan, {
    resolveTitle: async (input) => input
  });

  assert.equal(results[0].applied, 1);
  assert.equal(mutableSources[0].contextLinks.length, 1);
  assert.equal(mutableSources[0].contextLinks[0].kind, "sheet");
});

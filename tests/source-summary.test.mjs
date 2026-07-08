import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { buildSourceSummary } from "../apps/rag-api/src/source-summary.js";

test("buildSourceSummary creates deterministic project metadata", () => {
  const source = {
    id: "source-summary-test",
    title: "Тестовый проект",
    path: path.join("C:", "work", "source")
  };
  const manifest = {
    files: {
      pdf1: {
        fileId: "pdf1",
        sourceId: source.id,
        sourceTitle: source.title,
        path: path.join(source.path, "Договор.pdf"),
        quality: {
          status: "warning",
          score: 72,
          chunks: 2,
          warnings: ["ocr_limited", "low_ocr_confidence"]
        },
        recognition: { method: "ocr", ocrLimited: true }
      },
      md1: {
        fileId: "md1",
        sourceId: source.id,
        sourceTitle: source.title,
        path: path.join(source.path, "README.md"),
        quality: {
          status: "ok",
          score: 100,
          chunks: 1,
          warnings: []
        },
        recognition: { method: "text" }
      },
      pdf2: {
        fileId: "pdf2",
        sourceId: "other-source",
        path: path.join(source.path, "Other.pdf"),
        quality: { status: "ok", chunks: 5, warnings: [] }
      }
    }
  };
  const chunks = [
    { id: "pdf1:0", sourceId: source.id, text: "Первый фрагмент" },
    { id: "pdf1:1", sourceId: source.id, text: "Второй фрагмент" },
    { id: "md1:0", sourceId: source.id, text: "Третий фрагмент" },
    { id: "pdf2:0", sourceId: "other-source", text: "Чужой фрагмент" }
  ];

  const summary = buildSourceSummary({
    source,
    manifest,
    chunks,
    now: new Date("2026-06-29T10:00:00.000Z")
  });

  assert.equal(summary.sourceId, source.id);
  assert.equal(summary.sourceTitle, source.title);
  assert.equal(summary.updatedAt, "2026-06-29T10:00:00.000Z");
  assert.equal(summary.fileCount, 2);
  assert.equal(summary.chunkCount, 3);
  assert.deepEqual(summary.topFileTypes, [
    { extension: ".md", count: 1 },
    { extension: ".pdf", count: 1 }
  ]);
  assert.equal(summary.qualityWarnings.total, 2);
  assert.deepEqual(summary.qualityWarnings.byWarning, [
    { warning: "low_ocr_confidence", count: 1 },
    { warning: "ocr_limited", count: 1 }
  ]);
  assert.equal(summary.qualityWarnings.files.length, 1);
  assert.equal(summary.qualityWarnings.files[0].title, "Договор.pdf");
  assert.match(summary.deterministicSummary, /2 files, 3 chunks/);
  assert.equal(Object.hasOwn(summary, "llmSummary"), false);
});

test("buildSourceSummary falls back to manifest chunk counts", () => {
  const summary = buildSourceSummary({
    source: { id: "manifest-only", title: "Manifest Only" },
    manifest: {
      files: {
        one: { sourceId: "manifest-only", path: "one.txt", quality: { chunks: 4, warnings: [] } },
        two: { sourceId: "manifest-only", path: "two.txt", quality: { chunks: 2, warnings: [] } }
      }
    },
    chunks: [],
    now: "2026-06-29T11:00:00.000Z"
  });

  assert.equal(summary.fileCount, 2);
  assert.equal(summary.chunkCount, 6);
  assert.equal(summary.qualityWarnings.total, 0);
});

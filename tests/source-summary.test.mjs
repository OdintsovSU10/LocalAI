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
          chars: 240,
          words: 32,
          warnings: ["ocr_limited", "low_ocr_confidence"]
        },
        recognition: {
          method: "ocr",
          ocrLimited: true,
          ocrPages: 2,
          ocrRecognizedPages: 2,
          ocrTotalPages: 4,
          ocrConfidence: 42,
          ocrConfidenceP10: 31,
          ocrLowConfidencePages: [1],
          ocrEmptyPages: [4]
        },
        reindex: {
          retried: true,
          status: "resolved",
          reasons: ["no_chunks"],
          finalReasons: [],
          improved: true
        }
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
          chars: 480,
          words: 76,
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
  assert.deepEqual(summary.recognitionQuality.files, {
    total: 2,
    searchable: 2,
    ok: 1,
    warning: 1,
    error: 0,
    unchecked: 0,
    withText: 2,
    textCoveragePercent: 100
  });
  assert.equal(summary.recognitionQuality.status, "warning");
  assert.equal(summary.recognitionQuality.score, 86);
  assert.deepEqual(summary.recognitionQuality.text, {
    totalChars: 720,
    totalWords: 108,
    avgChars: 360,
    avgWords: 54
  });
  assert.deepEqual(summary.recognitionQuality.ocr, {
    files: 1,
    pages: 2,
    totalPages: 4,
    coveragePercent: 50,
    avgConfidence: 42,
    confidenceP10: 31,
    limitedFiles: 1,
    lowConfidenceFiles: 1,
    lowConfidencePages: 1,
    emptyPages: 1
  });
  assert.equal(summary.qualityWarnings.files.length, 1);
  assert.equal(summary.qualityWarnings.files[0].title, "Договор.pdf");
  assert.equal(summary.reindex.retriedFiles, 1);
  assert.equal(summary.reindex.resolvedFiles, 1);
  assert.deepEqual(summary.reindex.byReason, [{ reason: "no_chunks", count: 1 }]);
  assert.equal(summary.reindex.files[0].status, "resolved");
  assert.equal(summary.reindex.files[0].improved, true);
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
  assert.equal(summary.recognitionQuality.status, "warning");
  assert.equal(summary.recognitionQuality.score, 80);
  assert.equal(summary.recognitionQuality.files.searchable, 2);
});

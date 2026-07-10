import assert from "node:assert/strict";
import test from "node:test";

import {
  allSourcesIndexEntries,
  indexedEntriesForSource,
  indexedSnapshotForSource,
  indexProgressHealth,
  indexSourceIdsForSources,
  mergeIndexedSnapshotStatus,
  sourceForIndexEntry
} from "../apps/rag-api/src/index-status.js";

test("indexedSnapshotForSource recovers stale manifest entries by source path", () => {
  const source = {
    id: "source-current",
    title: "Current",
    path: "C:\\Projects\\Current"
  };
  const manifest = {
    files: {
      stale: {
        fileId: "stale",
        sourceId: "source-old",
        path: "C:\\Projects\\Current\\contract.pdf",
        indexedAt: "2026-07-01T10:00:00.000Z",
        quality: { chunks: 3, status: "ok" }
      }
    }
  };

  const snapshot = indexedSnapshotForSource(source, manifest, {
    currentSourceIds: new Set([source.id])
  });
  const status = mergeIndexedSnapshotStatus({ status: "not_indexed" }, snapshot);

  assert.equal(snapshot.files, 1);
  assert.equal(snapshot.chunks, 3);
  assert.equal(status.status, "completed");
  assert.equal(status.indexedFiles, 1);
});

test("allSourcesIndexEntries does not steal entries owned by another current source", () => {
  const parent = { id: "source-parent", title: "Parent", path: "C:\\Projects" };
  const child = { id: "source-child", title: "Child", path: "C:\\Projects\\Child" };
  const manifest = {
    files: {
      childFile: {
        fileId: "childFile",
        sourceId: child.id,
        path: "C:\\Projects\\Child\\doc.pdf",
        quality: { chunks: 2, status: "ok" }
      }
    }
  };

  const parentEntries = indexedEntriesForSource(parent, manifest, {
    currentSourceIds: new Set([parent.id, child.id])
  });
  const allEntries = allSourcesIndexEntries([parent, child], manifest);

  assert.equal(parentEntries.length, 0);
  assert.equal(allEntries.length, 1);
  assert.equal(sourceForIndexEntry([parent, child], manifest.files.childFile).id, child.id);
});

test("indexSourceIdsForSources includes stale ids needed by scoped search", () => {
  const source = {
    id: "source-current",
    path: "C:\\Projects\\Current"
  };
  const manifest = {
    files: {
      stale: {
        fileId: "stale",
        sourceId: "source-old",
        path: "C:\\Projects\\Current\\contract.pdf",
        quality: { chunks: 1 }
      }
    }
  };

  assert.deepEqual(indexSourceIdsForSources([source], manifest), ["source-current", "source-old"]);
});

test("indexProgressHealth reports active, stale and interrupted running jobs", () => {
  const now = new Date("2026-07-10T10:05:00.000Z");
  const recent = indexProgressHealth({
    id: "job-active",
    status: "running",
    updatedAt: "2026-07-10T10:04:30.000Z"
  }, {
    alive: true,
    now,
    staleAfterMs: 120_000
  });
  const stale = indexProgressHealth({
    id: "job-stale",
    status: "running",
    updatedAt: "2026-07-10T10:00:00.000Z"
  }, {
    alive: true,
    now,
    staleAfterMs: 120_000
  });
  const interrupted = indexProgressHealth({
    id: "job-missing",
    status: "running",
    updatedAt: "2026-07-10T10:04:30.000Z"
  }, {
    alive: false,
    now,
    staleAfterMs: 120_000
  });

  assert.equal(recent.status, "active");
  assert.equal(recent.stale, false);
  assert.equal(stale.status, "stale");
  assert.equal(stale.code, "no_recent_progress");
  assert.equal(interrupted.status, "interrupted");
  assert.equal(interrupted.code, "process_missing");
});

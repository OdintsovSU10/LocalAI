import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import {
  defaultDataDir,
  isLegacyDefaultDataDir,
  projectRoot,
  resolveDataDirSetting
} from "../apps/rag-api/src/paths.js";

test("defaultDataDir points LOCAL_RAG storage at D drive", () => {
  assert.equal(defaultDataDir(), path.resolve("D:\\LOCAL_RAG\\data"));
});

test("resolveDataDirSetting maps empty and legacy defaults to D drive storage", () => {
  assert.equal(resolveDataDirSetting(""), defaultDataDir());
  assert.equal(resolveDataDirSetting(path.join(projectRoot, "data")), defaultDataDir());
  assert.equal(resolveDataDirSetting("C:\\Users\\demo\\Desktop\\LOCAL_RAG\\data"), defaultDataDir());
});

test("resolveDataDirSetting keeps explicit custom storage paths", () => {
  const custom = path.resolve("E:\\CustomRagStore");
  assert.equal(resolveDataDirSetting(custom), custom);
  assert.equal(isLegacyDefaultDataDir(custom), false);
});

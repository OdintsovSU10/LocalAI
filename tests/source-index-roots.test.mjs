import assert from "node:assert/strict";
import test from "node:test";

import { indexedRelativePath, indexRootsForSource } from "../apps/rag-api/src/source-index-roots.js";

test("indexRootsForSource includes primary and additional paths", () => {
  const roots = indexRootsForSource({
    path: "D:\\Projects\\Main",
    additionalPaths: [
      "G:\\Мой диск\\003 Тендеры 2025\\В работе\\279. ЖК Летная"
    ]
  });

  assert.equal(roots.length, 2);
  assert.match(roots[1], /279\. ЖК Летная/);
});

test("indexedRelativePath prefixes additional roots with folder label", () => {
  const source = {
    path: "D:\\Projects\\Main",
    additionalPaths: ["G:\\Мой диск\\003 Тендеры 2025\\В работе\\279. ЖК Летная"]
  };
  const root = indexRootsForSource(source)[1];
  const relative = indexedRelativePath(
    source,
    "G:\\Мой диск\\003 Тендеры 2025\\В работе\\279. ЖК Летная\\docs\\file.pdf",
    root
  );

  assert.equal(relative, "[279. ЖК Летная]/docs/file.pdf");
});

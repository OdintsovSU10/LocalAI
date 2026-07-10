import assert from "node:assert/strict";
import test from "node:test";

import { applySourcePatch } from "../apps/rag-api/src/source-updates.js";

const sources = [
  { id: "contract-a", title: "Договор A", path: "\\\\share\\A", sourceType: "contract" },
  { id: "contract-b", title: "Договор B", path: "\\\\share\\B" },
  { id: "tender-1", title: "256. Primavera", path: "G:\\tenders\\256", sourceType: "tender" }
];

test("applySourcePatch links tender source to contract", () => {
  const result = applySourcePatch(sources, "tender-1", { linkedContractId: "contract-a" });

  assert.equal(result.source.linkedContractId, "contract-a");
  assert.equal(result.sources.find((source) => source.id === "tender-1").linkedContractId, "contract-a");
  assert.match(result.source.updatedAt, /^\d{4}-\d{2}-\d{2}T/);
});

test("applySourcePatch renames source title", () => {
  const result = applySourcePatch(sources, "contract-a", { title: "Новый договор" });

  assert.equal(result.source.title, "Новый договор");
  assert.equal(result.sources.find((source) => source.id === "contract-a").title, "Новый договор");
  assert.match(result.source.updatedAt, /^\d{4}-\d{2}-\d{2}T/);
});

test("applySourcePatch updates additional source paths", () => {
  const result = applySourcePatch(sources, "contract-a", {
    additionalPaths: [
      "G:\\extra\\A",
      "G:\\extra\\A\\",
      "\\\\share\\A",
      "  ",
      "D:\\docs"
    ]
  });

  assert.deepEqual(result.source.additionalPaths, ["G:\\extra\\A", "D:\\docs"]);
  assert.match(result.source.updatedAt, /^\d{4}-\d{2}-\d{2}T/);
});

test("applySourcePatch clears additional source paths", () => {
  const result = applySourcePatch(
    sources.map((source) => source.id === "contract-a" ? { ...source, additionalPaths: ["D:\\docs"] } : source),
    "contract-a",
    { additionalPaths: [] }
  );

  assert.equal(result.source.additionalPaths, undefined);
});

test("applySourcePatch rejects non-array additional paths", () => {
  assert.throws(
    () => applySourcePatch(sources, "contract-a", { additionalPaths: "D:\\docs" }),
    { statusCode: 400 }
  );
});

test("applySourcePatch rejects empty source title", () => {
  assert.throws(
    () => applySourcePatch(sources, "contract-a", { title: "   " }),
    { statusCode: 400 }
  );
});

test("applySourcePatch clears tender source link", () => {
  const result = applySourcePatch(
    sources.map((source) => source.id === "tender-1" ? { ...source, linkedContractId: "contract-a" } : source),
    "tender-1",
    { linkedContractId: "" }
  );

  assert.equal(result.source.linkedContractId, "");
});

test("applySourcePatch rejects linkedContractId on contract source", () => {
  assert.throws(
    () => applySourcePatch(sources, "contract-a", { linkedContractId: "contract-b" }),
    { statusCode: 400 }
  );
});

test("applySourcePatch rejects missing linked contract", () => {
  assert.throws(
    () => applySourcePatch(sources, "tender-1", { linkedContractId: "missing-contract" }),
    { statusCode: 400 }
  );
});

test("applySourcePatch moves tender source to contract", () => {
  const result = applySourcePatch(
    sources.map((source) => source.id === "tender-1" ? { ...source, linkedContractId: "contract-a" } : source),
    "tender-1",
    { sourceType: "contract" }
  );

  assert.equal(result.source.sourceType, "contract");
  assert.equal(result.source.linkedContractId, undefined);
  assert.equal(result.sources.find((source) => source.id === "tender-1").sourceType, "contract");
  assert.match(result.source.updatedAt, /^\d{4}-\d{2}-\d{2}T/);
});

test("applySourcePatch rejects moving contract source to tender", () => {
  assert.throws(
    () => applySourcePatch(sources, "contract-a", { sourceType: "tender" }),
    { statusCode: 400 }
  );
});

test("applySourcePatch rejects unknown source type", () => {
  assert.throws(
    () => applySourcePatch(sources, "tender-1", { sourceType: "project" }),
    { statusCode: 400 }
  );
});

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

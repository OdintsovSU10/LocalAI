import assert from "node:assert/strict";
import test from "node:test";

import {
  contractSources,
  searchScopeSourceIds,
  tenderSources
} from "../apps/rag-api/src/source-scope.js";

const sources = [
  { id: "contract-a", title: "Договор A", path: "\\\\share\\A", sourceType: "contract" },
  { id: "tender-1", title: "279. Летная", path: "G:\\tenders\\279", sourceType: "tender", linkedContractId: "contract-a" },
  { id: "tender-2", title: "298. Сокольники", path: "G:\\tenders\\298", sourceType: "tender" },
  { id: "contract-b", title: "Договор B", path: "\\\\share\\B" }
];

test("contractSources and tenderSources split sources by type", () => {
  assert.equal(contractSources(sources).length, 2);
  assert.equal(tenderSources(sources).length, 2);
});

test("searchScopeSourceIds includes linked tender folders for a contract", () => {
  const contract = contractSources(sources)[0];
  assert.deepEqual(searchScopeSourceIds(contract, sources), ["contract-a", "tender-1"]);
});

test("searchScopeSourceIds for tender stays scoped to tender only", () => {
  const tender = tenderSources(sources)[1];
  assert.deepEqual(searchScopeSourceIds(tender, sources), ["tender-2"]);
});

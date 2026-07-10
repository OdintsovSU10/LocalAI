import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  normalizeTenderLinkMappings,
  planTenderSourceSync,
  scanTenderFolders
} from "../apps/rag-api/src/tender-sync.js";

test("normalizeTenderLinkMappings accepts folder and linkedContractId aliases", () => {
  const mappings = normalizeTenderLinkMappings({
    mappings: [
      { folder: "256. Primavera", linkedContractId: "contract-a" },
      { tenderFolder: "", contractId: "missing-folder" }
    ]
  });

  assert.deepEqual(mappings, [{
    tenderFolder: "256. Primavera",
    tenderPath: "",
    tenderId: "",
    contractId: "contract-a"
  }]);
});

test("scanTenderFolders reports missing Google Drive root", async () => {
  const missingRoot = path.join(os.tmpdir(), `localai-missing-tenders-${Date.now()}`);
  const result = await scanTenderFolders(missingRoot, ["Work"]);

  assert.deepEqual(result.folders, []);
  assert.equal(result.diagnostics.rootExists, false);
  assert.equal(result.diagnostics.categories[0].status, "not_checked");
});

test("planTenderSourceSync applies manual mappings before automatic matching", () => {
  const tenderPath = "G:\\tenders\\Завершенные\\256. Primavera K14 (Spartak)";
  const sources = [
    { id: "contract-a", title: "Спартак", path: "\\\\share\\Спартак", sourceType: "contract" },
    { id: "contract-b", title: "Primavera K14", path: "\\\\share\\Primavera", sourceType: "contract" },
    {
      id: "tender-existing",
      title: "256. Primavera K14 (Spartak)",
      path: tenderPath,
      sourceType: "tender",
      tenderCategory: "Завершенные",
      linkedContractId: "contract-a"
    }
  ];

  const result = planTenderSourceSync({
    sources,
    folders: [{
      category: "Завершенные",
      name: "256. Primavera K14 (Spartak)",
      path: tenderPath
    }],
    tenderRoot: "G:\\tenders",
    categories: ["Завершенные"],
    autoLinkCategories: ["Завершенные"],
    manualMappings: [{
      tenderFolder: "256. Primavera K14 (Spartak)",
      tenderPath: "",
      tenderId: "",
      contractId: "contract-b"
    }]
  });

  assert.equal(result.summary.totals.updated, 1);
  assert.equal(result.summary.totals.manualLinked, 1);
  assert.equal(result.summary.planned[0].linkedContractId, "contract-b");
  assert.equal(result.summary.planned[0].linkSource, "manual");
  assert.equal(result.nextSources.find((source) => source.id === "tender-existing").linkedContractId, "contract-b");
});

test("planTenderSourceSync reports unlinked tender outside auto-link categories", () => {
  const result = planTenderSourceSync({
    sources: [{ id: "contract-a", title: "Договор A", path: "\\\\share\\A" }],
    folders: [{
      category: "В работе",
      name: "298. Сокольники",
      path: "G:\\tenders\\В работе\\298. Сокольники"
    }],
    tenderRoot: "G:\\tenders",
    categories: ["В работе"],
    autoLinkCategories: ["Завершенные"],
    manualMappings: []
  });

  assert.equal(result.summary.totals.created, 1);
  assert.equal(result.summary.totals.unlinked, 1);
  assert.equal(result.summary.planned[0].linkSource, "none");
});

test("planTenderSourceSync marks the selected automatic link separately from candidates", () => {
  const tenderPath = "G:\\tenders\\Done\\261. Alpha Plaza";
  const result = planTenderSourceSync({
    sources: [
      { id: "contract-alpha-plaza", title: "Alpha Plaza", path: "\\\\share\\Alpha Plaza", sourceType: "contract" },
      { id: "contract-alpha-service", title: "Alpha Service", path: "\\\\share\\Alpha Service", sourceType: "contract" }
    ],
    folders: [{
      category: "Done",
      name: "261. Alpha Plaza",
      path: tenderPath
    }],
    tenderRoot: "G:\\tenders",
    categories: ["Done"],
    autoLinkCategories: ["Done"],
    manualMappings: []
  });

  const planned = result.summary.planned[0];
  assert.equal(planned.autoLinked, true);
  assert.equal(planned.linkedContractId, "contract-alpha-plaza");
  assert.equal(planned.selectedMatchCandidateId, "contract-alpha-plaza");
  assert.deepEqual(planned.matchCandidates.map((candidate) => candidate.id), ["contract-alpha-plaza", "contract-alpha-service"]);
});

test("planTenderSourceSync can apply a selected candidate link", () => {
  const tenderPath = "G:\\tenders\\Done\\261. Alpha Plaza";
  const result = planTenderSourceSync({
    sources: [
      { id: "contract-alpha-plaza", title: "Alpha Plaza", path: "\\\\share\\Alpha Plaza", sourceType: "contract" },
      { id: "contract-alpha-service", title: "Alpha Service", path: "\\\\share\\Alpha Service", sourceType: "contract" }
    ],
    folders: [{
      category: "Done",
      name: "261. Alpha Plaza",
      path: tenderPath
    }],
    tenderRoot: "G:\\tenders",
    categories: ["Done"],
    autoLinkCategories: ["Done"],
    manualMappings: [],
    selectedTenderLinks: [{ path: tenderPath, linkedContractId: "contract-alpha-service" }]
  });

  const planned = result.summary.planned[0];
  assert.equal(result.summary.totals.selectedLinked, 1);
  assert.equal(planned.linkedContractId, "contract-alpha-service");
  assert.equal(planned.linkSource, "selected");
  assert.equal(planned.selectedLinked, true);
  assert.equal(result.nextSources.find((source) => source.path === tenderPath).linkedContractId, "contract-alpha-service");
});

test("planTenderSourceSync can exclude selected automatic links", () => {
  const tenderPath = "G:\\tenders\\Done\\101. Alpha Plaza";
  const result = planTenderSourceSync({
    sources: [
      { id: "contract-alpha", title: "Alpha Plaza", path: "\\\\share\\Alpha Plaza", sourceType: "contract" },
      { id: "contract-beta", title: "Beta Tower", path: "\\\\share\\Beta Tower", sourceType: "contract" }
    ],
    folders: [{
      category: "Done",
      name: "101. Alpha Plaza",
      path: tenderPath
    }],
    tenderRoot: "G:\\tenders",
    categories: ["Done"],
    autoLinkCategories: ["Done"],
    manualMappings: [],
    excludedAutoLinks: [{ path: tenderPath, linkedContractId: "contract-alpha" }]
  });

  const planned = result.summary.planned[0];
  assert.equal(result.summary.totals.autoLinked, 0);
  assert.equal(result.summary.totals.autoLinkExcluded, 1);
  assert.equal(result.summary.totals.unlinked, 1);
  assert.equal(result.summary.totals.review, 1);
  assert.equal(planned.linkedContractId, "");
  assert.equal(planned.linkSource, "excluded-auto");
  assert.equal(planned.autoLinkExcluded, true);
  assert.equal(planned.matchCandidates[0].id, "contract-alpha");
  assert.equal(result.nextSources.find((source) => source.path === tenderPath).linkedContractId, "");
});

test("planTenderSourceSync can apply only unlinked tenders", () => {
  const unlinkedPath = "G:\\tenders\\Work\\Tender A";
  const linkedPath = "G:\\tenders\\Done\\Tender B";
  const result = planTenderSourceSync({
    sources: [{ id: "contract-a", title: "Contract A", path: "\\\\share\\A", sourceType: "contract" }],
    folders: [
      { category: "Work", name: "Tender A", path: unlinkedPath },
      { category: "Done", name: "Tender B", path: linkedPath }
    ],
    tenderRoot: "G:\\tenders",
    categories: ["Work", "Done"],
    autoLinkCategories: [],
    manualMappings: [{
      tenderFolder: "Tender B",
      tenderPath: "",
      tenderId: "",
      contractId: "contract-a"
    }],
    applyScope: "unlinked"
  });

  assert.equal(result.summary.applyScope, "unlinked");
  assert.equal(result.summary.totals.linked, 1);
  assert.equal(result.summary.totals.unlinkedReady, 1);
  assert.equal(result.summary.totals.applied, 1);
  assert.equal(result.summary.totals.scopeCreated, 1);
  assert.equal(result.summary.totals.scopeUpdated, 0);
  assert.ok(result.nextSources.some((source) => source.id === "contract-a"));
  assert.ok(result.nextSources.some((source) => source.path === unlinkedPath));
  assert.equal(result.nextSources.some((source) => source.path === linkedPath), false);
});

import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";
import { matchDriveNameToSource } from "./google-drive-match.js";
import { projectRoot } from "./paths.js";
import {
  SOURCE_TYPE_TENDER,
  contractSources,
  isTenderSource
} from "./source-scope.js";
import { readSources, writeSources } from "./store.js";

const DEFAULT_TENDER_ROOT = "G:\\Мой диск\\003 Тендеры 2025";
const DEFAULT_TENDER_CATEGORIES = ["В работе", "Завершенные", "Проиграли, отказ в участии"];
const DEFAULT_AUTO_LINK_CATEGORIES = ["Завершенные"];

const TENDER_SYNC_SCOPE_UNLINKED = "unlinked";

export const defaultTenderLinksPath = path.join(projectRoot, "config", "tender-links.yaml");

function normalizeTenderSyncScope(value = "") {
  return String(value || "").trim().toLowerCase() === TENDER_SYNC_SCOPE_UNLINKED
    ? TENDER_SYNC_SCOPE_UNLINKED
    : "all";
}

function tenderPlanNeedsReview(item = {}) {
  return Boolean(item.mappingError || (!item.linkedContractId && Array.isArray(item.matchCandidates) && item.matchCandidates.length));
}

function tenderPlanIsUnlinkedReady(item = {}) {
  return !item.linkedContractId && !tenderPlanNeedsReview(item);
}

function splitEnvList(value, fallback) {
  if (!value) return [...fallback];
  return String(value)
    .split("|")
    .map((item) => item.trim())
    .filter(Boolean);
}

export function tenderSyncOptionsFromEnv(env = process.env) {
  const categories = splitEnvList(env.RAG_TENDER_CATEGORIES, DEFAULT_TENDER_CATEGORIES);
  return {
    tenderRoot: String(env.RAG_TENDER_ROOT || DEFAULT_TENDER_ROOT).trim(),
    categories,
    autoLinkCategories: splitEnvList(env.RAG_TENDER_AUTO_LINK_CATEGORIES, DEFAULT_AUTO_LINK_CATEGORIES)
  };
}

export function tenderIdForPath(folderPath) {
  return `tender-${crypto.createHash("sha1").update(String(folderPath || "").toLowerCase()).digest("hex").slice(0, 10)}`;
}

function defaultInclude() {
  return ["**/*.pdf", "**/*.txt", "**/*.md", "**/*.csv", "**/*.docx", "**/*.xlsx", "**/*.xlsm", "**/*.xls"];
}

function defaultExclude() {
  return ["~$", "thumbs.db", ".ds_store", "desktop.ini"];
}

export async function listTenderFolders(root, categories = DEFAULT_TENDER_CATEGORIES) {
  const folders = [];
  for (const category of categories) {
    const categoryPath = path.join(root, category);
    let entries;
    try {
      entries = await fs.readdir(categoryPath, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name === "desktop.ini") continue;
      folders.push({
        category,
        name: entry.name,
        path: path.join(categoryPath, entry.name)
      });
    }
  }
  return folders;
}

function buildTenderSource(folder, existing = null) {
  const now = new Date().toISOString();
  const folderPath = folder.path;
  return {
    id: existing?.id || tenderIdForPath(folderPath),
    title: folder.name,
    path: folderPath,
    sourceType: SOURCE_TYPE_TENDER,
    tenderCategory: folder.category,
    linkedContractId: existing?.linkedContractId || "",
    include: existing?.include || defaultInclude(),
    exclude: existing?.exclude || defaultExclude(),
    contextLinks: Array.isArray(existing?.contextLinks) ? existing.contextLinks : [],
    createdAt: existing?.createdAt || now,
    updatedAt: now
  };
}

function normalizeMappingKey(value = "") {
  return String(value || "").trim().replace(/\\/g, "/").replace(/\s+/g, " ").toLowerCase();
}

function normalizeMappingPath(value = "") {
  const raw = String(value || "").trim();
  return raw ? path.resolve(raw).toLowerCase() : "";
}

export function normalizeTenderLinkMappings(input = {}) {
  const mappings = Array.isArray(input?.mappings) ? input.mappings : [];
  return mappings
    .map((item) => ({
      tenderFolder: String(item?.tenderFolder || item?.folder || "").trim(),
      tenderPath: String(item?.tenderPath || item?.path || "").trim(),
      tenderId: String(item?.tenderId || "").trim(),
      contractId: String(item?.contractId || item?.linkedContractId || "").trim()
    }))
    .filter((item) => item.contractId && (item.tenderFolder || item.tenderPath || item.tenderId));
}

export async function readTenderLinkMappings(filePath = defaultTenderLinksPath) {
  try {
    const text = await fs.readFile(filePath, "utf8");
    return normalizeTenderLinkMappings(YAML.parse(text) || {});
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
}

export function findTenderLinkMapping(folder, tender, mappings = []) {
  const folderName = normalizeMappingKey(folder.name);
  const folderWithCategory = normalizeMappingKey(`${folder.category}/${folder.name}`);
  const folderPath = normalizeMappingPath(folder.path);
  return mappings.find((mapping) => {
    if (mapping.tenderId && mapping.tenderId === tender.id) return true;
    if (mapping.tenderPath && normalizeMappingPath(mapping.tenderPath) === folderPath) return true;
    if (!mapping.tenderFolder) return false;
    const key = normalizeMappingKey(mapping.tenderFolder);
    return key === folderName || key === folderWithCategory;
  }) || null;
}

function resolveTenderLink({ tender, contracts, folder, autoLinkCategories, manualMappings }) {
  const manualMapping = findTenderLinkMapping(folder, tender, manualMappings);
  if (manualMapping) {
    const linkedContract = contracts.find((source) => source.id === manualMapping.contractId);
    if (linkedContract) {
      return {
        linkedContractId: linkedContract.id,
        linkSource: "manual",
        manualLinked: true,
        autoLinked: false,
        match: null,
        mappingError: ""
      };
    }

    return {
      linkedContractId: tender.linkedContractId || "",
      linkSource: tender.linkedContractId ? "existing" : "manual-missing",
      manualLinked: false,
      autoLinked: false,
      match: null,
      mappingError: `contract not found: ${manualMapping.contractId}`
    };
  }

  if (tender.linkedContractId) {
    return {
      linkedContractId: tender.linkedContractId,
      linkSource: "existing",
      manualLinked: false,
      autoLinked: false,
      match: null,
      mappingError: ""
    };
  }

  if (!autoLinkCategories.has(folder.category)) {
    return {
      linkedContractId: "",
      linkSource: "none",
      manualLinked: false,
      autoLinked: false,
      match: null,
      mappingError: ""
    };
  }

  const match = matchDriveNameToSource(folder.name, contracts);
  if (!match.source || !match.confident) {
    return {
      linkedContractId: "",
      linkSource: "none",
      manualLinked: false,
      autoLinked: false,
      match,
      mappingError: ""
    };
  }

  return {
    linkedContractId: match.source.id,
    linkSource: "auto",
    manualLinked: false,
    autoLinked: true,
    match,
    mappingError: ""
  };
}

export function planTenderSourceSync({
  sources = [],
  folders = [],
  tenderRoot = "",
  categories = DEFAULT_TENDER_CATEGORIES,
  autoLinkCategories = DEFAULT_AUTO_LINK_CATEGORIES,
  manualMappings = [],
  apply = false,
  applyScope = "all",
  prune = false
} = {}) {
  const autoLinkCategorySet = autoLinkCategories instanceof Set
    ? autoLinkCategories
    : new Set(autoLinkCategories);
  const syncScope = normalizeTenderSyncScope(applyScope);
  const contracts = contractSources(sources);
  const existingTenders = sources.filter((source) => isTenderSource(source));
  const existingByPath = new Map(existingTenders.map((source) => [path.resolve(source.path), source]));
  const seenPaths = new Set();
  const planned = [];
  const nextTenders = [];

  for (const folder of folders) {
    const resolvedPath = path.resolve(folder.path);
    seenPaths.add(resolvedPath);
    const existing = existingByPath.get(resolvedPath) || null;
    const tender = buildTenderSource(folder, existing);
    const link = resolveTenderLink({
      tender,
      contracts,
      folder,
      autoLinkCategories: autoLinkCategorySet,
      manualMappings
    });
    tender.linkedContractId = link.linkedContractId;
    tender.updatedAt = new Date().toISOString();
    nextTenders.push(tender);
    planned.push({
      action: existing ? "update" : "create",
      tenderCategory: folder.category,
      title: folder.name,
      path: folder.path,
      tenderId: tender.id,
      linkedContractId: tender.linkedContractId || "",
      linkSource: link.linkSource,
      manualLinked: link.manualLinked,
      autoLinked: link.autoLinked,
      mappingError: link.mappingError,
      matchScore: link.match?.score || 0,
      matchCandidates: link.match?.candidates || []
    });
  }

  const staleTenders = existingTenders.filter((source) => !seenPaths.has(path.resolve(source.path)));
  const contractOnly = sources.filter((source) => !isTenderSource(source));
  const readyUnlinkedPaths = new Set(planned
    .filter((item) => tenderPlanIsUnlinkedReady(item))
    .map((item) => path.resolve(item.path)));
  const scopedPlanned = syncScope === TENDER_SYNC_SCOPE_UNLINKED
    ? planned.filter((item) => tenderPlanIsUnlinkedReady(item))
    : planned;
  const nextTendersByPath = new Map(nextTenders.map((source) => [path.resolve(source.path), source]));
  const nextSources = syncScope === TENDER_SYNC_SCOPE_UNLINKED
    ? [
        ...sources.filter((source) => !isTenderSource(source) || !readyUnlinkedPaths.has(path.resolve(source.path))),
        ...[...readyUnlinkedPaths].map((sourcePath) => nextTendersByPath.get(sourcePath)).filter(Boolean)
      ]
    : (prune
        ? [...contractOnly, ...nextTenders]
        : [...contractOnly, ...nextTenders, ...staleTenders]);

  const summary = {
    tenderRoot,
    categories,
    autoLinkCategories: [...autoLinkCategorySet],
    applyScope: syncScope,
    mappings: {
      count: manualMappings.length,
      applied: planned.filter((item) => item.linkSource === "manual").length,
      missingContracts: planned.filter((item) => item.mappingError).length
    },
    apply,
    prune,
    totals: {
      foldersOnDisk: folders.length,
      tenderSources: nextTenders.length,
      contracts: contracts.length,
      created: planned.filter((item) => item.action === "create").length,
      updated: planned.filter((item) => item.action === "update").length,
      applied: scopedPlanned.length,
      scopeCreated: scopedPlanned.filter((item) => item.action === "create").length,
      scopeUpdated: scopedPlanned.filter((item) => item.action === "update").length,
      linked: planned.filter((item) => item.linkedContractId).length,
      manualLinked: planned.filter((item) => item.manualLinked).length,
      autoLinked: planned.filter((item) => item.autoLinked).length,
      unlinked: planned.filter((item) => !item.linkedContractId).length,
      unlinkedReady: planned.filter((item) => tenderPlanIsUnlinkedReady(item)).length,
      review: planned.filter((item) => tenderPlanNeedsReview(item)).length,
      stale: staleTenders.length
    },
    planned,
    stale: staleTenders.map((source) => ({
      id: source.id,
      title: source.title,
      path: source.path
    }))
  };

  return { summary, nextSources };
}

export async function runTenderSourceSync(options = {}) {
  const envOptions = tenderSyncOptionsFromEnv(options.env || process.env);
  const tenderRoot = options.tenderRoot || envOptions.tenderRoot;
  const categories = options.categories || envOptions.categories;
  const autoLinkCategories = options.autoLinkCategories || envOptions.autoLinkCategories;
  const apply = Boolean(options.apply);
  const applyScope = normalizeTenderSyncScope(options.applyScope || options.scope);
  const prune = Boolean(options.prune);
  const [sources, folders, manualMappings] = await Promise.all([
    options.sources ? Promise.resolve(options.sources) : readSources(),
    options.folders ? Promise.resolve(options.folders) : listTenderFolders(tenderRoot, categories),
    options.manualMappings ? Promise.resolve(options.manualMappings) : readTenderLinkMappings(options.mappingsPath)
  ]);

  const result = planTenderSourceSync({
    sources,
    folders,
    tenderRoot,
    categories,
    autoLinkCategories,
    manualMappings,
    apply,
    applyScope,
    prune
  });

  if (apply) await writeSources(result.nextSources);
  return result.summary;
}

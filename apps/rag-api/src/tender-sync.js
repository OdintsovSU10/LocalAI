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

function normalizeTenderAutoLinkExclusions(input = []) {
  const values = Array.isArray(input) ? input : [];
  return values
    .map((item) => {
      if (typeof item === "string") {
        const value = item.trim();
        return {
          tenderId: value,
          tenderPath: value,
          linkedContractId: ""
        };
      }

      return {
        tenderId: String(item?.tenderId || item?.id || "").trim(),
        tenderPath: String(item?.tenderPath || item?.path || "").trim(),
        linkedContractId: String(item?.linkedContractId || item?.contractId || "").trim()
      };
    })
    .filter((item) => item.tenderId || item.tenderPath);
}

function normalizeTenderSelectedLinks(input = []) {
  const values = Array.isArray(input) ? input : [];
  return values
    .map((item) => ({
      tenderId: String(item?.tenderId || item?.id || "").trim(),
      tenderPath: String(item?.tenderPath || item?.path || "").trim(),
      contractId: String(item?.contractId || item?.linkedContractId || "").trim()
    }))
    .filter((item) => item.contractId && (item.tenderId || item.tenderPath));
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
  return (await scanTenderFolders(root, categories)).folders;
}

async function directoryState(folderPath) {
  try {
    const stat = await fs.stat(folderPath);
    return {
      exists: true,
      isDirectory: stat.isDirectory(),
      code: "",
      message: ""
    };
  } catch (error) {
    return {
      exists: false,
      isDirectory: false,
      code: error?.code || "",
      message: error?.message || "directory is not available"
    };
  }
}

export async function scanTenderFolders(root, categories = DEFAULT_TENDER_CATEGORIES) {
  const folders = [];
  const rootState = await directoryState(root);
  const diagnostics = {
    tenderRoot: root,
    rootExists: rootState.exists,
    rootIsDirectory: rootState.isDirectory,
    rootErrorCode: rootState.code,
    rootError: rootState.message,
    categoriesTotal: categories.length,
    categoriesReadable: 0,
    categoriesMissing: 0,
    categoryErrors: 0,
    categories: []
  };

  if (!rootState.exists || !rootState.isDirectory) {
    diagnostics.categories = categories.map((category) => ({
      category,
      path: path.join(root, category),
      status: "not_checked",
      folders: 0,
      errorCode: rootState.code,
      error: rootState.message
    }));
    return { folders, diagnostics };
  }

  for (const category of categories) {
    const categoryPath = path.join(root, category);
    let entries;
    try {
      entries = await fs.readdir(categoryPath, { withFileTypes: true });
    } catch (error) {
      const missing = error?.code === "ENOENT";
      if (missing) diagnostics.categoriesMissing += 1;
      else diagnostics.categoryErrors += 1;
      diagnostics.categories.push({
        category,
        path: categoryPath,
        status: missing ? "missing" : "error",
        folders: 0,
        errorCode: error?.code || "",
        error: error?.message || "category folder is not available"
      });
      continue;
    }

    let categoryFolders = 0;
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name === "desktop.ini") continue;
      categoryFolders += 1;
      folders.push({
        category,
        name: entry.name,
        path: path.join(categoryPath, entry.name)
      });
    }
    diagnostics.categoriesReadable += 1;
    diagnostics.categories.push({
      category,
      path: categoryPath,
      status: "readable",
      folders: categoryFolders,
      errorCode: "",
      error: ""
    });
  }
  return { folders, diagnostics };
}

function createTenderSyncError(message, diagnostics, statusCode = 500) {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.tenderSync = diagnostics;
  return error;
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

function tenderAutoLinkIsExcluded(folder, tender, linkedContractId = "", excludedAutoLinks = []) {
  if (!excludedAutoLinks.length) return false;
  const folderPath = normalizeMappingPath(folder.path);
  return excludedAutoLinks.some((item) => {
    const tenderMatches = (item.tenderId && item.tenderId === tender.id)
      || (item.tenderPath && normalizeMappingPath(item.tenderPath) === folderPath);
    const contractMatches = !item.linkedContractId || item.linkedContractId === linkedContractId;
    return tenderMatches && contractMatches;
  });
}

function findSelectedTenderLink(folder, tender, selectedLinks = []) {
  if (!selectedLinks.length) return null;
  const folderPath = normalizeMappingPath(folder.path);
  return selectedLinks.find((item) => (
    (item.tenderId && item.tenderId === tender.id)
    || (item.tenderPath && normalizeMappingPath(item.tenderPath) === folderPath)
  )) || null;
}

function selectedTenderMatchCandidate(match = null, linkedContractId = "") {
  const candidates = Array.isArray(match?.candidates) ? match.candidates : [];
  const selectedId = String(linkedContractId || match?.source?.id || "").trim();
  if (!selectedId) return null;

  const selected = candidates.find((candidate) => candidate.id === selectedId);
  if (selected) return selected;
  if (!match?.source || match.source.id !== selectedId) return null;

  return {
    id: match.source.id,
    title: match.source.title,
    score: Number(Number(match.score || 0).toFixed(2)),
    matchedTokens: Array.isArray(match.matchedTokens) ? match.matchedTokens : []
  };
}

function resolveTenderLink({ tender, contracts, folder, autoLinkCategories, manualMappings, selectedLinks, excludedAutoLinks }) {
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
  const selectedLink = findSelectedTenderLink(folder, tender, selectedLinks);
  if (selectedLink) {
    const linkedContract = contracts.find((source) => source.id === selectedLink.contractId);
    if (linkedContract) {
      return {
        linkedContractId: linkedContract.id,
        linkSource: "selected",
        manualLinked: false,
        selectedLinked: true,
        autoLinked: false,
        autoLinkExcluded: false,
        match,
        selectedMatchCandidate: selectedTenderMatchCandidate(match, linkedContract.id) || {
          id: linkedContract.id,
          title: linkedContract.title,
          score: 0,
          matchedTokens: []
        },
        mappingError: ""
      };
    }

    return {
      linkedContractId: "",
      linkSource: "selected-missing",
      manualLinked: false,
      selectedLinked: false,
      autoLinked: false,
      autoLinkExcluded: false,
      match,
      mappingError: `selected contract not found: ${selectedLink.contractId}`
    };
  }

  if (!match.source || !match.confident) {
    return {
      linkedContractId: "",
      linkSource: "none",
      manualLinked: false,
      autoLinked: false,
      autoLinkExcluded: false,
      match,
      mappingError: ""
    };
  }

  if (tenderAutoLinkIsExcluded(folder, tender, match.source.id, excludedAutoLinks)) {
    return {
      linkedContractId: "",
      linkSource: "excluded-auto",
      manualLinked: false,
      autoLinked: false,
      autoLinkExcluded: true,
      match,
      mappingError: ""
    };
  }

  return {
    linkedContractId: match.source.id,
    linkSource: "auto",
    manualLinked: false,
    autoLinked: true,
    autoLinkExcluded: false,
    match,
    selectedMatchCandidate: selectedTenderMatchCandidate(match, match.source.id),
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
  selectedTenderLinks = [],
  excludedAutoLinks = [],
  apply = false,
  applyScope = "all",
  prune = false
} = {}) {
  const autoLinkCategorySet = autoLinkCategories instanceof Set
    ? autoLinkCategories
    : new Set(autoLinkCategories);
  const normalizedSelectedLinks = normalizeTenderSelectedLinks(selectedTenderLinks);
  const normalizedExcludedAutoLinks = normalizeTenderAutoLinkExclusions(excludedAutoLinks);
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
      manualMappings,
      selectedLinks: normalizedSelectedLinks,
      excludedAutoLinks: normalizedExcludedAutoLinks
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
      selectedLinked: Boolean(link.selectedLinked),
      autoLinked: link.autoLinked,
      autoLinkExcluded: Boolean(link.autoLinkExcluded),
      mappingError: link.mappingError,
      matchScore: link.match?.score || 0,
      selectedMatchCandidateId: link.selectedMatchCandidate?.id || link.linkedContractId || "",
      selectedMatchCandidate: link.selectedMatchCandidate || null,
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
      selectedLinked: planned.filter((item) => item.selectedLinked).length,
      autoLinked: planned.filter((item) => item.autoLinked).length,
      autoLinkExcluded: planned.filter((item) => item.autoLinkExcluded).length,
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
  const selectedTenderLinks = normalizeTenderSelectedLinks(options.selectedTenderLinks);
  const excludedAutoLinks = normalizeTenderAutoLinkExclusions(options.excludedAutoLinks);
  const apply = Boolean(options.apply);
  const applyScope = normalizeTenderSyncScope(options.applyScope || options.scope);
  const prune = Boolean(options.prune);
  const folderScan = options.folders
    ? Promise.resolve({
        folders: options.folders,
        diagnostics: {
          tenderRoot,
          rootExists: true,
          rootIsDirectory: true,
          providedFolders: true,
          categoriesTotal: categories.length,
          categoriesReadable: categories.length,
          categoriesMissing: 0,
          categoryErrors: 0,
          categories: []
        }
      })
    : scanTenderFolders(tenderRoot, categories);
  const [sources, scannedFolders, manualMappings] = await Promise.all([
    options.sources ? Promise.resolve(options.sources) : readSources(),
    folderScan,
    options.manualMappings ? Promise.resolve(options.manualMappings) : readTenderLinkMappings(options.mappingsPath)
  ]);
  const folders = scannedFolders.folders || [];
  const diagnostics = scannedFolders.diagnostics || null;

  if (diagnostics && !diagnostics.rootExists) {
    throw createTenderSyncError(
      `Папка тендеров не найдена: ${tenderRoot}. Проверьте, что Google Drive Desktop запущен и RAG_TENDER_ROOT указывает на доступную папку.`,
      diagnostics,
      404
    );
  }

  if (diagnostics && diagnostics.rootExists && !diagnostics.rootIsDirectory) {
    throw createTenderSyncError(
      `Путь тендеров не является папкой: ${tenderRoot}. Проверьте RAG_TENDER_ROOT.`,
      diagnostics,
      400
    );
  }

  const result = planTenderSourceSync({
    sources,
    folders,
    tenderRoot,
    categories,
    autoLinkCategories,
    manualMappings,
    selectedTenderLinks,
    excludedAutoLinks,
    apply,
    applyScope,
    prune
  });

  result.summary.diagnostics = diagnostics;
  if (apply) await writeSources(result.nextSources);
  return result.summary;
}

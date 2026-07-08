export const SOURCE_TYPE_CONTRACT = "contract";
export const SOURCE_TYPE_TENDER = "tender";

export function normalizeSourceType(source = {}) {
  const value = String(source?.sourceType || SOURCE_TYPE_CONTRACT).trim().toLowerCase();
  return value === SOURCE_TYPE_TENDER ? SOURCE_TYPE_TENDER : SOURCE_TYPE_CONTRACT;
}

export function isContractSource(source = {}) {
  return normalizeSourceType(source) === SOURCE_TYPE_CONTRACT;
}

export function isTenderSource(source = {}) {
  return normalizeSourceType(source) === SOURCE_TYPE_TENDER;
}

export function contractSources(sources = []) {
  return sources.filter((source) => isContractSource(source));
}

export function tenderSources(sources = []) {
  return sources.filter((source) => isTenderSource(source));
}

export function tendersLinkedToContract(contractId = "", sources = []) {
  const id = String(contractId || "").trim();
  if (!id) return [];
  return tenderSources(sources).filter((source) => String(source.linkedContractId || "").trim() === id);
}

export function contractForTender(tender = {}, sources = []) {
  const linkedId = String(tender?.linkedContractId || "").trim();
  if (!linkedId) return null;
  return sources.find((source) => source.id === linkedId && isContractSource(source)) || null;
}

export function searchScopeSourceIds(source = null, sources = []) {
  if (!source) return [];
  const ids = [source.id];
  if (isContractSource(source)) {
    for (const tender of tendersLinkedToContract(source.id, sources)) {
      ids.push(tender.id);
    }
  }
  return [...new Set(ids)];
}

export function resolveSearchSourceIds({ source = null, searchAllSources = false, sources = [] } = {}) {
  if (searchAllSources) return [];
  return searchScopeSourceIds(source, sources);
}

export function publicLinkedTenderSummary(tender = {}) {
  return {
    id: tender.id,
    title: tender.title,
    path: tender.path,
    tenderCategory: tender.tenderCategory || "",
    linkedContractId: tender.linkedContractId || ""
  };
}

import { isContractSource, isTenderSource, normalizeSourceType } from "./source-scope.js";

function sourceUpdateError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function sourceTypePatchValue(value) {
  const sourceType = String(value || "").trim().toLowerCase();
  if (sourceType !== "contract" && sourceType !== "tender") {
    throw sourceUpdateError(400, "sourceType must be contract or tender");
  }
  return sourceType;
}

function normalizePathKey(value = "") {
  return String(value || "").trim().replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

function additionalPathsPatchValue(value, primaryPath = "") {
  if (!Array.isArray(value)) {
    throw sourceUpdateError(400, "additionalPaths must be an array");
  }

  const primaryKey = normalizePathKey(primaryPath);
  const seen = new Set();
  const paths = [];
  for (const entry of value) {
    const nextPath = String(entry || "").trim();
    const key = normalizePathKey(nextPath);
    if (!key || key === primaryKey || seen.has(key)) continue;
    seen.add(key);
    paths.push(nextPath);
  }
  return paths;
}

export function applySourcePatch(sources = [], sourceId = "", patch = {}) {
  const id = String(sourceId || "").trim();
  const index = sources.findIndex((source) => source?.id === id);
  if (index < 0) throw sourceUpdateError(404, "source not found");

  const source = { ...sources[index] };
  let changed = false;

  if (Object.hasOwn(patch || {}, "title")) {
    const title = String(patch.title || "").trim();
    if (!title) throw sourceUpdateError(400, "title is required");

    source.title = title;
    changed = true;
  }

  if (Object.hasOwn(patch || {}, "additionalPaths")) {
    const additionalPaths = additionalPathsPatchValue(patch.additionalPaths, source.path);
    if (additionalPaths.length) {
      source.additionalPaths = additionalPaths;
    } else {
      delete source.additionalPaths;
    }
    changed = true;
  }

  if (Object.hasOwn(patch || {}, "linkedContractId")) {
    if (!isTenderSource(source)) {
      throw sourceUpdateError(400, "linkedContractId can be changed only for tender sources");
    }

    const linkedContractId = String(patch.linkedContractId || "").trim();
    if (linkedContractId) {
      const linkedContract = sources.find((item) => item?.id === linkedContractId && isContractSource(item));
      if (!linkedContract) {
        throw sourceUpdateError(400, "linkedContractId must point to an existing contract source");
      }
    }

    source.linkedContractId = linkedContractId;
    changed = true;
  }

  if (Object.hasOwn(patch || {}, "sourceType")) {
    const currentSourceType = normalizeSourceType(source);
    const nextSourceType = sourceTypePatchValue(patch.sourceType);
    if (nextSourceType !== currentSourceType) {
      if (!isTenderSource(source) || nextSourceType !== "contract") {
        throw sourceUpdateError(400, "sourceType can only move tender sources to contract");
      }

      source.sourceType = nextSourceType;
      delete source.linkedContractId;
      changed = true;
    }
  }

  if (!changed) throw sourceUpdateError(400, "no supported source fields to update");

  source.updatedAt = new Date().toISOString();
  const nextSources = [...sources];
  nextSources[index] = source;

  return { sources: nextSources, source };
}

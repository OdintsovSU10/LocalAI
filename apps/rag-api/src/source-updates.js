import { isContractSource, isTenderSource } from "./source-scope.js";

function sourceUpdateError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

export function applySourcePatch(sources = [], sourceId = "", patch = {}) {
  const id = String(sourceId || "").trim();
  const index = sources.findIndex((source) => source?.id === id);
  if (index < 0) throw sourceUpdateError(404, "source not found");

  const source = { ...sources[index] };
  let changed = false;

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

  if (!changed) throw sourceUpdateError(400, "no supported source fields to update");

  source.updatedAt = new Date().toISOString();
  const nextSources = [...sources];
  nextSources[index] = source;

  return { sources: nextSources, source };
}

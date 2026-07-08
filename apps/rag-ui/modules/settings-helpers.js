const REMOTE_MODEL_FALLBACK = "qwen3.6-27b-mtp";

export function remoteModelScore(model) {
  const value = String(model || "").toLowerCase();
  if (!value || /embed|embedding/i.test(value)) return -1000;

  const numbers = value.match(/\d+(?:\.\d+)?/g) || [];
  const maxNumber = numbers.reduce((max, item) => Math.max(max, Number(item) || 0), 0);
  const quant = value.match(/@q(\d+(?:\.\d+)?)/);
  let score = maxNumber;
  if (value.includes("qwen")) score += 500;
  if (quant) score += (Number(quant[1]) || 0) / 10;
  if (value.includes("ocr")) score -= 100;
  return score;
}

export function remoteModelRowScore(row) {
  const model = typeof row === "string" ? row : row?.id;
  let score = remoteModelScore(model);
  if (row?.loaded) score += 50;
  if (/^lift(?:-\d+)?$/i.test(String(model || ""))) score -= 300;
  return score;
}

function modelParameterBillions(model) {
  const value = String(model || "").toLowerCase();
  const matches = [
    ...value.matchAll(/(?:^|[^a-z0-9])(\d+(?:\.\d+)?)\s*b(?:[^a-z0-9]|$)/g),
    ...value.matchAll(/(?:^|[-_/])(\d+(?:\.\d+)?)b(?:[-_/]|$)/g)
  ];
  const values = matches.map((match) => Number(match[1])).filter(Number.isFinite);
  return values.length ? Math.max(...values) : 0;
}

export function localModelScore(row) {
  const model = typeof row === "string" ? row : row?.id;
  const value = String(model || "").toLowerCase();
  const type = String(row?.type || "").toLowerCase();
  if (!value || /embed|embedding/i.test(`${value} ${type}`)) return -1000;

  let score = modelParameterBillions(value) * 20;
  if (value.includes("qwen3")) score += 500;
  else if (value.includes("qwen2.5")) score += 430;
  else if (value.includes("qwen")) score += 400;
  else if (value.includes("gemma")) score += 250;
  if (/qwen3[-_/]?8b/.test(value)) score += 120;
  if (value.includes("instruct")) score += 80;
  if (value.includes("2507")) score += 10;
  if (row?.loaded) score += 20;
  if (/vlm|vision/.test(`${type} ${value}`)) score -= 250;
  if (/abliterated|heretic|gabliterated|mythos/.test(value)) score -= 400;
  if (/^lift(?:-\d+)?$/i.test(String(model || ""))) score -= 300;
  return score;
}

export function sortLocalModels(models = []) {
  return [...models]
    .filter((item) => {
      const id = typeof item === "string" ? item : item?.id;
      const type = typeof item === "string" ? "" : item?.type;
      return id && !/embed|embedding/i.test(`${id} ${type || ""}`);
    })
    .sort((a, b) => localModelScore(b) - localModelScore(a));
}

export function modelMatchKey(model) {
  return String(model || "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

function modelBaseKey(model) {
  return modelMatchKey(String(model || "").trim().replace(/@[^/\\]+$/i, "").split(/[\\/]/).pop());
}

export function preferredRemoteModel(models = [], fallback = "") {
  const rows = models
    .map((item) => (typeof item === "string" ? { id: item } : item))
    .filter((item) => item?.id);
  const available = rows.map((item) => String(item.id)).filter(Boolean);
  if (fallback && available.includes(fallback)) return fallback;
  if (fallback && !fallback.includes("@")) {
    const fallbackBaseKey = modelBaseKey(fallback);
    const variant = rows
      .filter((item) => modelBaseKey(item.id) === fallbackBaseKey)
      .sort((a, b) => remoteModelRowScore(b) - remoteModelRowScore(a))[0];
    if (variant?.id) return variant.id;
  }
  return available
    .filter((model) => !/embed|embedding/i.test(model))
    .sort((a, b) => remoteModelRowScore(rows.find((item) => item.id === b)) - remoteModelRowScore(rows.find((item) => item.id === a)))[0]
    || available[0]
    || fallback
    || REMOTE_MODEL_FALLBACK;
}

export function preferredLocalModel(models = [], fallback = "") {
  const rows = models
    .map((item) => (typeof item === "string" ? { id: item } : item))
    .filter((item) => item?.id);
  const available = rows.map((item) => String(item.id)).filter(Boolean);
  if (fallback && available.includes(fallback)) return fallback;
  if (fallback && !fallback.includes("@")) {
    const fallbackBaseKey = modelBaseKey(fallback);
    const variant = rows
      .filter((item) => modelBaseKey(item.id) === fallbackBaseKey)
      .sort((a, b) => localModelScore(b) - localModelScore(a))[0];
    if (variant?.id) return variant.id;
  }
  return sortLocalModels(rows)[0]?.id
    || fallback
    || available[0]
    || "";
}

export function preferredEmbeddingModel(models = [], fallback = "") {
  return models.find((model) => /embed|embedding/i.test(model))
    || fallback
    || "text-embedding-bge-m3";
}

export function modelOptionLabel(row) {
  const id = String(row?.id || "").trim();
  if (!id) return "";
  const parts = [];
  if (row.loaded) parts.push("loaded");
  else if (row.state) parts.push(row.state);
  if (row.loadedContextLength) parts.push(`ctx ${row.loadedContextLength}`);
  if (row.quantization) parts.push(row.quantization);
  if (row.type) parts.push(row.type);
  return parts.length ? `${id} · ${parts.join(" · ")}` : id;
}

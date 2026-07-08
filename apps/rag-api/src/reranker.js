import "dotenv/config";

import { defaultRerankerSettings } from "./store.js";

function envString(...names) {
  for (const name of names) {
    const value = process.env[name];
    if (value !== undefined && String(value).trim() !== "") return String(value).trim();
  }
  return "";
}

function envFlag(name, fallback = false) {
  const value = process.env[name];
  if (value === undefined || String(value).trim() === "") return fallback;
  return ["1", "true", "yes", "on"].includes(String(value).trim().toLowerCase());
}

function envNumber(name, fallback, { min = Number.NEGATIVE_INFINITY, max = Number.POSITIVE_INFINITY } = {}) {
  const value = Number(process.env[name]);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

export function rerankerSettings(reranker = {}) {
  const incoming = { ...defaultRerankerSettings, ...(reranker || {}) };
  const baseUrl = (envString("RAG_RERANKER_BASE_URL", "JINA_RERANKER_URL", "COHERE_RERANKER_URL") || incoming.baseUrl || "").replace(/\/$/, "");
  return {
    enabled: envFlag("RAG_RERANKER_ENABLED", Boolean(incoming.enabled)),
    baseUrl,
    endpoint: baseUrl.endsWith("/rerank") ? baseUrl : `${baseUrl}/rerank`,
    apiKey: envString("RAG_RERANKER_API_KEY", "JINA_API_KEY", "COHERE_API_KEY") || incoming.apiKey || "",
    model: envString("RAG_RERANKER_MODEL", "JINA_RERANKER_MODEL", "COHERE_RERANKER_MODEL") || incoming.model || defaultRerankerSettings.model,
    candidateCount: envNumber("RAG_RERANKER_CANDIDATES", Number(incoming.candidateCount || defaultRerankerSettings.candidateCount), { min: 1, max: 100 }),
    maxChars: envNumber("RAG_RERANKER_MAX_CHARS", Number(incoming.maxChars || defaultRerankerSettings.maxChars), { min: 200, max: 20000 }),
    timeoutSeconds: envNumber("RAG_RERANKER_TIMEOUT_SECONDS", Number(incoming.timeoutSeconds || defaultRerankerSettings.timeoutSeconds), { min: 2, max: 300 })
  };
}

export function rerankerStatus(reranker = {}) {
  const settings = rerankerSettings(reranker);
  return {
    enabled: settings.enabled,
    configured: Boolean(settings.baseUrl),
    baseUrl: settings.baseUrl,
    endpoint: settings.baseUrl ? settings.endpoint : "",
    hasApiKey: Boolean(settings.apiKey),
    model: settings.model,
    candidateCount: settings.candidateCount,
    maxChars: settings.maxChars,
    timeoutSeconds: settings.timeoutSeconds
  };
}

function parseRerankResults(payload) {
  const rows = Array.isArray(payload?.results) ? payload.results : (Array.isArray(payload?.data) ? payload.data : []);
  return rows
    .map((row) => ({
      index: Number(row.index ?? row.document?.index ?? row.id),
      score: Number(row.relevance_score ?? row.relevanceScore ?? row.score)
    }))
    .filter((row) => Number.isInteger(row.index) && Number.isFinite(row.score))
    .sort((left, right) => right.score - left.score);
}

export async function rerankSearchResults({ query, chunks, limit, reranker }) {
  const settings = rerankerSettings(reranker);
  if (!settings.enabled || !settings.baseUrl || !chunks.length) {
    return { chunks, rerankerUsed: false, rerankerError: "" };
  }

  const candidates = chunks.slice(0, Math.max(limit, settings.candidateCount));
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), settings.timeoutSeconds * 1000);

  try {
    const response = await fetch(settings.endpoint, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        ...(settings.apiKey ? { Authorization: `Bearer ${settings.apiKey}` } : {})
      },
      body: JSON.stringify({
        model: settings.model,
        query,
        documents: candidates.map((chunk) => String(chunk.text || "").slice(0, settings.maxChars)),
        top_n: Math.min(limit, candidates.length),
        return_documents: false
      })
    });

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(`Reranker returned ${response.status}${text ? `: ${text}` : ""}`);
    }

    const ranked = parseRerankResults(await response.json());
    if (!ranked.length) return { chunks, rerankerUsed: false, rerankerError: "Reranker response did not include scores" };

    const used = new Set();
    const reranked = ranked
      .map((row) => {
        const chunk = candidates[row.index];
        if (!chunk) return null;
        used.add(chunk.id);
        return {
          ...chunk,
          rerankScore: row.score,
          searchMode: `${chunk.searchMode}+rerank`
        };
      })
      .filter(Boolean);

    return {
      chunks: [...reranked, ...chunks.filter((chunk) => !used.has(chunk.id))],
      rerankerUsed: true,
      rerankerError: ""
    };
  } catch (error) {
    return { chunks, rerankerUsed: false, rerankerError: error.message };
  } finally {
    clearTimeout(timeout);
  }
}

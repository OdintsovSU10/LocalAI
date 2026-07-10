const DEFAULT_MAX_ATTEMPTS = 1;
const DEFAULT_MIN_SCORE = 60;
const ORCHESTRATOR_NAME = "quality-reindex";

const RETRYABLE_WARNINGS = new Set([
  "no_chunks",
  "too_little_text",
  "too_few_words",
  "low_text_density",
  "encoding_noise",
  "ocr_text_noise",
  "pdf_text_layer_noise",
  "empty_pdf_text",
  "low_ocr_confidence",
  "low_ocr_page_confidence",
  "empty_ocr_pages",
  "ocr_rejected_pages",
  "no_usable_ocr_pages",
  "chunks_skipped_for_quality"
]);

function boolEnv(env, name, fallback = false) {
  const value = String(env?.[name] || "").trim().toLowerCase();
  if (!value) return fallback;
  return ["1", "true", "yes", "on"].includes(value);
}

function numberEnv(env, name, fallback, { min = 0, max = Number.POSITIVE_INFINITY } = {}) {
  const value = Number(env?.[name]);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

function unique(values = []) {
  return [...new Set(values.map((value) => String(value || "").trim()).filter(Boolean))];
}

export function reindexOrchestratorSettings(env = process.env) {
  return {
    enabled: !boolEnv(env, "RAG_REINDEX_ORCHESTRATOR_DISABLED", false),
    maxAttempts: Math.round(numberEnv(env, "RAG_REINDEX_MAX_ATTEMPTS", DEFAULT_MAX_ATTEMPTS, { min: 0, max: 5 })),
    minScore: numberEnv(env, "RAG_REINDEX_MIN_SCORE", DEFAULT_MIN_SCORE, { min: 0, max: 100 })
  };
}

export function compactQuality(quality = {}) {
  const score = Number(quality?.score);
  return {
    status: String(quality?.status || ""),
    score: Number.isFinite(score) ? score : null,
    warnings: unique(Array.isArray(quality?.warnings) ? quality.warnings : []),
    chunks: Number.isFinite(Number(quality?.chunks)) ? Number(quality.chunks) : 0,
    chars: Number.isFinite(Number(quality?.chars)) ? Number(quality.chars) : 0,
    words: Number.isFinite(Number(quality?.words)) ? Number(quality.words) : 0
  };
}

export function qualityReindexReasons(quality = {}, { fromCache = false, settings = reindexOrchestratorSettings() } = {}) {
  const snapshot = compactQuality(quality);
  const reasons = [];

  if (snapshot.status === "error") reasons.push("quality_error");
  if (snapshot.score !== null && snapshot.score < settings.minScore) reasons.push("low_quality_score");

  for (const warning of snapshot.warnings) {
    if (RETRYABLE_WARNINGS.has(warning)) reasons.push(warning);
  }

  const cacheWarnings = snapshot.warnings.filter((warning) => warning !== "ocr_limited");
  if (fromCache && cacheWarnings.length) reasons.push("cached_quality_warning");

  return unique(reasons);
}

export function qualityReindexDecision({
  quality = {},
  fromCache = false,
  attempt = 0,
  settings = reindexOrchestratorSettings()
} = {}) {
  if (!settings.enabled) {
    return { queued: false, reason: "disabled", reasons: [], attempt, maxAttempts: settings.maxAttempts };
  }
  if (attempt >= settings.maxAttempts) {
    return { queued: false, reason: "max_attempts", reasons: [], attempt, maxAttempts: settings.maxAttempts };
  }

  const reasons = qualityReindexReasons(quality, { fromCache, settings });
  return {
    queued: reasons.length > 0,
    reason: reasons.length ? "quality" : "not_needed",
    reasons,
    attempt,
    nextAttempt: attempt + 1,
    maxAttempts: settings.maxAttempts
  };
}

export function createReindexStats() {
  return {
    queued: 0,
    retried: 0,
    resolved: 0,
    unresolved: 0,
    failed: 0,
    recoveredErrors: 0
  };
}

export function createReindexReport({
  decision = {},
  initialQuality = {},
  finalQuality = {},
  fromCache = false,
  error = "",
  startedAt = new Date(),
  finishedAt = new Date(),
  settings = reindexOrchestratorSettings()
} = {}) {
  const initial = compactQuality(initialQuality);
  const final = compactQuality(finalQuality);
  const finalReasons = error ? [] : qualityReindexReasons(finalQuality, { fromCache: false, settings });
  const initialScore = Number(initial.score);
  const finalScore = Number(final.score);
  const improved = Number.isFinite(initialScore) && Number.isFinite(finalScore) && finalScore > initialScore;
  const status = error ? "retry_failed" : finalReasons.length ? "unresolved" : "resolved";

  return {
    orchestrator: ORCHESTRATOR_NAME,
    status,
    retried: true,
    fromCache: Boolean(fromCache),
    reasons: unique(decision.reasons || []),
    finalReasons,
    attempts: [
      {
        attempt: 0,
        source: fromCache ? "cache" : "conversion",
        quality: initial
      },
      {
        attempt: Number(decision.nextAttempt || 1),
        source: "forced-reindex",
        refreshRecognitionCache: true,
        quality: final,
        error: String(error || "")
      }
    ],
    improved,
    startedAt: startedAt instanceof Date ? startedAt.toISOString() : new Date(startedAt).toISOString(),
    finishedAt: finishedAt instanceof Date ? finishedAt.toISOString() : new Date(finishedAt).toISOString()
  };
}

export function updateReindexStats(stats, report = {}, { recoveredError = false } = {}) {
  if (!stats || !report?.retried) return stats;
  stats.retried += 1;
  if (report.status === "resolved") stats.resolved += 1;
  else if (report.status === "unresolved") stats.unresolved += 1;
  else if (report.status === "retry_failed") stats.failed += 1;
  if (recoveredError) stats.recoveredErrors += 1;
  return stats;
}

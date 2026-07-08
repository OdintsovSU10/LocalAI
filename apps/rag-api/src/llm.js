import { defaultLlmSettings } from "./store.js";

const remoteRagContextLength = 16384;
const localRagContextLength = positiveIntegerFromEnv("RAG_LOCAL_LMSTUDIO_CONTEXT_LENGTH", 8192);
const remoteMinCompletionTokens = 8192;

function positiveIntegerFromEnv(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? Math.round(value) : fallback;
}

function isRemoteLlmProvider(provider) {
  const value = String(provider || "").trim().toLowerCase();
  return value === "remote" || value === "token";
}

export function normalizeRemoteRuntime(runtime) {
  const value = String(runtime || "").trim().toLowerCase();
  if (["openai", "openai-compatible", "openai_compatible", "vllm", "sglang", "llama.cpp", "llamacpp"].includes(value)) {
    return "openai-compatible";
  }
  return "lmstudio";
}

export function isLmStudioRuntime(settings = {}) {
  return normalizeRemoteRuntime(settings.remoteRuntime || settings.runtime || settings.remote?.runtime) === "lmstudio";
}

function lmStudioContextLength(settings = {}) {
  return isRemoteLlmProvider(settings.provider) ? remoteRagContextLength : localRagContextLength;
}

function withTimeout(timeoutSeconds, externalSignal) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutSeconds * 1000);
  const abortFromExternal = () => controller.abort(externalSignal?.reason);

  if (externalSignal?.aborted) {
    abortFromExternal();
  } else if (externalSignal) {
    externalSignal.addEventListener("abort", abortFromExternal, { once: true });
  }

  return {
    controller,
    timeout,
    cleanup: () => {
      clearTimeout(timeout);
      externalSignal?.removeEventListener("abort", abortFromExternal);
    }
  };
}

function authorizationHeaderValue(apiKey, fallback = "lm-studio") {
  const value = String(apiKey || fallback).trim();
  return /^Bearer\s+/i.test(value) ? value : `Bearer ${value}`;
}

function compactHttpError(text) {
  return String(text || "")
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 240);
}

function llmHeaders(llm) {
  return {
    "Content-Type": "application/json",
    "Authorization": authorizationHeaderValue(llm.apiKey)
  };
}

export function lmStudioNativeBaseUrl(baseUrl) {
  return String(baseUrl || defaultLlmSettings.baseUrl)
    .trim()
    .replace(/\/$/, "")
    .replace(/\/v1$/i, "")
    .replace(/\/api\/v[01]$/i, "");
}

export function normalizeLlmSettings(llm) {
  return {
    ...defaultLlmSettings,
    ...(llm || {}),
    baseUrl: String(llm?.baseUrl || defaultLlmSettings.baseUrl).replace(/\/$/, "")
  };
}

export async function listLlmModels(llm) {
  const settings = normalizeLlmSettings(llm);
  const { controller, cleanup } = withTimeout(Math.min(settings.timeoutSeconds || 30, 30));
  const errors = [];
  try {
    try {
      const response = await fetch(`${settings.baseUrl}/models`, {
        headers: llmHeaders(settings),
        signal: controller.signal
      });
      const text = await response.text().catch(() => "");
      if (!response.ok) {
        throw new Error(`OpenAI /models returned ${response.status}${text ? `: ${compactHttpError(text)}` : ""}`);
      }
      const payload = text ? JSON.parse(text) : null;
      const models = modelRowsFromPayload(payload).map((model) => model.id).filter(Boolean);
      if (models.length || !isRemoteLlmProvider(settings.provider) || !isLmStudioRuntime(settings)) return models;
    } catch (error) {
      errors.push(error.message);
      if (controller.signal.aborted || !isRemoteLlmProvider(settings.provider)) throw error;
      if (!isLmStudioRuntime(settings)) throw error;
    }

    try {
      const rows = await listNativeLlmModels(settings, controller.signal);
      const models = rows.map((model) => model.id).filter(Boolean);
      if (models.length) return models;
    } catch (error) {
      errors.push(error.message);
      if (controller.signal.aborted) throw error;
    }

    throw new Error(errors.length ? errors.join("; ") : "No LLM models are available");
  } finally {
    cleanup();
  }
}

async function fetchJson(url, settings, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      ...llmHeaders(settings),
      ...(options.headers || {})
    }
  });
  const text = await response.text().catch(() => "");
  let payload = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = null;
  }

  if (!response.ok) {
    const message = payload?.error?.message || payload?.error || payload?.message || text;
    throw new Error(`LM Studio returned ${response.status}${message ? `: ${compactHttpError(message)}` : ""}`);
  }

  return payload;
}

export function modelRowsFromPayload(payload) {
  const rows = Array.isArray(payload?.data)
    ? payload.data
    : Array.isArray(payload?.models)
      ? payload.models
      : Array.isArray(payload)
        ? payload
        : [];

  return rows
    .map((item) => {
      if (typeof item === "string") return { id: item };
      const loadedInstances = Array.isArray(item?.loaded_instances)
        ? item.loaded_instances.filter(Boolean)
        : Array.isArray(item?.loadedInstances)
          ? item.loadedInstances.filter(Boolean)
          : [];
      const firstLoadedInstance = loadedInstances[0] || null;
      const id = item?.id || item?.modelKey || item?.key || item?.path || item?.name || "";
      if (!id) return null;
      const loaded = item.loaded === true || item.state === "loaded" || loadedInstances.length > 0;
      return {
        id,
        type: item.type || item.object || "",
        state: item.state || (loaded ? "loaded" : item.loaded === false ? "not-loaded" : ""),
        loaded,
        instanceId: item.instance_id || item.instanceId || firstLoadedInstance?.id || "",
        loadedInstances: loadedInstances.map((instance) => instance.id).filter(Boolean),
        loadedContextLength: item.loaded_context_length
          || item.loadedContextLength
          || item.context_length
          || item.contextLength
          || firstLoadedInstance?.config?.context_length
          || null,
        maxContextLength: item.max_context_length || item.maxContextLength || null,
        quantization: typeof item.quantization === "object" ? item.quantization?.name || "" : item.quantization || item.quant || "",
        arch: item.arch || item.architecture || ""
      };
    })
    .filter(Boolean);
}

async function listNativeLlmModels(settings, signal) {
  const nativeBaseUrl = lmStudioNativeBaseUrl(settings.baseUrl);
  let lastError = null;
  for (const apiPath of ["/api/v1/models", "/api/v0/models"]) {
    try {
      const payload = await fetchJson(`${nativeBaseUrl}${apiPath}`, settings, { signal });
      const rows = modelRowsFromPayload(payload);
      if (rows.length) return rows;
      lastError = new Error(`LM Studio ${apiPath} returned no models`);
    } catch (error) {
      lastError = error;
      if (signal?.aborted) throw error;
    }
  }
  throw lastError || new Error("LM Studio native models endpoint failed");
}

async function loadNativeLlmModel(settings, model, signal, contextLength = remoteRagContextLength) {
  const nativeBaseUrl = lmStudioNativeBaseUrl(settings.baseUrl);
  return fetchJson(`${nativeBaseUrl}/api/v1/models/load`, settings, {
    method: "POST",
    signal,
    body: JSON.stringify({
      model,
      context_length: contextLength,
      echo_load_config: true
    })
  });
}

async function unloadNativeLlmModel(settings, instanceId, signal) {
  const nativeBaseUrl = lmStudioNativeBaseUrl(settings.baseUrl);
  return fetchJson(`${nativeBaseUrl}/api/v1/models/unload`, settings, {
    method: "POST",
    signal,
    body: JSON.stringify({ instance_id: instanceId })
  });
}

function isLoadedLlmRow(row) {
  const type = String(row?.type || "").toLowerCase();
  return (row?.loaded || row?.state === "loaded") && !["embedding", "embeddings"].includes(type);
}

function sameModelFamily(left, right) {
  return modelBaseKey(left) === modelBaseKey(right);
}

async function unloadOtherLoadedLlmModels(settings, rows, keepModel, signal, onProgress = () => {}) {
  const loadedRows = rows.filter((row) => isLoadedLlmRow(row) && !sameModelFamily(row.id, keepModel));
  if (!loadedRows.length) return 0;

  onProgress({
    phase: "loading_model",
    model: keepModel,
    modelState: `unloading ${loadedRows.length} old model${loadedRows.length > 1 ? "s" : ""}`
  });

  for (const row of loadedRows) {
    await unloadNativeLlmModel(settings, row.instanceId || row.id, signal);
  }
  return loadedRows.length;
}

export async function ensureLlmModelLoaded(settings, model, signal, onProgress = () => {}) {
  if (!model) return null;
  const remoteProvider = isRemoteLlmProvider(settings.provider);
  if (remoteProvider && !isLmStudioRuntime(settings)) {
    onProgress({ phase: "generating", model, modelLoaded: null, modelState: normalizeRemoteRuntime(settings.runtime) });
    return null;
  }
  if (!isLmStudioRuntime(settings)) return null;

  const { controller, cleanup } = withTimeout(settings.timeoutSeconds || 300, signal);
  const contextLength = lmStudioContextLength(settings);
  const locationLabel = remoteProvider ? "remote LM Studio" : "local LM Studio";
  try {
    onProgress({ phase: "checking_model", model });
    const rows = await listNativeLlmModels(settings, controller.signal);
    const matchedId = matchConfiguredModel(model, rows.map((row) => row.id)) || model;
    const row = rows.find((item) => item.id === matchedId) || rows.find((item) => sameModelFamily(item.id, matchedId));
    const loadedContextLength = Number(row?.loadedContextLength || 0);
    const rowLoaded = row?.loaded || row?.state === "loaded";
    const needsContextReload = rowLoaded && loadedContextLength > 0 && loadedContextLength < contextLength;
    if (rowLoaded) {
      if (needsContextReload) {
        onProgress({ phase: "reloading_model", model: matchedId, modelState: `ctx ${loadedContextLength}` });
        await unloadNativeLlmModel(settings, row.instanceId || row.id, controller.signal);
        await unloadOtherLoadedLlmModels(settings, rows, matchedId, controller.signal, onProgress);
        const payload = await loadNativeLlmModel(settings, matchedId, controller.signal, contextLength);
        onProgress({ phase: "generating", model: matchedId, modelLoaded: true });
        return { model: matchedId, alreadyLoaded: false, payload };
      }
      await unloadOtherLoadedLlmModels(settings, rows, matchedId, controller.signal, onProgress);
      onProgress({ phase: "generating", model: matchedId, modelLoaded: true });
      return { model: matchedId, alreadyLoaded: true };
    }

    if (row) await unloadOtherLoadedLlmModels(settings, rows, matchedId, controller.signal, onProgress);
    onProgress({ phase: "loading_model", model: matchedId, modelState: row?.state || "not-loaded" });
    const payload = await loadNativeLlmModel(settings, matchedId, controller.signal, contextLength);
    onProgress({ phase: "generating", model: matchedId, modelLoaded: true });
    return { model: matchedId, alreadyLoaded: false, payload };
  } catch (error) {
    throw new Error(`Could not load ${locationLabel} model "${model}": ${error.message}`);
  } finally {
    cleanup();
  }
}

export async function ensureRemoteModelLoaded(settings, model, signal, onProgress = () => {}) {
  if (!isRemoteLlmProvider(settings.provider)) return null;
  return ensureLlmModelLoaded(settings, model, signal, onProgress);
}

function modelMatchKey(model) {
  return String(model || "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

function modelBaseKey(model) {
  return modelMatchKey(String(model || "").trim().replace(/@[^/\\]+$/i, "").split(/[\\/]/).pop());
}

function modelVariantScore(model) {
  const value = String(model || "").toLowerCase();
  const quant = value.match(/@q(\d+(?:\.\d+)?)/);
  return quant ? Number(quant[1]) || 0 : 0;
}

export function matchConfiguredModel(configuredModel, models = []) {
  const configured = String(configuredModel || "").trim();
  if (!configured) return "";
  const values = models.map(String).filter(Boolean);
  const configuredBaseKey = modelBaseKey(configured);
  const variants = configured.includes("@")
    ? []
    : values.filter((model) => modelBaseKey(model) === configuredBaseKey);
  return values.find((model) => model === configured)
    || values.find((model) => model.toLowerCase() === configured.toLowerCase())
    || values.find((model) => modelMatchKey(model) === modelMatchKey(configured))
    || variants.sort((a, b) => modelVariantScore(b) - modelVariantScore(a))[0]
    || "";
}

export async function resolveLlmModel(llm) {
  const settings = normalizeLlmSettings(llm);
  const models = await listLlmModels(settings);
  if (settings.model) return matchConfiguredModel(settings.model, models) || settings.model;
  return models.find((model) => !/embed|embedding/i.test(model)) || models[0] || "";
}

function chatCompletionEndpoints(settings) {
  const remoteProvider = isRemoteLlmProvider(settings.provider);
  const lmStudioRuntime = isLmStudioRuntime(settings);
  return remoteProvider
    ? (lmStudioRuntime ? [
        { type: "lmstudio-v0", url: `${lmStudioNativeBaseUrl(settings.baseUrl)}/api/v0/chat/completions` },
        { type: "openai-v1", url: `${settings.baseUrl}/chat/completions` }
      ] : [
        { type: "openai-v1", url: `${settings.baseUrl}/chat/completions` }
      ])
    : [
        { type: "openai-v1", url: `${settings.baseUrl}/chat/completions` }
      ];
}

function qwenNoThinkingOptions(settings, requestModel) {
  const remoteProvider = isRemoteLlmProvider(settings.provider);
  const lmStudioRuntime = isLmStudioRuntime(settings);
  const model = String(requestModel || settings.model || "").toLowerCase();
  const qwen3Local = !remoteProvider && model.includes("qwen3");
  const qwen3Remote = remoteProvider && model.includes("qwen3");
  if (!remoteProvider && !qwen3Local) return {};
  if (remoteProvider && !lmStudioRuntime && !qwen3Remote) return {};

  return {
    ...(remoteProvider && lmStudioRuntime ? {
      reasoning_effort: "none",
      reasoning: { effort: "none" }
    } : {}),
    enable_thinking: false,
    chat_template_kwargs: { enable_thinking: false }
  };
}

export function chatCompletionBody(settings, requestModel, messages, stream = false) {
  const remoteProvider = isRemoteLlmProvider(settings.provider);
  const maxTokens = remoteProvider
    ? Math.max(Number(settings.maxTokens || 0), remoteMinCompletionTokens)
    : settings.maxTokens;
  return JSON.stringify({
    model: requestModel,
    messages,
    temperature: settings.temperature,
    max_tokens: maxTokens,
    ...(stream ? { stream: true } : {}),
    ...(remoteProvider && isLmStudioRuntime(settings) ? {
      ttl: Math.max(300, Number(settings.timeoutSeconds || 300))
    } : {}),
    ...qwenNoThinkingOptions(settings, requestModel)
  });
}

async function prepareChatCompletionRequest({ llm, messages, signal, onProgress = () => {}, stream = false }) {
  const settings = normalizeLlmSettings(llm);
  if (!settings.enabled) throw new Error("LLM is disabled");

  const model = await resolveLlmModel(settings);
  if (!model) throw new Error("No LLM model is available");
  const loaded = await ensureLlmModelLoaded(settings, model, signal, onProgress);
  const requestModel = loaded?.model || model;

  const { controller, cleanup } = withTimeout(settings.timeoutSeconds, signal);
  return {
    settings,
    requestModel,
    controller,
    cleanup,
    body: chatCompletionBody(settings, requestModel, messages, stream),
    endpoints: chatCompletionEndpoints(settings)
  };
}

function compactLlmResponseError(response, text) {
  let message = text;
  try {
    const payload = text ? JSON.parse(text) : null;
    message = payload?.error?.message || payload?.message || text;
  } catch {
    message = text;
  }
  return `LLM endpoint returned ${response.status}${message ? `: ${message}` : ""}`;
}

export async function chatCompletion({ llm, messages, signal, onProgress = () => {} }) {
  const {
    settings,
    requestModel,
    controller,
    cleanup,
    body,
    endpoints
  } = await prepareChatCompletionRequest({ llm, messages, signal, onProgress });

  let lastError;
  try {
    for (const endpoint of endpoints) {
      try {
        const response = await fetch(endpoint.url, {
          method: "POST",
          headers: llmHeaders(settings),
          signal: controller.signal,
          body
        });

        if (!response.ok) {
          const text = await response.text().catch(() => "");
          throw new Error(compactLlmResponseError(response, text));
        }

        const payload = await response.json();
        const message = payload.choices?.[0]?.message || {};
        const content = String(message.content || "").trim();
        const reasoningContent = String(message.reasoning_content || "").trim();
        if (!content && reasoningContent) {
          const finishReason = payload.choices?.[0]?.finish_reason || "";
          const usage = payload.usage || {};
          const reasoningTokens = usage.completion_tokens_details?.reasoning_tokens;
          const completionTokens = usage.completion_tokens;
          const error = new Error([
            "Remote LM Studio returned reasoning_content without final content.",
            `finish_reason=${finishReason || "unknown"}`,
            `completion_tokens=${completionTokens || "unknown"}`,
            `reasoning_tokens=${reasoningTokens || "unknown"}`,
            "The model spent the completion budget on thinking and did not reach the answer."
          ].join(" "));
          error.noEndpointRetry = true;
          throw error;
        }

        return {
          model: requestModel,
          text: content,
          endpoint: endpoint.type,
          stats: payload.stats || null,
          usage: payload.usage || null,
          modelInfo: payload.model_info || payload.modelInfo || null,
          runtime: payload.runtime || null
        };
      } catch (error) {
        lastError = error;
        if (controller.signal.aborted || error.noEndpointRetry) throw error;
      }
    }

    throw lastError || new Error("LLM endpoint failed");
  } finally {
    cleanup();
  }
}

function parseStreamPayload(payload) {
  const choice = payload?.choices?.[0] || {};
  const delta = choice.delta || {};
  const token = delta.content ?? choice.text ?? "";
  const messageText = choice.message?.content ?? "";
  return {
    token: typeof token === "string" ? token : "",
    messageText: typeof messageText === "string" ? messageText : ""
  };
}

async function readOpenAiChatStream(response, onToken = () => {}) {
  if (!response.body) throw new Error("LLM stream response has no body");

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let text = "";
  let usage = null;
  let stats = null;
  let modelInfo = null;
  let runtime = null;

  const consumeBlock = (block) => {
    const data = block
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).replace(/^ /, ""))
      .join("\n")
      .trim();

    if (!data || data === "[DONE]") return;

    let payload = null;
    try {
      payload = JSON.parse(data);
    } catch {
      return;
    }

    const parsed = parseStreamPayload(payload);
    const token = parsed.token || parsed.messageText;
    if (token) {
      text += token;
      onToken(token);
    }
    usage = payload.usage || usage;
    stats = payload.stats || stats;
    modelInfo = payload.model_info || payload.modelInfo || modelInfo;
    runtime = payload.runtime || runtime;
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n").replace(/\r/g, "\n");

    let boundary = buffer.indexOf("\n\n");
    while (boundary >= 0) {
      const block = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      consumeBlock(block);
      boundary = buffer.indexOf("\n\n");
    }
  }

  buffer += decoder.decode().replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  if (buffer.trim()) consumeBlock(buffer);

  return {
    text: text.trim(),
    usage,
    stats,
    modelInfo,
    runtime
  };
}

export async function chatCompletionStream({ llm, messages, signal, onProgress = () => {}, onToken = () => {} }) {
  const {
    settings,
    requestModel,
    controller,
    cleanup,
    body,
    endpoints
  } = await prepareChatCompletionRequest({ llm, messages, signal, onProgress, stream: true });

  let lastError;
  let emittedToken = false;
  try {
    for (const endpoint of endpoints) {
      try {
        const response = await fetch(endpoint.url, {
          method: "POST",
          headers: llmHeaders(settings),
          signal: controller.signal,
          body
        });

        if (!response.ok) {
          const text = await response.text().catch(() => "");
          throw new Error(compactLlmResponseError(response, text));
        }

        const streamResult = await readOpenAiChatStream(response, (token) => {
          emittedToken = true;
          onToken(token);
        });
        if (!streamResult.text) {
          throw new Error("LLM stream endpoint returned no final content");
        }

        return {
          model: requestModel,
          text: streamResult.text,
          endpoint: endpoint.type,
          stats: streamResult.stats,
          usage: streamResult.usage,
          modelInfo: streamResult.modelInfo,
          runtime: streamResult.runtime,
          streamed: true
        };
      } catch (error) {
        lastError = error;
        if (controller.signal.aborted || error.noEndpointRetry || emittedToken) throw error;
      }
    }

    if (!emittedToken) {
      const fallback = await chatCompletion({ llm, messages, signal, onProgress });
      if (fallback.text) onToken(fallback.text);
      return {
        ...fallback,
        streamed: false,
        streamFallback: true
      };
    }

    throw lastError || new Error("LLM stream endpoint failed");
  } finally {
    cleanup();
  }
}

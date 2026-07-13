import { api, apiErrorMessage, apiStream } from "./modules/api-client.js";
import { citedSourceNumbers, citationEvidenceForNumber, compactSources, displayedSourcesForAnswer, fileName, uniqueSources } from "./modules/citation-helpers.js";
import {
  compactRagDebug,
  folderName,
  formatFileSize,
  formatGenerationStats,
  formatLatency,
  formatMs,
  formatResponseMeta,
  formatRouteWait,
  pluralRu
} from "./modules/formatting-helpers.js";
import {
  modelMatchKey,
  modelOptionLabel,
  preferredEmbeddingModel,
  preferredLocalModel,
  preferredRemoteModel,
  remoteModelRowScore,
  sortLocalModels
} from "./modules/settings-helpers.js";

const state = {
  sources: [],
  selectedSourceId: "",
  settingsSourceId: "",
  sourceTitleEditing: false,
  sourceTitleEditSourceId: "",
  addingSource: false,
  skippedSourceId: "",
  selectedSourcePath: "",
  sourceListTab: "contract",
  sourceSelectionMode: false,
  selectedSourceIds: new Set(),
  deletingSourceIds: new Set(),
  storagePath: "",
  storageEnvLocked: false,
  llm: {},
  embeddings: {},
  vectorStore: {},
  backendProcessStatus: { running: true, manageable: true, state: "running" },
  reranker: {},
  rerankerProcessStatus: null,
  qdrantProcessStatus: null,
  integrationsStatus: null,
  difyStatus: null,
  indexOverview: null,
  audit: {
    loading: false,
    updatedAt: 0,
    error: "",
    // Живая лента: копим файлы, которые проходят через обработку (бэкенд отдаёт
    // только текущий файл на источник, истории у него нет).
    feed: [],
    recent: {
      loading: false,
      error: "",
      files: [],
      updatedAt: 0
    }
  },
  llmUsage: null,
  localLmStatus: null,
  remoteLmStatus: null,
  remoteDiagnostics: null,
  llmEditing: false,
  vectorStoreEditing: false,
  rerankerEditing: false,
  indexedFiles: {
    sourceId: "",
    loading: false,
    loaded: false,
    error: "",
    total: 0,
    searchable: 0,
    chunks: 0,
    refreshedAt: 0,
    files: []
  },
  expandedIndexedFolders: new Set([""]),
  skipped: null,
  skippedLoading: false,
  chatSessions: [],
  chatHistoryMode: "active",
  chatHistoryQuery: "",
  sidebarCollapsed: false,
  activeChatId: "",
  chatRequest: {
    controller: null,
    pendingMessage: null,
    statusTimer: null,
    startedAt: 0
  },
  agentStatus: {
    requestedAt: 0,
    pollTimer: null,
    latestRun: null
  },
  rerankerProcessPollTimer: null,
  qdrantProcessPollTimer: null,
  activeServiceMenu: "",
  indexPollJobId: "",
  indexPollTimer: null,
  indexProgressHideTimer: null,
  indexStopRequested: false,
  previewRequestId: 0,
  tenderSync: {
    summary: null,
    selectedTenderLinks: new Map(),
    excludedAutoLinks: new Map()
  },
  folderPicker: {
    currentPath: "",
    parentPath: "",
    resolve: null
  }
};

const $ = (selector) => document.querySelector(selector);
let indexedFileContextMenu = null;
let sourceViewerPreviousFocus = null;
const CHAT_HISTORY_KEY = "local-rag-chat-history-v1";
const ACTIVE_CHAT_KEY = "local-rag-active-chat-v1";
const SIDEBAR_COLLAPSED_KEY = "locus-sidebar-collapsed-v1";
const REMOTE_LM_DEFAULT_BASE_URL = "https://example-lm-studio/v1";
const REMOTE_LM_DEFAULT_MODEL = "qwen3.6-27b-mtp";
const REMOTE_AUTO_TIMEOUT_SECONDS = 300;
const SETTINGS_TABS = new Set(["general", "sources", "llm", "indexes", "audit"]);
// Название раздела показывает только строка вкладок; в шапке — описание раздела,
// чтобы заголовок не дублировался.
const SETTINGS_TAB_SUBTITLES = {
  sources: "Папки договоров и тендеров, индексация и файлы индекса",
  llm: "Маршрутизация запросов и контроль передачи фрагментов документов",
  indexes: "Векторное хранилище, reranker и диагностика retrieval",
  general: "Локальное хранилище данных портала",
  audit: "Состояние обработки, локальные сервисы и системные операции"
};
const LLM_EDITABLE_CONTROL_IDS = [
  "llm-enabled",
  "llm-provider",
  "remote-context-enabled",
  "remote-fallback-local",
  "llm-base-url",
  "llm-model",
  "embedding-model",
  "remote-llm-base-url",
  "remote-llm-runtime",
  "remote-llm-token",
  "remote-llm-model",
  "load-llm-models",
  "load-remote-llm-models",
  "llm-save-button"
];
const VECTOR_STORE_EDITABLE_CONTROL_IDS = [
  "vector-store-enabled",
  "vector-store-provider",
  "qdrant-distance",
  "qdrant-url",
  "qdrant-collection",
  "qdrant-batch-size",
  "qdrant-api-key",
  "vector-store-save-button"
];
const RERANKER_EDITABLE_CONTROL_IDS = [
  "reranker-enabled",
  "reranker-url",
  "reranker-model",
  "reranker-candidates",
  "reranker-max-chars",
  "reranker-timeout",
  "reranker-api-key",
  "reranker-save-button"
];

function setSelectOptions(selector, models = [], selected = "", emptyLabel = "Модели не загружены") {
  const select = $(selector);
  if (!select) return "";
  const optionModels = selector === "#llm-model" ? sortLocalModels(models) : models;
  const values = optionModels
    .map((item) => (typeof item === "string" ? item : item?.id))
    .map(String)
    .filter(Boolean);
  select.innerHTML = "";
  if (!values.length) {
    const option = document.createElement("option");
    option.value = selected || "";
    option.textContent = selected || emptyLabel;
    select.append(option);
    select.value = option.value;
    return option.value;
  }

  for (const model of values) {
    const option = document.createElement("option");
    option.value = model;
    option.textContent = model;
    select.append(option);
  }

  const nextValue = values.includes(selected) ? selected : values[0];
  select.value = nextValue;
  return nextValue;
}

function remoteChatModelRows(payload = state.remoteDiagnostics) {
  const rows = Array.isArray(payload?.models?.items) ? payload.models.items : [];
  const byId = new Map();
  for (const row of rows) {
    const id = String(row?.id || "").trim();
    if (!id || /embed|embedding/i.test(`${id} ${row?.type || ""}`)) continue;
    if (!byId.has(id)) byId.set(id, row);
  }
  return Array.from(byId.values()).sort((a, b) => remoteModelRowScore(b) - remoteModelRowScore(a));
}

function setRemoteModelOptionsFromRows(rows = [], selected = "") {
  const select = $("#remote-llm-model");
  if (!select) return "";

  const chatRows = rows.filter((row) => row?.id && !/embed|embedding/i.test(`${row.id} ${row.type || ""}`));
  if (!chatRows.length) {
    return setSelectOptions("#remote-llm-model", selected ? [selected] : [], selected || REMOTE_LM_DEFAULT_MODEL, "Удаленные модели не загружены");
  }

  const previous = selected || select.value || state.llm.remote?.model || "";
  select.innerHTML = "";
  for (const row of chatRows) {
    const option = document.createElement("option");
    option.value = row.id;
    option.textContent = modelOptionLabel(row);
    select.append(option);
  }

  const values = chatRows.map((row) => row.id);
  const nextValue = values.includes(previous) ? previous : preferredRemoteModel(chatRows, previous);
  select.value = nextValue;
  return nextValue;
}

function setText(selector, value) {
  const element = $(selector);
  if (element) element.textContent = value;
}

const INDEX_STATUS_TONES = ["ready", "running", "warning", "error", "empty", "checking"];

function setIndexStatusBarTone(target, tone = "checking") {
  const bar = typeof target === "string" ? $(target) : target;
  if (!bar) return;
  bar.classList.remove(...INDEX_STATUS_TONES.map((item) => `is-${item}`));
  bar.classList.add(`is-${INDEX_STATUS_TONES.includes(tone) ? tone : "checking"}`);
}

function indexStatusTone(status = {}) {
  const health = indexHealthStatus(status);
  if (health === "stale") return "warning";
  if (health === "interrupted") return "error";
  if (status.status === "running") return "running";
  if (status.status === "failed") return "error";
  if (status.status === "cancelled") return "warning";
  if (sourceHasReadyIndex(status)) return "ready";
  return "empty";
}

function formatCount(value) {
  const number = Number(value || 0);
  return Number.isFinite(number) ? number.toLocaleString("ru-RU") : "0";
}

function setIndexOverviewStatus(status, text, title = text) {
  const box = $("#settings-index-overview");
  if (!box) return;
  if (!box.classList.contains("has-progress") || status === "running") {
    setIndexStatusBarTone(box, status || "checking");
  }
  setText("#settings-index-overview-text", text);
  box.title = title || text;
}

function qdrantOverviewLabel(qdrant = {}) {
  if (!qdrant.enabled) return "Qdrant: выключен";
  if (!qdrant.available) return qdrant.error ? `Qdrant: недоступен` : "Qdrant: нет связи";
  const points = qdrant.points === null || qdrant.points === undefined
    ? "точек нет данных"
    : `${formatCount(qdrant.points)} точек`;
  return `Qdrant: ${points}`;
}

function renderIndexOverviewStatus(payload = state.indexOverview) {
  if (!$("#settings-index-overview")) return;
  if (!payload) {
    setIndexOverviewStatus("checking", "Распознавание: загрузка...");
    return;
  }

  const files = payload.files || {};
  const qdrant = payload.qdrant || {};
  const running = payload.running || {};
  const issues = payload.issues || {};
  const recognized = Number(files.recognized || 0);
  const total = Number(files.total || 0);
  const indexed = Number(files.indexed || 0);
  const chunks = Number(files.chunks || 0);
  const failed = Number(files.failed || 0);
  const skipped = Number(files.skipped || 0);
  const denominator = total || indexed;
  const percent = denominator ? Math.round((recognized / denominator) * 100) : 0;
  const parts = [
    `Распознано ${formatCount(recognized)}/${formatCount(denominator)}`,
    denominator ? `${percent}%` : "",
    indexed && indexed !== recognized ? `в индексе ${formatCount(indexed)}` : "",
    chunks ? `${formatCount(chunks)} фрагм.` : "",
    qdrantOverviewLabel(qdrant)
  ].filter(Boolean);

  if (running.jobs) {
    const runningProgress = running.total
      ? `${formatCount(running.processed)}/${formatCount(running.total)}`
      : `${formatCount(running.jobs)} job`;
    parts.push(`идёт: ${runningProgress}`);
  }
  if (failed) parts.push(`ошибки ${formatCount(failed)}`);
  if (skipped) parts.push(`пропущено ${formatCount(skipped)}`);

  if (running.stale) parts.push(`\u043d\u0435\u0442 \u043e\u0431\u043d\u043e\u0432\u043b\u0435\u043d\u0438\u0439 ${formatCount(running.stale)}`);
  if (issues.interruptedJobs) parts.push(`\u043f\u0440\u0435\u0440\u0432\u0430\u043d\u043e ${formatCount(issues.interruptedJobs)}`);

  const titleParts = [
    `Распознано файлов: ${formatCount(recognized)} из ${formatCount(denominator)}`,
    `Индексированных файлов: ${formatCount(indexed)}`,
    `Фрагментов: ${formatCount(chunks)}`,
    qdrantOverviewLabel(qdrant),
    running.lastProgressAt ? `\u041f\u043e\u0441\u043b\u0435\u0434\u043d\u0438\u0439 \u043f\u0440\u043e\u0433\u0440\u0435\u0441\u0441: ${shortDateTime(running.lastProgressAt)}` : "",
    running.stale ? `\u0417\u0430\u0434\u0430\u0447 \u0431\u0435\u0437 \u043e\u0431\u043d\u043e\u0432\u043b\u0435\u043d\u0438\u0439: ${formatCount(running.stale)}` : "",
    issues.interruptedJobs ? `\u041f\u0440\u0435\u0440\u0432\u0430\u043d\u043d\u044b\u0445 \u0437\u0430\u0434\u0430\u0447: ${formatCount(issues.interruptedJobs)}` : "",
    qdrant.collection ? `Коллекция: ${qdrant.collection}` : "",
    qdrant.error ? `Ошибка Qdrant: ${qdrant.error}` : "",
    files.unknownSources ? `Источников без известного общего числа файлов: ${formatCount(files.unknownSources)}` : ""
  ].filter(Boolean);

  let status = payload.status || "empty";
  if (running.jobs) status = running.stale ? "warning" : "running";
  if (qdrant.enabled && !qdrant.available) status = status === "empty" ? "error" : "warning";
  if (failed && status === "ready") status = "warning";
  if (issues.interruptedJobs && status === "empty") status = "warning";
  setIndexOverviewStatus(status, parts.join(" · "), titleParts.join(" · "));
}

async function refreshIndexOverviewStatus(options = {}) {
  if (!$("#settings-index-overview")) return;
  if (!options.silent) setIndexOverviewStatus("checking", "Распознавание: обновление...");
  try {
    const payload = await api("/api/index/status");
    state.indexOverview = payload;
    renderIndexOverviewStatus(payload);
    renderAuditPanel();
  } catch (error) {
    state.indexOverview = null;
    setIndexOverviewStatus("error", apiErrorMessage(error, "Не удалось получить сводку распознавания"));
    renderAuditPanel();
  }
}

async function refreshAllIndexState() {
  const button = $("#index-refresh-all");
  if (button) button.disabled = true;
  setIndexOverviewStatus("checking", "Обновляю статусы индекса...");
  setText("#job-status", "Обновляю статусы всех найденных индексов...");

  try {
    const payload = await api("/api/index/refresh", { method: "POST" });
    if (Array.isArray(payload.sources)) {
      state.sources = payload.sources;
      syncSelectedSourceIdsWithSources();
      renderSources();
    } else {
      await loadSources();
    }
    state.indexOverview = payload.overview || null;
    renderIndexOverviewStatus(state.indexOverview);
    const settingsSource = selectedSettingsSource();
    if (settingsSource) loadIndexedFiles(settingsSource.id, { force: true, silent: true });
    const refreshed = Number(payload.refreshedSources || 0);
    const skipped = Number(payload.skippedEmpty || 0) + Number(payload.skippedRunning || 0);
    setText("#job-status", `Статусы обновлены: ${formatCount(refreshed)} источников${skipped ? `, пропущено ${formatCount(skipped)}` : ""}.`);
  } catch (error) {
    setIndexOverviewStatus("error", apiErrorMessage(error, "Не удалось обновить статусы индекса"));
    setText("#job-status", apiErrorMessage(error, "Не удалось обновить статусы индекса"));
  } finally {
    if (button) button.disabled = false;
  }
}

function normalizeAppPath(pathname = window.location.pathname) {
  const path = String(pathname || "/").replace(/\/+$/, "") || "/";
  if (path === "/") return "/chat";
  if (path === "/chat") return "/chat";
  if (path === "/settings") return "/settings/sources";

  const settingsMatch = path.match(/^\/settings\/([^/]+)$/);
  if (settingsMatch) {
    const tabName = SETTINGS_TABS.has(settingsMatch[1]) ? settingsMatch[1] : "sources";
    return `/settings/${tabName}`;
  }

  return "/chat";
}

function routeFromLocation() {
  const path = normalizeAppPath();
  if (path.startsWith("/settings/")) {
    return {
      page: "settings",
      tabName: path.split("/").pop() || "sources"
    };
  }

  return { page: "chat", tabName: "" };
}

function navigateToPath(pathname, options = {}) {
  const nextPath = normalizeAppPath(pathname);
  if (window.location.pathname !== nextPath) {
    window.history[options.replace ? "replaceState" : "pushState"]({}, "", nextPath);
  }
  applyRoute();
}

function applyRoute() {
  const nextPath = normalizeAppPath();
  if (window.location.pathname !== nextPath) {
    window.history.replaceState({}, "", nextPath);
  }

  const route = routeFromLocation();
  if (route.page === "settings") {
    openSettings(route.tabName, { updateRoute: false });
    return;
  }

  closeSettings({ updateRoute: false });
}

function controlValue(selector) {
  return String($(selector)?.value || "").trim();
}

function providerStatusReady(status, options = {}) {
  if (!status?.online) return false;
  if (status.chatModelAvailable === false) return false;
  if (options.embeddings && status.embeddingModelAvailable === false) return false;
  return true;
}

function isLlmConfiguredAndWorking() {
  if (!($("#llm-enabled")?.checked ?? Boolean(state.llm.enabled))) return false;
  if (controlValue("#remote-llm-token")) return false;

  const provider = controlValue("#llm-provider") || state.llm.provider || "local";
  const remoteContextEnabled = $("#remote-context-enabled")?.checked ?? Boolean(state.llm.remote?.enabled || state.llm.allowRemoteContext);
  const remoteConfigured = Boolean(state.llm.remote?.hasApiKey)
    && Boolean(controlValue("#remote-llm-base-url"))
    && Boolean(controlValue("#remote-llm-model"));
  const localConfigured = Boolean(controlValue("#llm-base-url"))
    && Boolean(controlValue("#llm-model"))
    && Boolean(controlValue("#embedding-model"));
  const localReady = localConfigured && providerStatusReady(state.localLmStatus, { embeddings: true });
  const remoteReady = remoteContextEnabled && remoteConfigured && providerStatusReady(state.remoteLmStatus);

  if (provider === "remote") return remoteReady;
  return localReady;
}

function syncRemoteContextWarning() {
  const enabled = $("#remote-context-enabled")?.checked ?? Boolean(state.llm.remote?.enabled || state.llm.allowRemoteContext);
  const warning = $("#remote-context-warning");
  if (warning) warning.hidden = !enabled;
}

function syncLlmRouteCards() {
  const provider = controlValue("#llm-provider") || state.llm.provider || "local";
  document.querySelectorAll("[data-llm-route]").forEach((button) => {
    button.setAttribute("aria-pressed", String(button.dataset.llmRoute === provider));
  });
}

function syncLlmSecretPlaceholder() {
  const remote = state.llm.remote || {};
  const tokenInput = $("#remote-llm-token");
  if (!tokenInput) return;
  tokenInput.value = "";
  tokenInput.placeholder = remote.hasApiKey ? "Токен сохранен локально; новый ввод заменит" : "Bearer token";
}

function syncLlmFormLock() {
  const locked = !state.llmEditing && isLlmConfiguredAndWorking();
  for (const id of LLM_EDITABLE_CONTROL_IDS) {
    const element = document.getElementById(id);
    if (element) element.disabled = locked;
  }
  document.querySelectorAll("[data-llm-route]").forEach((button) => {
    button.disabled = locked;
  });

  $("#llm-form")?.classList.toggle("is-locked", locked);
  const editButton = $("#edit-llm-settings");
  if (editButton) editButton.hidden = !locked;
  if (locked) {
    setText("#llm-status", "Доступы проверены. Чтобы изменить поля, нажмите «Редактировать».");
  }
}

function setLlmEditing(isEditing) {
  state.llmEditing = Boolean(isEditing);
  syncLlmFormLock();
  if (state.llmEditing) {
    setText("#llm-status", "Режим редактирования включен.");
    $("#llm-base-url")?.focus();
  }
}

function syncVectorStoreSecretPlaceholder() {
  const qdrant = state.vectorStore.qdrant || {};
  const apiKeyInput = $("#qdrant-api-key");
  if (!apiKeyInput) return;
  apiKeyInput.value = "";
  apiKeyInput.placeholder = qdrant.hasApiKey ? "Ключ сохранен; новый ввод заменит" : "Локальный Qdrant: оставьте пустым";
}

function syncRerankerSecretPlaceholder() {
  const apiKeyInput = $("#reranker-api-key");
  if (!apiKeyInput) return;
  apiKeyInput.value = "";
  apiKeyInput.placeholder = state.reranker.hasApiKey ? "Ключ сохранен; новый ввод заменит" : "Локальный reranker: оставьте пустым";
}

function isVectorStoreConfiguredAndWorking() {
  if (controlValue("#qdrant-api-key")) return false;

  const enabled = $("#vector-store-enabled")?.checked ?? state.vectorStore.enabled !== false;
  const provider = controlValue("#vector-store-provider") || state.vectorStore.provider || "auto";
  if (!enabled || provider === "json") return true;

  const hasRequiredFields = Boolean(
    controlValue("#qdrant-url")
    && controlValue("#qdrant-collection")
    && Number(controlValue("#qdrant-batch-size"))
  );
  const vectorStore = state.integrationsStatus?.vectorStore || {};
  return hasRequiredFields && vectorStore.qdrantEnabled && vectorStore.qdrantAvailable;
}

function isRerankerConfigured() {
  if (controlValue("#reranker-api-key")) return false;

  const enabled = $("#reranker-enabled")?.checked ?? Boolean(state.reranker.enabled);
  if (!enabled) return true;

  const hasRequiredFields = Boolean(
    controlValue("#reranker-url")
    && controlValue("#reranker-model")
    && Number(controlValue("#reranker-candidates"))
    && Number(controlValue("#reranker-max-chars"))
    && Number(controlValue("#reranker-timeout"))
  );
  return hasRequiredFields && Boolean(state.integrationsStatus?.reranker?.configured);
}

function syncFormLock(formSelector, controlIds, editButtonSelector, locked) {
  for (const id of controlIds) {
    const element = document.getElementById(id);
    if (element) element.disabled = locked;
  }

  $(formSelector)?.classList.toggle("is-locked", locked);
  const editButton = $(editButtonSelector);
  if (editButton) editButton.hidden = !locked;
}

function syncIndexFormLocks() {
  const vectorLocked = !state.vectorStoreEditing && isVectorStoreConfiguredAndWorking();
  syncFormLock("#vector-store-form", VECTOR_STORE_EDITABLE_CONTROL_IDS, "#edit-vector-store-settings", vectorLocked);
  if (vectorLocked) {
    setText("#vector-store-status", "Индекс проверен. Чтобы изменить поля, нажмите «Редактировать».");
  }

  const rerankerLocked = !state.rerankerEditing && isRerankerConfigured();
  syncFormLock("#reranker-form", RERANKER_EDITABLE_CONTROL_IDS, "#edit-reranker-settings", rerankerLocked);
  if (rerankerLocked) {
    setText("#reranker-status", "Reranker настроен. Чтобы изменить поля, нажмите «Редактировать».");
  }
}

function setVectorStoreEditing(isEditing) {
  state.vectorStoreEditing = Boolean(isEditing);
  syncIndexFormLocks();
  if (state.vectorStoreEditing) {
    setText("#vector-store-status", "Режим редактирования включен.");
    $("#qdrant-url")?.focus();
  }
}

function setRerankerEditing(isEditing) {
  state.rerankerEditing = Boolean(isEditing);
  syncIndexFormLocks();
  if (state.rerankerEditing) {
    setText("#reranker-status", "Режим редактирования включен.");
    $("#reranker-url")?.focus();
  }
}

function clearSourceTitleEditing() {
  state.sourceTitleEditing = false;
  state.sourceTitleEditSourceId = "";
}

function isSourceTitleEditing(source) {
  return Boolean(source?.id && state.sourceTitleEditing && state.sourceTitleEditSourceId === source.id);
}

function setSourceTitleEditing(isEditing, sourceId = selectedSettingsSource()?.id || "") {
  state.sourceTitleEditing = Boolean(isEditing && sourceId);
  state.sourceTitleEditSourceId = state.sourceTitleEditing ? sourceId : "";
  renderSources();
  if (state.sourceTitleEditing) {
    requestAnimationFrame(() => {
      const input = document.querySelector(".source-title-edit-input");
      input?.focus();
      input?.select();
    });
  }
}

function setSourceViewerOpen(isOpen) {
  const viewer = $("#source-viewer");
  const wasOpen = Boolean(viewer && !viewer.hidden);
  if (isOpen && !wasOpen) {
    sourceViewerPreviousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  }
  $(".app").classList.toggle("has-source-viewer", isOpen);
  viewer.hidden = !isOpen;
  if (isOpen && !wasOpen) {
    requestAnimationFrame(() => {
      if (viewer.hidden || viewer.contains(document.activeElement)) return;
      const focusable = modalFocusableElements(viewer);
      if (focusable.length) focusable[0].focus();
    });
  }
  if (!isOpen && wasOpen) {
    const returnTarget = sourceViewerPreviousFocus;
    sourceViewerPreviousFocus = null;
    if (returnTarget?.isConnected) requestAnimationFrame(() => returnTarget.focus());
  }
}

function resetSourcePreview() {
  state.previewRequestId += 1;
  document.querySelectorAll(".source-citation.active").forEach((citation) => citation.classList.remove("active"));
  $("#preview-title").textContent = "Источник не выбран";
  $("#source-preview").innerHTML = '<div class="empty">Нажмите на ссылку файла в чате, чтобы открыть фрагмент справа.</div>';
  setSourceViewerOpen(false);
}

function sourceTitle(sourceId) {
  return state.sources.find((source) => source.id === sourceId)?.title || "Авто";
}

function sourceById(sourceId) {
  return state.sources.find((source) => source.id === sourceId) || null;
}

// Сколько тендеров привязано к договору, по которому отвечали (для мета-строки ответа).
function linkedTenderCountForResponse(payload = {}) {
  const sourceId = payload.matchedSource?.id || state.selectedSourceId;
  const source = sourceId ? sourceById(sourceId) : null;
  return Array.isArray(source?.linkedTenders) ? source.linkedTenders.length : 0;
}

function contractSourceById(sourceId) {
  const source = sourceById(sourceId);
  return source && isContractSource(source) ? source : null;
}

function isContractSource(source) {
  return (source?.sourceType || "contract") !== "tender";
}

function contractSourcesForUi() {
  return state.sources.filter(isContractSource);
}

function tenderSourcesForUi() {
  return state.sources.filter((source) => !isContractSource(source));
}

function sourceTypeLabel(source) {
  return isContractSource(source) ? "Договор" : "Тендер";
}

function sourceTypeFromTab(tab = state.sourceListTab) {
  return tab === "tender" ? "tender" : "contract";
}

function syncNewSourceFormText() {
  const label = sourceTypeLabel({ sourceType: sourceTypeFromTab() }).toLowerCase();
  const title = $("#new-source-panel .panel-title");
  const submitButton = $("#source-form button[type='submit']");
  if (title) title.textContent = `\u0414\u043e\u0431\u0430\u0432\u0438\u0442\u044c ${label} \u0432 \u0442\u0435\u043a\u0443\u0449\u0438\u0439 RAG`;
  if (submitButton) submitButton.textContent = `\u0414\u043e\u0431\u0430\u0432\u0438\u0442\u044c ${label} \u0432 RAG`;
}

function sourceListTabForSource(source) {
  return isContractSource(source) ? "contract" : "tender";
}

function sourceListTabSources(tab = state.sourceListTab) {
  return tab === "tender" ? tenderSourcesForUi() : contractSourcesForUi();
}

function sourceListTabCounts() {
  return {
    contract: contractSourcesForUi().length,
    tender: tenderSourcesForUi().length
  };
}

function syncSourceListTabs() {
  const counts = sourceListTabCounts();
  setText("#source-tab-contracts-count", counts.contract);
  setText("#source-tab-tenders-count", counts.tender);
  document.querySelectorAll("[data-source-list-tab]").forEach((button) => {
    const active = button.dataset.sourceListTab === state.sourceListTab;
    button.classList.toggle("active", active);
    button.setAttribute("aria-selected", active ? "true" : "false");
  });
}

function ensureSettingsSourceVisibleInTab() {
  if (state.addingSource) return;
  const visibleSources = sourceListTabSources();
  if (visibleSources.some((source) => source.id === state.settingsSourceId)) return;
  state.settingsSourceId = visibleSources[0]?.id || "";
  clearSourceTitleEditing();
  state.expandedIndexedFolders = new Set([""]);
}

function setSourceListTab(tab) {
  const nextTab = tab === "tender" ? "tender" : "contract";
  if (state.sourceListTab === nextTab) return;
  state.sourceListTab = nextTab;
  clearSourceTitleEditing();
  state.sourceSelectionMode = false;
  state.selectedSourceIds.clear();
  ensureSettingsSourceVisibleInTab();
  renderSources();
}

function normalizedSourceTitle(title = "") {
  return String(title || "").trim().replace(/\s+/g, " ").toLowerCase();
}

function normalizedSourcePath(sourcePath = "") {
  return String(sourcePath || "").trim().replace(/\\/g, "/").toLowerCase();
}

function isLikelyTemporarySource(source) {
  const sourcePath = normalizedSourcePath(source?.path);
  return sourcePath.includes("/localai-auto-")
    || sourcePath.includes("/appdata/local/temp/")
    || sourcePath.startsWith("/tmp/");
}

function temporaryDuplicateSources(source) {
  if (!source || !isLikelyTemporarySource(source)) return [source].filter(Boolean);
  const title = normalizedSourceTitle(source.title);
  if (!title) return [source];
  const duplicates = state.sources.filter((item) => (
    normalizedSourceTitle(item.title) === title
    && isLikelyTemporarySource(item)
  ));
  return duplicates.length ? duplicates : [source];
}

function syncSelectedSourceIdsWithSources() {
  const existingIds = new Set(state.sources.map((source) => source.id));
  state.selectedSourceIds = new Set(
    [...state.selectedSourceIds].filter((sourceId) => existingIds.has(sourceId))
  );
}

function selectedBulkSources() {
  return state.sources.filter((source) => state.selectedSourceIds.has(source.id));
}

function setSourceSelectionMode(enabled) {
  state.sourceSelectionMode = Boolean(enabled);
  if (state.sourceSelectionMode) clearSourceTitleEditing();
  if (!state.sourceSelectionMode) state.selectedSourceIds.clear();
  renderSources();
}

function toggleSourceSelection(sourceId, checked = !state.selectedSourceIds.has(sourceId)) {
  if (!sourceId) return;
  if (checked) state.selectedSourceIds.add(sourceId);
  else state.selectedSourceIds.delete(sourceId);
  renderSources();
}

function renderSourceSelectionControls() {
  const selectedCount = selectedBulkSources().length;
  const selectButton = $("#source-select-mode");
  const deleteButton = $("#source-bulk-delete");
  const doneButton = $("#source-selection-done");
  if (!selectButton || !deleteButton || !doneButton) return;

  selectButton.hidden = state.sourceSelectionMode;
  selectButton.disabled = state.sources.length === 0 || state.addingSource;
  deleteButton.hidden = !state.sourceSelectionMode;
  deleteButton.disabled = selectedCount === 0 || state.deletingSourceIds.size > 0;
  deleteButton.textContent = selectedCount ? `Удалить (${selectedCount})` : "Удалить";
  doneButton.hidden = !state.sourceSelectionMode;
}

function selectedSettingsSource() {
  if (state.addingSource) return null;
  return sourceById(state.settingsSourceId);
}

function skippedModalSource() {
  return sourceById(state.skippedSourceId || state.selectedSourceId);
}

function makeId(prefix) {
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function makeChatTitle(text) {
  const clean = String(text || "").replace(/\s+/g, " ").trim();
  return clean ? clean.slice(0, 72) : "Новый чат";
}

function cleanChatTitle(value = "") {
  const clean = String(value || "")
    .replace(/^[\s"'«»`]+|[\s"'«»`.,:;!?]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return clean ? clean.slice(0, 72) : "";
}

function formatFullDateTime(value) {
  const date = value ? new Date(value) : null;
  if (!date || Number.isNaN(date.getTime())) return "";
  return date.toLocaleString("ru-RU", {
    day: "2-digit",
    month: "long",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  });
}

function historyMonthKey(value) {
  const date = value ? new Date(value) : null;
  if (!date || Number.isNaN(date.getTime())) return "unknown";
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
}

function historyMonthLabel(value) {
  const date = value ? new Date(value) : null;
  if (!date || Number.isNaN(date.getTime())) return "Без даты";
  const now = new Date();
  const currentMonth = date.getFullYear() === now.getFullYear() && date.getMonth() === now.getMonth();
  const label = date.toLocaleString("ru-RU", {
    month: "long",
    ...(currentMonth ? {} : { year: "numeric" })
  });
  return label.slice(0, 1).toUpperCase() + label.slice(1);
}

// Свежие чаты группируем по дням, старые — по месяцам (как было).
function historyDayDiff(date) {
  const startOfDay = (value) => new Date(value.getFullYear(), value.getMonth(), value.getDate()).getTime();
  return Math.round((startOfDay(new Date()) - startOfDay(date)) / 86400000);
}

function historyGroupKey(value) {
  const date = value ? new Date(value) : null;
  if (!date || Number.isNaN(date.getTime())) return "unknown";
  const days = historyDayDiff(date);
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 7) return "week";
  return historyMonthKey(value);
}

function historyGroupLabel(value) {
  const key = historyGroupKey(value);
  if (key === "today") return "Сегодня";
  if (key === "yesterday") return "Вчера";
  if (key === "week") return "На этой неделе";
  return historyMonthLabel(value);
}

// Короткая метка в строке чата: сегодня — время, эта неделя — день недели, дальше — дата.
function historyStamp(value) {
  const date = value ? new Date(value) : null;
  if (!date || Number.isNaN(date.getTime())) return "";
  const days = historyDayDiff(date);
  if (days <= 0) return date.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
  if (days === 1) return "вчера";
  if (days < 7) return date.toLocaleDateString("ru-RU", { weekday: "short" });
  const sameYear = date.getFullYear() === new Date().getFullYear();
  return date.toLocaleDateString("ru-RU", {
    day: "2-digit",
    month: "2-digit",
    ...(sameYear ? {} : { year: "2-digit" })
  });
}

function createChatSession(sourceId = "") {
  const now = new Date().toISOString();
  return {
    id: makeId("chat"),
    title: "Новый чат",
    titleSource: "",
    sourceId,
    createdAt: now,
    updatedAt: now,
    messages: []
  };
}

function activeChat() {
  return state.chatSessions.find((session) => session.id === state.activeChatId);
}

function ensureActiveChat() {
  let session = activeChat();
  if (session) return session;

  session = createChatSession();
  state.chatSessions.unshift(session);
  state.activeChatId = session.id;
  saveChatHistory();
  return session;
}

function saveChatHistory() {
  const compact = state.chatSessions
    .filter((session) => session.id === state.activeChatId || (session.messages || []).length)
    .sort((a, b) => new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0))
    .slice(0, 60);

  state.chatSessions = compact;
  localStorage.setItem(CHAT_HISTORY_KEY, JSON.stringify(compact));
  localStorage.setItem(ACTIVE_CHAT_KEY, state.activeChatId || "");
}

function visibleChatSessions() {
  return state.chatSessions
    .filter((session) => !session.archivedAt)
    .sort((a, b) => new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0));
}

function archivedChatSessions() {
  return state.chatSessions
    .filter((session) => Boolean(session.archivedAt))
    .sort((a, b) => new Date(b.archivedAt || b.updatedAt || 0) - new Date(a.archivedAt || a.updatedAt || 0));
}

function setChatHistoryMode(mode) {
  state.chatHistoryMode = mode === "archived" ? "archived" : "active";
  renderChatHistory();
}

function loadChatHistory() {
  try {
    const parsed = JSON.parse(localStorage.getItem(CHAT_HISTORY_KEY) || "[]");
    state.chatSessions = Array.isArray(parsed) ? parsed.filter((session) => session?.id) : [];
  } catch {
    state.chatSessions = [];
  }

  const activeId = localStorage.getItem(ACTIVE_CHAT_KEY) || "";
  state.activeChatId = state.chatSessions.some((session) => session.id === activeId && !session.archivedAt)
    ? activeId
    : (visibleChatSessions()[0]?.id || "");

  if (!state.activeChatId) {
    const session = createChatSession();
    state.chatSessions.unshift(session);
    state.activeChatId = session.id;
  }

  const session = activeChat();
  if (session?.sourceId && state.sources.some((source) => source.id === session.sourceId)) {
    state.selectedSourceId = session.sourceId;
    renderSources();
  }

  saveChatHistory();
  renderChatHistory();
  renderActiveChat();
}

function chatMatchesHistoryQuery(session, query) {
  if (!query) return true;
  const haystack = `${session.title || "Новый чат"} ${sourceTitle(session.sourceId)}`.toLocaleLowerCase("ru-RU");
  return haystack.includes(query);
}

// Строка чата: чип проекта (договор/тендер) + время последнего обновления.
function chatHistoryMetaNodes(session) {
  const nodes = [];
  const source = session.sourceId ? sourceById(session.sourceId) : null;
  const chip = document.createElement("span");
  chip.className = source
    ? `chat-history-project ${isContractSource(source) ? "chat-history-project--contract" : "chat-history-project--tender"}`
    : "chat-history-project chat-history-project--auto";
  chip.textContent = source ? source.title : "Авто";
  nodes.push(chip);

  const stamp = historyStamp(session.updatedAt || session.createdAt);
  if (stamp) {
    const time = document.createElement("span");
    time.className = "chat-history-time";
    time.textContent = stamp;
    nodes.push(time);
  }
  return nodes;
}

function renderChatHistory() {
  const list = $("#chat-history");
  if (!list) return;
  list.innerHTML = "";

  const archived = archivedChatSessions();
  const showingArchived = state.chatHistoryMode === "archived";
  const query = state.chatHistoryQuery.trim().toLocaleLowerCase("ru-RU");
  const allSessions = showingArchived ? archived : visibleChatSessions();
  const sessions = allSessions.filter((session) => chatMatchesHistoryQuery(session, query));
  const activeFilter = $("#history-filter-active");
  const archivedFilter = $("#history-filter-archived");
  if (activeFilter) activeFilter.setAttribute("aria-selected", String(!showingArchived));
  if (archivedFilter) archivedFilter.setAttribute("aria-selected", String(showingArchived));
  setText("#history-archive-count", archived.length ? `· ${archived.length}` : "");
  if (!sessions.length) {
    const emptyText = query
      ? "Ничего не найдено."
      : (showingArchived ? "Архив пуст." : "Истории пока нет.");
    list.innerHTML = `<div class="empty">${emptyText}</div>`;
    return;
  }

  let currentGroup = "";
  for (const session of sessions) {
    const stampSource = session.updatedAt || session.createdAt;
    const groupKey = historyGroupKey(stampSource);
    if (groupKey !== currentGroup) {
      currentGroup = groupKey;
      const month = document.createElement("div");
      month.className = "chat-history-month";
      month.textContent = historyGroupLabel(stampSource);
      list.append(month);
    }

    const item = document.createElement("div");
    item.className = `chat-history-item ${!showingArchived && session.id === state.activeChatId ? "active" : ""}`;
    item.innerHTML = `
      <button type="button" class="chat-history-select" ${showingArchived ? "disabled" : ""}>
        <span class="chat-history-title"></span>
        <span class="chat-history-meta"></span>
      </button>
      <div class="chat-history-actions">
        <button type="button" class="chat-history-menu-button" title="Действия" aria-label="Действия чата">⋯</button>
        <div class="chat-history-menu" role="menu">
          ${showingArchived
            ? '<button type="button" class="chat-history-restore" role="menuitem">Вернуть</button>'
            : '<button type="button" class="chat-history-archive" role="menuitem">В архив</button>'}
          <button type="button" class="chat-history-delete" role="menuitem">Удалить</button>
        </div>
      </div>
    `;
    const selectButton = item.querySelector(".chat-history-select");
    const fullStamp = formatFullDateTime(stampSource);
    if (fullStamp) selectButton.title = fullStamp;
    item.querySelector(".chat-history-title").textContent = session.title || "Новый чат";
    item.querySelector(".chat-history-meta").append(...chatHistoryMetaNodes(session));
    if (!showingArchived) {
      selectButton.addEventListener("click", () => setActiveChat(session.id));
      item.querySelector(".chat-history-archive").addEventListener("click", () => archiveChat(session.id));
    } else {
      item.querySelector(".chat-history-restore").addEventListener("click", () => restoreChat(session.id));
    }
    item.querySelector(".chat-history-delete").addEventListener("click", () => deleteChat(session.id));
    list.append(item);
  }
}

function setChatHistoryQuery(value) {
  state.chatHistoryQuery = String(value || "");
  renderChatHistory();
}

function applySidebarCollapsed() {
  const toggle = $("#sidebar-collapse");
  $(".app").classList.toggle("sidebar-collapsed", state.sidebarCollapsed);
  if (toggle) {
    toggle.textContent = state.sidebarCollapsed ? "»" : "«";
    toggle.title = state.sidebarCollapsed ? "Развернуть панель" : "Свернуть панель";
    toggle.setAttribute("aria-label", toggle.title);
    toggle.setAttribute("aria-expanded", String(!state.sidebarCollapsed));
  }
}

function setSidebarCollapsed(collapsed) {
  state.sidebarCollapsed = Boolean(collapsed);
  localStorage.setItem(SIDEBAR_COLLAPSED_KEY, state.sidebarCollapsed ? "1" : "");
  applySidebarCollapsed();
}

function loadSidebarCollapsed() {
  state.sidebarCollapsed = localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === "1";
  applySidebarCollapsed();
}

function activateNextVisibleChat() {
  const nextSession = visibleChatSessions()[0];

  if (nextSession) {
    state.activeChatId = nextSession.id;
  } else {
    const emptySession = createChatSession("");
    state.chatSessions.unshift(emptySession);
    state.activeChatId = emptySession.id;
  }

  const activeSession = activeChat();
  state.selectedSourceId = activeSession?.sourceId && state.sources.some((source) => source.id === activeSession.sourceId)
    ? activeSession.sourceId
    : "";
  resetSourcePreview();
  renderSources();
  renderActiveChat();
  $("#question").focus();
}

function archiveChat(chatId) {
  if (state.chatRequest.controller) return;

  const session = state.chatSessions.find((item) => item.id === chatId);
  if (!session) return;

  session.archivedAt = new Date().toISOString();
  if (state.activeChatId === chatId) activateNextVisibleChat();

  saveChatHistory();
  renderChatHistory();
}

function restoreChat(chatId) {
  if (state.chatRequest.controller) return;

  const session = state.chatSessions.find((item) => item.id === chatId);
  if (!session) return;

  delete session.archivedAt;
  session.updatedAt = new Date().toISOString();
  saveChatHistory();
  renderChatHistory();
}

function deleteChat(chatId) {
  if (state.chatRequest.controller) return;

  const session = state.chatSessions.find((item) => item.id === chatId);
  if (!session) return;

  const title = session.title || "Новый чат";
  const confirmed = typeof window.confirm === "function"
    ? window.confirm(`Удалить чат «${title}»?`)
    : true;
  if (!confirmed) return;

  const wasActive = state.activeChatId === chatId;
  state.chatSessions = state.chatSessions.filter((item) => item.id !== chatId);

  if (wasActive) activateNextVisibleChat();

  saveChatHistory();
  renderChatHistory();
}

function setActiveChat(chatId) {
  if (state.chatRequest.controller) return;
  if (!$("#settings-page").hidden) closeSettings();
  resetSourcePreview();

  state.activeChatId = chatId;
  const session = activeChat();
  if (session?.sourceId && state.sources.some((source) => source.id === session.sourceId)) {
    state.selectedSourceId = session.sourceId;
  } else {
    state.selectedSourceId = "";
  }
  renderSources();
  saveChatHistory();
  renderChatHistory();
  renderActiveChat();
}

function startNewChat() {
  if (state.chatRequest.controller) return;
  if (!$("#settings-page").hidden) closeSettings();
  state.chatHistoryMode = "active";
  state.selectedSourceId = "";
  resetSourcePreview();

  const current = activeChat();
  if (current && !(current.messages || []).length) {
    current.sourceId = "";
    touchActiveChat();
    renderSources();
    renderActiveChat();
    $("#question").focus();
    return;
  }

  const session = createChatSession("");
  state.chatSessions.unshift(session);
  state.activeChatId = session.id;
  saveChatHistory();
  renderChatHistory();
  renderSources();
  renderActiveChat();
  $("#question").focus();
}

function findMessageRecord(messageElement) {
  const messageId = messageElement?.dataset?.messageId;
  if (!messageId) return null;
  return activeChat()?.messages?.find((message) => message.id === messageId) || null;
}

function touchActiveChat() {
  const session = activeChat();
  if (!session) return;
  session.updatedAt = new Date().toISOString();
  saveChatHistory();
  renderChatHistory();
}

function addMessageRecord(role, text) {
  const session = ensureActiveChat();
  const now = new Date().toISOString();
  const record = {
    id: makeId("msg"),
    role,
    text,
    meta: "",
    ragDebug: null,
    sources: [],
    createdAt: now
  };
  session.messages.push(record);
  session.updatedAt = now;

  if (role === "user" && (!session.title || session.title === "Новый чат")) {
    session.title = makeChatTitle(text);
    session.titleSource = "fallback";
  }

  saveChatHistory();
  renderChatHistory();
  return record;
}

function openSettings(tabName = "sources", options = {}) {
  const nextTabName = SETTINGS_TABS.has(tabName) ? tabName : "sources";
  if (options.updateRoute !== false) {
    navigateToPath(`/settings/${nextTabName}`);
    return;
  }

  state.addingSource = false;
  if (!sourceById(state.settingsSourceId)) {
    state.settingsSourceId = sourceById(state.selectedSourceId)?.id || state.sources[0]?.id || "";
  }
  const settingsSource = sourceById(state.settingsSourceId);
  state.sourceListTab = settingsSource ? sourceListTabForSource(settingsSource) : "contract";
  $(".app").classList.add("settings-mode");
  $(".sidebar").hidden = true;
  $("#chat-workspace").hidden = true;
  $("#source-viewer").hidden = true;
  $("#settings-page").hidden = false;
  $("#settings-open").classList.add("active");
  setBackendStatus("online");
  setSettingsTab(nextTabName, { updateRoute: false });
  renderSources();
  refreshLmStudioStatus();
  refreshLmUsage();
  refreshIndexOverviewStatus({ silent: true });
  refreshIntegrationsStatus();
  refreshRerankerProcessStatus({ silent: true });
  refreshQdrantProcessStatus({ silent: true });
}

function closeSettings(options = {}) {
  if (options.updateRoute !== false) {
    navigateToPath("/chat");
    return;
  }

  state.addingSource = false;
  clearSourceTitleEditing();
  $("#settings-page").hidden = true;
  $(".sidebar").hidden = false;
  $(".app").classList.remove("settings-mode");
  $("#chat-workspace").hidden = false;
  $("#source-viewer").hidden = !$(".app").classList.contains("has-source-viewer");
  $("#settings-open").classList.remove("active");
}

function setSettingsTab(tabName, options = {}) {
  const nextTabName = SETTINGS_TABS.has(tabName) ? tabName : "sources";
  if (options.updateRoute !== false) {
    navigateToPath(`/settings/${nextTabName}`);
    return;
  }

  document.querySelectorAll("[data-settings-tab]").forEach((button) => {
    const isActive = button.dataset.settingsTab === nextTabName;
    button.classList.toggle("active", isActive);
    button.setAttribute("aria-selected", String(isActive));
  });

  document.querySelectorAll(".settings-tab-panel").forEach((panel) => {
    const isActive = panel.id === `settings-panel-${nextTabName}`;
    panel.classList.toggle("active", isActive);
    panel.hidden = !isActive;
  });
  const settingsContent = $(".settings-content");
  if (settingsContent) settingsContent.scrollTop = 0;
  setText("#settings-page-subtitle", SETTINGS_TAB_SUBTITLES[nextTabName] || "");

  const auditShortcut = $("#settings-audit-shortcut");
  if (auditShortcut) {
    const auditActive = nextTabName === "audit";
    auditShortcut.classList.toggle("active", auditActive);
    auditShortcut.setAttribute("aria-pressed", String(auditActive));
  }

  if (nextTabName !== "sources") clearSourceTitleEditing();

  if (nextTabName === "indexes") {
    refreshIntegrationsStatus();
  }

  if (nextTabName === "audit") {
    refreshAuditStatus({ silent: true });
  }

  renderSettingsSourceActions();
}

function serviceButtonFor(service) {
  const selector = {
    backend: "#settings-system-status",
    reranker: "#settings-reranker-status",
    qdrant: "#settings-qdrant-status"
  }[service] || "";
  return selector ? $(selector) : null;
}

function serviceLabel(service) {
  return {
    backend: "Бэкэнд",
    reranker: "Reranker",
    qdrant: "Qdrant"
  }[service] || service;
}

function setServiceButtonStatus(service, status = "stopped", details = {}) {
  const indicator = serviceButtonFor(service);
  if (!indicator) return;

  const className = status === "disabled" && details.running ? "is-warning" : ({
    running: "is-online",
    online: "is-online",
    starting: "is-restarting",
    stopping: "is-restarting",
    restarting: "is-restarting",
    stopped: "is-offline",
    offline: "is-offline",
    disabled: "is-offline",
    error: "is-offline",
    unmanaged: "is-offline"
  }[status] || "is-offline");

  const title = details.title || details.error || serviceLabel(service);
  indicator.classList.remove("is-online", "is-restarting", "is-warning", "is-offline");
  indicator.classList.add(className);
  indicator.dataset.serviceState = status;
  indicator.dataset.manageable = String(details.manageable !== false);
  indicator.title = title;
  indicator.setAttribute("aria-label", title);
  const label = indicator.querySelector(".backend-status-label");
  if (label) label.textContent = serviceLabel(service);
  updateServiceActionMenu();
}

function setBackendStatus(status = "online") {
  const details = {
    online: {
      running: true,
      state: "running",
      manageable: true,
      title: "Бэкэнд работает"
    },
    restarting: {
      running: true,
      state: "restarting",
      manageable: true,
      title: "Бэкэнд перезапускается"
    },
    stopping: {
      running: false,
      state: "stopping",
      manageable: true,
      title: "Бэкэнд останавливается"
    },
    offline: {
      running: false,
      state: "stopped",
      manageable: true,
      title: "Бэкэнд недоступен"
    }
  }[status] || {};
  state.backendProcessStatus = details;
  setServiceButtonStatus("backend", status, details);
}

async function waitForBackendHealth({ timeoutMs = 35000 } = {}) {
  const startedAt = Date.now();
  let sawUnavailable = false;
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(`/api/health?restart=${Date.now()}`, { cache: "no-store" });
      if (response.ok && (sawUnavailable || Date.now() - startedAt > 1500)) return true;
    } catch {
      sawUnavailable = true;
    }
    await sleep(700);
  }
  throw new Error("backend не ответил после перезапуска");
}

async function restartBackend() {
  setBackendStatus("restarting");

  try {
    await api("/api/system/backend/restart", {
      method: "POST",
      body: JSON.stringify({})
    });
    setBackendStatus("restarting");
    await waitForBackendHealth();
    setBackendStatus("online");
    await Promise.allSettled([
      loadSettings(),
      loadSources(),
      refreshLmStudioStatus(),
      refreshLmUsage(),
      refreshIntegrationsStatus(),
      refreshDifyStatus({ silent: true })
    ]);
  } catch (error) {
    setBackendStatus("offline");
    console.warn(apiErrorMessage(error, "Перезапуск не выполнен"));
  }
}

async function startBackend() {
  try {
    const payload = await api("/api/system/backend/start", {
      method: "POST",
      body: JSON.stringify({})
    });
    state.backendProcessStatus = payload;
    setBackendStatus(payload.running ? "online" : "offline");
  } catch (error) {
    setBackendStatus("offline");
    console.warn(apiErrorMessage(error, "Бэкэнд не запущен"));
  }
}

async function stopBackend() {
  setBackendStatus("stopping");
  try {
    await api("/api/system/backend/stop", {
      method: "POST",
      body: JSON.stringify({})
    });
    await sleep(900);
    setBackendStatus("offline");
    return true;
  } catch (error) {
    setBackendStatus("online");
    console.warn(apiErrorMessage(error, "Бэкэнд не остановлен"));
    return false;
  }
}

function portalStopService(services = [], name = "") {
  return services.find((service) => service?.service === name) || null;
}

function applyPortalStopServiceStatuses(services = []) {
  const reranker = portalStopService(services, "reranker");
  if (reranker) {
    const details = {
      ...(state.rerankerProcessStatus || {}),
      running: Boolean(reranker.running),
      manageable: reranker.manageable !== false,
      state: reranker.state,
      error: reranker.reason === "stop_failed" ? "Не удалось остановить reranker" : ""
    };
    state.rerankerProcessStatus = details;
    setRerankerProcessStatus(
      reranker.reason === "stop_failed" ? "error" : (details.manageable ? (details.running ? "running" : "stopped") : "unmanaged"),
      details
    );
  }

  const qdrant = portalStopService(services, "qdrant");
  if (qdrant) {
    const details = {
      ...(state.qdrantProcessStatus || {}),
      running: Boolean(qdrant.running),
      manageable: qdrant.manageable !== false,
      state: qdrant.state,
      error: qdrant.reason === "stop_failed" ? "Не удалось остановить Qdrant" : ""
    };
    state.qdrantProcessStatus = details;
    setQdrantProcessStatus(
      qdrant.reason === "stop_failed" ? "error" : (details.manageable ? (details.running ? "running" : "stopped") : "unmanaged"),
      details
    );
  }
}

const MODAL_FOCUSABLE_SELECTOR =
  'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], [tabindex]:not([tabindex="-1"])';

function modalFocusableElements(container) {
  return [...container.querySelectorAll(MODAL_FOCUSABLE_SELECTOR)]
    .filter((el) => !el.hidden && el.offsetParent !== null);
}

function trapModalTab(event) {
  if (event.key !== "Tab") return;
  const container = event.currentTarget;
  const focusable = modalFocusableElements(container);
  if (!focusable.length) return;
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  const active = document.activeElement;
  if (event.shiftKey && (active === first || !container.contains(active))) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && active === last) {
    event.preventDefault();
    first.focus();
  }
}

// Общий контроль доступности модалок: ловушка фокуса (Tab) + возврат фокуса на
// элемент, открывший модалку. Портальная модалка управляет фокусом сама и здесь
// не регистрируется — ей достаточно общей ловушки Tab (trapModalTab).
function setupModalA11y(modalId) {
  const modal = document.getElementById(modalId);
  if (!modal) return;
  modal.addEventListener("keydown", trapModalTab);
  let previousFocus = null;
  const observer = new MutationObserver(() => {
    if (!modal.hidden) {
      if (!modal.contains(document.activeElement)) {
        previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
        requestAnimationFrame(() => {
          if (modal.hidden || modal.contains(document.activeElement)) return;
          const focusable = modalFocusableElements(modal);
          if (focusable.length) focusable[0].focus();
        });
      }
    } else if (previousFocus?.isConnected) {
      previousFocus.focus();
      previousFocus = null;
    }
  });
  observer.observe(modal, { attributes: true, attributeFilter: ["hidden"] });
}

let portalStopPreviousFocus = null;

function syncPortalStopConfirmation() {
  const input = $("#portal-stop-confirm-input");
  const confirmButton = $("#portal-stop-confirm");
  if (!confirmButton) return;
  confirmButton.disabled = String(input?.value || "").trim().toLocaleUpperCase("ru-RU") !== "СТОП";
}

function openPortalStopConfirmation() {
  const modal = $("#portal-stop-modal");
  const input = $("#portal-stop-confirm-input");
  if (!modal || !input) return;
  portalStopPreviousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  input.value = "";
  modal.hidden = false;
  syncPortalStopConfirmation();
  requestAnimationFrame(() => input.focus());
}

function closePortalStopConfirmation({ restoreFocus = true } = {}) {
  const modal = $("#portal-stop-modal");
  if (!modal || modal.hidden) return;
  modal.hidden = true;
  if (restoreFocus && portalStopPreviousFocus?.isConnected) portalStopPreviousFocus.focus();
  portalStopPreviousFocus = null;
}

async function stopPortal() {
  closePortalStopConfirmation({ restoreFocus: false });
  const button = $("#portal-stop-button");
  if (button) {
    button.disabled = true;
    button.classList.add("is-stopping");
    button.title = "Портал и фоновые сервисы останавливаются";
    button.setAttribute("aria-label", "Портал и фоновые сервисы останавливаются");
  }
  closeServiceActionMenu();

  setBackendStatus("stopping");
  setRerankerProcessStatus("stopping", state.rerankerProcessStatus || {});
  setQdrantProcessStatus("stopping", state.qdrantProcessStatus || {});

  let stopped = false;
  try {
    const payload = await api("/api/system/portal/stop", {
      method: "POST",
      body: JSON.stringify({})
    });
    stopped = Boolean(payload?.ok);
    applyPortalStopServiceStatuses(payload?.services || []);
    await sleep(900);
    setBackendStatus("offline");
  } catch (error) {
    setBackendStatus("online");
    console.warn(apiErrorMessage(error, "Портал не остановлен"));
  }

  if (!button) return;

  if (stopped) {
    button.classList.remove("is-stopping");
    button.classList.add("is-stopped");
    button.title = "Портал и управляемые фоновые сервисы остановлены. Запустите ярлык снова, чтобы открыть.";
    button.setAttribute("aria-label", "Портал остановлен");
    return;
  }

  button.disabled = false;
  button.classList.remove("is-stopping", "is-stopped");
  button.title = "Остановить портал и фоновые сервисы";
  button.setAttribute("aria-label", "Остановить портал и фоновые сервисы");
}

async function runBackendAction(action) {
  if (action === "start") return startBackend();
  if (action === "stop") return stopBackend();
  return restartBackend();
}

function setRerankerProcessStatus(status = "stopped", details = {}) {
  const modelSuffix = details.model ? ` · ${details.model}` : "";
  const processChanging = ["starting", "stopping", "restarting"].includes(status);
  const effectiveStatus = !processChanging && details.enabled === false ? "disabled" : status;
  const states = {
    running: {
      title: `Reranker работает${modelSuffix}`
    },
    starting: {
      title: `Reranker запускается${modelSuffix}`
    },
    stopping: {
      title: "Reranker останавливается"
    },
    restarting: {
      title: `Reranker перезапускается${modelSuffix}`
    },
    stopped: {
      title: "Reranker не запущен"
    },
    disabled: {
      title: details.running
        ? "Reranker выключен в настройках; процесс запущен"
        : "Reranker выключен в настройках"
    },
    error: {
      title: details.error || "Reranker недоступен"
    },
    unmanaged: {
      title: "Управление доступно только для локального Windows reranker"
    }
  };

  const next = states[effectiveStatus] || states.stopped;
  setServiceButtonStatus("reranker", effectiveStatus, { ...details, title: next.title });
}

async function refreshRerankerProcessStatus(options = {}) {
  if (!options.silent) setRerankerProcessStatus("starting", { model: state.reranker?.model || "" });
  try {
    const payload = await api("/api/system/reranker/status");
    state.rerankerProcessStatus = payload;
    if (payload.enabled === false) {
      setRerankerProcessStatus("disabled", payload);
    } else if (!payload.manageable) {
      setRerankerProcessStatus("unmanaged", payload);
    } else {
      setRerankerProcessStatus(payload.state || (payload.running ? "running" : "stopped"), payload);
    }
    return payload;
  } catch (error) {
    state.rerankerProcessStatus = null;
    setRerankerProcessStatus("error", { error: apiErrorMessage(error, "Reranker недоступен") });
    return null;
  }
}

async function waitForRerankerProcess(expectedRunning, options = {}) {
  const timeoutMs = options.timeoutMs || 15000;
  const startedAt = Date.now();
  let payload = null;
  while (Date.now() - startedAt < timeoutMs) {
    await sleep(1200);
    payload = await api("/api/system/reranker/status").catch(() => null);
    if (payload?.running === expectedRunning) {
      state.rerankerProcessStatus = payload;
      setRerankerProcessStatus(payload.running ? "running" : "stopped", payload);
      return payload;
    }
  }
  return payload;
}

function clearRerankerProcessPoll() {
  if (state.rerankerProcessPollTimer) {
    clearTimeout(state.rerankerProcessPollTimer);
    state.rerankerProcessPollTimer = null;
  }
}

function scheduleRerankerProcessPoll(expectedRunning, pendingState, details = {}) {
  clearRerankerProcessPoll();
  const deadline = Date.now() + 5 * 60 * 1000;

  const tick = async () => {
    const payload = await api("/api/system/reranker/status").catch(() => null);
    if (payload?.running === expectedRunning) {
      state.rerankerProcessStatus = payload;
      setRerankerProcessStatus(payload.running ? "running" : "stopped", payload);
      await refreshIntegrationsStatus();
      clearRerankerProcessPoll();
      return;
    }

    if (Date.now() >= deadline) {
      await refreshRerankerProcessStatus({ silent: true });
      clearRerankerProcessPoll();
      return;
    }

    setRerankerProcessStatus(pendingState, payload || details);
    state.rerankerProcessPollTimer = setTimeout(tick, 3000);
  };

  setRerankerProcessStatus(pendingState, details);
  state.rerankerProcessPollTimer = setTimeout(tick, 3000);
}

async function runRerankerProcessAction(action) {
  const busyState = {
    start: "starting",
    stop: "stopping",
    restart: "restarting"
  }[action] || "starting";
  const expectedRunning = action !== "stop";

  setRerankerProcessStatus(busyState, state.rerankerProcessStatus || {});

  let keepPendingPoll = false;
  try {
    clearRerankerProcessPoll();
    const payload = await api(`/api/system/reranker/${action}`, {
      method: "POST",
      body: JSON.stringify({})
    });
    state.rerankerProcessStatus = payload;
    setRerankerProcessStatus(busyState, payload);

    const settled = await waitForRerankerProcess(expectedRunning);
    if (!settled || settled.running !== expectedRunning) {
      setRerankerProcessStatus(busyState, payload);
      scheduleRerankerProcessPoll(expectedRunning, busyState, payload);
      keepPendingPoll = true;
    }
    await refreshIntegrationsStatus();
  } catch (error) {
    clearRerankerProcessPoll();
    setRerankerProcessStatus("error", { error: apiErrorMessage(error, "Команда reranker не выполнена") });
    console.warn(apiErrorMessage(error, "Команда reranker не выполнена"));
  } finally {
    if (!keepPendingPoll) await refreshRerankerProcessStatus({ silent: true });
  }
}

function setQdrantProcessStatus(status = "stopped", details = {}) {
  const versionSuffix = details.version ? ` · ${details.version}` : "";
  const states = {
    running: {
      title: `Qdrant работает${versionSuffix}`
    },
    starting: {
      title: "Qdrant запускается"
    },
    stopping: {
      title: "Qdrant останавливается"
    },
    restarting: {
      title: "Qdrant перезапускается"
    },
    stopped: {
      title: "Qdrant не запущен"
    },
    error: {
      title: details.error || "Qdrant недоступен"
    },
    unmanaged: {
      title: "Управление доступно только для локального Windows Qdrant на 6333"
    }
  };
  const next = states[status] || states.stopped;
  setServiceButtonStatus("qdrant", status, { ...details, title: next.title });
}

async function refreshQdrantProcessStatus(options = {}) {
  if (!options.silent) setQdrantProcessStatus("starting", state.qdrantProcessStatus || {});
  try {
    const payload = await api("/api/system/qdrant/status");
    state.qdrantProcessStatus = payload;
    if (!payload.manageable) {
      setQdrantProcessStatus("unmanaged", payload);
    } else {
      setQdrantProcessStatus(payload.running ? "running" : "stopped", payload);
    }
    return payload;
  } catch (error) {
    state.qdrantProcessStatus = null;
    setQdrantProcessStatus("error", { error: apiErrorMessage(error, "Qdrant недоступен") });
    return null;
  }
}

async function waitForQdrantProcess(expectedRunning, options = {}) {
  const timeoutMs = options.timeoutMs || 15000;
  const startedAt = Date.now();
  let payload = null;
  while (Date.now() - startedAt < timeoutMs) {
    await sleep(1000);
    payload = await api("/api/system/qdrant/status").catch(() => null);
    if (payload?.running === expectedRunning) {
      state.qdrantProcessStatus = payload;
      setQdrantProcessStatus(payload.running ? "running" : "stopped", payload);
      return payload;
    }
  }
  return payload;
}

function clearQdrantProcessPoll() {
  if (state.qdrantProcessPollTimer) {
    clearTimeout(state.qdrantProcessPollTimer);
    state.qdrantProcessPollTimer = null;
  }
}

function scheduleQdrantProcessPoll(expectedRunning, pendingState, details = {}) {
  clearQdrantProcessPoll();
  const deadline = Date.now() + 90 * 1000;

  const tick = async () => {
    const payload = await api("/api/system/qdrant/status").catch(() => null);
    if (payload?.running === expectedRunning) {
      state.qdrantProcessStatus = payload;
      setQdrantProcessStatus(payload.running ? "running" : "stopped", payload);
      await refreshIntegrationsStatus();
      clearQdrantProcessPoll();
      return;
    }

    if (Date.now() >= deadline) {
      await refreshQdrantProcessStatus({ silent: true });
      clearQdrantProcessPoll();
      return;
    }

    setQdrantProcessStatus(pendingState, payload || details);
    state.qdrantProcessPollTimer = setTimeout(tick, 3000);
  };

  setQdrantProcessStatus(pendingState, details);
  state.qdrantProcessPollTimer = setTimeout(tick, 3000);
}

async function runQdrantProcessAction(action) {
  const busyState = {
    start: "starting",
    stop: "stopping",
    restart: "restarting"
  }[action] || "starting";
  const expectedRunning = action !== "stop";
  setQdrantProcessStatus(busyState, state.qdrantProcessStatus || {});

  let keepPendingPoll = false;
  try {
    clearQdrantProcessPoll();
    const payload = await api(`/api/system/qdrant/${action}`, {
      method: "POST",
      body: JSON.stringify({})
    });
    state.qdrantProcessStatus = payload;
    setQdrantProcessStatus(busyState, payload);

    const settled = await waitForQdrantProcess(expectedRunning);
    if (!settled || settled.running !== expectedRunning) {
      scheduleQdrantProcessPoll(expectedRunning, busyState, payload);
      keepPendingPoll = true;
    }
    await refreshIntegrationsStatus();
  } catch (error) {
    clearQdrantProcessPoll();
    setQdrantProcessStatus("error", { error: apiErrorMessage(error, "Команда Qdrant не выполнена") });
    console.warn(apiErrorMessage(error, "Команда Qdrant не выполнена"));
  } finally {
    if (!keepPendingPoll) await refreshQdrantProcessStatus({ silent: true });
  }
}

function serviceRuntime(service) {
  if (service === "backend") return state.backendProcessStatus || { running: true, manageable: true };
  if (service === "reranker") return state.rerankerProcessStatus || { running: false, manageable: true };
  if (service === "qdrant") return state.qdrantProcessStatus || { running: false, manageable: true };
  return { running: false, manageable: false };
}

function serviceActionDisabled(service, action) {
  const runtime = serviceRuntime(service);
  const button = serviceButtonFor(service);
  const serviceState = button?.dataset.serviceState || runtime.state || "";
  const busy = ["starting", "stopping", "restarting"].includes(serviceState);
  const manageable = runtime.manageable !== false && serviceState !== "unmanaged";
  const running = Boolean(runtime.running || serviceState === "running" || serviceState === "online");

  if (busy) return true;
  if (!manageable) return true;
  if (action === "start") return running;
  if (action === "stop") return !running;
  return false;
}

function positionServiceActionMenu(service) {
  const menu = $("#service-action-menu");
  const button = serviceButtonFor(service);
  const container = $(".settings-header-actions");
  if (!menu || !button || !container) return;

  if (window.matchMedia("(max-width: 920px)").matches) {
    menu.style.left = "0";
    menu.style.right = "0";
    menu.style.width = "";
    menu.style.minWidth = "";
    return;
  }

  const minWidth = 150;
  const menuWidth = Math.max(minWidth, Math.round(button.offsetWidth));
  const maxLeft = Math.max(0, container.clientWidth - menuWidth);
  const left = Math.min(maxLeft, Math.max(0, button.offsetLeft));
  menu.style.left = `${left}px`;
  menu.style.right = "auto";
  menu.style.width = `${menuWidth}px`;
  menu.style.minWidth = `${menuWidth}px`;
}

function updateServiceActionMenu() {
  const menu = $("#service-action-menu");
  if (!menu || menu.hidden || !state.activeServiceMenu) return;
  positionServiceActionMenu(state.activeServiceMenu);
  menu.querySelectorAll("[data-service-action]").forEach((button) => {
    const action = button.dataset.serviceAction;
    button.disabled = serviceActionDisabled(state.activeServiceMenu, action);
  });
}

function closeServiceActionMenu() {
  const menu = $("#service-action-menu");
  if (!menu) return;
  menu.hidden = true;
  menu.style.left = "";
  menu.style.right = "";
  menu.style.width = "";
  menu.style.minWidth = "";
  document.querySelectorAll(".service-control-button.active").forEach((button) => {
    button.classList.remove("active");
    button.setAttribute("aria-expanded", "false");
  });
  state.activeServiceMenu = "";
}

function openServiceActionMenu(service) {
  const menu = $("#service-action-menu");
  const button = serviceButtonFor(service);
  if (!menu || !button) return;
  if (state.activeServiceMenu === service && !menu.hidden) {
    closeServiceActionMenu();
    return;
  }

  closeServiceActionMenu();
  state.activeServiceMenu = service;
  button.classList.add("active");
  button.setAttribute("aria-expanded", "true");
  menu.hidden = false;
  updateServiceActionMenu();
}

async function runServiceAction(service, action) {
  closeServiceActionMenu();
  if (service === "backend") return runBackendAction(action);
  if (service === "reranker") return runRerankerProcessAction(action);
  if (service === "qdrant") return runQdrantProcessAction(action);
}

function showFolderModal(title) {
  $("#folder-modal-title").textContent = title;
  $("#folder-modal").hidden = false;
}

function closeFolderModal(value = "") {
  $("#folder-modal").hidden = true;
  const resolve = state.folderPicker.resolve;
  state.folderPicker.resolve = null;
  state.folderPicker.currentPath = "";
  state.folderPicker.parentPath = "";
  if (resolve) resolve(value);
}

function renderFolderRows({ roots = [], folders = [] }) {
  const list = $("#folder-list");
  list.innerHTML = "";

  const rows = roots.length ? roots : folders;
  if (!rows.length) {
    list.innerHTML = '<div class="empty">В этой папке нет подпапок.</div>';
    return;
  }

  for (const row of rows) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "folder-row";
    button.innerHTML = `
      <span class="folder-icon">${roots.length ? "▣" : "▸"}</span>
      <span class="folder-name"></span>
      <span class="folder-path"></span>
    `;
    button.querySelector(".folder-name").textContent = row.label || row.name;
    button.querySelector(".folder-path").textContent = row.path;
    button.addEventListener("click", () => loadFolder(row.path));
    list.append(button);
  }
}

async function loadRoots() {
  state.folderPicker.currentPath = "";
  state.folderPicker.parentPath = "";
  $("#folder-current").textContent = "Диски и сетевые папки";
  $("#folder-up").disabled = true;
  $("#folder-select-current").disabled = true;
  $("#folder-list").innerHTML = '<div class="empty">Загрузка...</div>';
  const payload = await api("/api/fs/roots");
  renderFolderRows({ roots: payload.roots || [] });
}

async function loadFolder(folderPath) {
  state.folderPicker.currentPath = folderPath;
  $("#folder-current").textContent = folderPath;
  $("#folder-up").disabled = true;
  $("#folder-select-current").disabled = false;
  $("#folder-list").innerHTML = '<div class="empty">Загрузка...</div>';

  try {
    const payload = await api(`/api/fs/folders?path=${encodeURIComponent(folderPath)}`);
    state.folderPicker.parentPath = payload.parent || "";
    $("#folder-up").disabled = !payload.parent;
    renderFolderRows({ folders: payload.folders || [] });
  } catch (error) {
    $("#folder-list").innerHTML = `<div class="error">${error.message}</div>`;
  }
}

async function chooseFolderInApp({ title, initialPath = "" }) {
  showFolderModal(title);
  const promise = new Promise((resolve) => {
    state.folderPicker.resolve = resolve;
  });

  if (initialPath) {
    await loadFolder(initialPath).catch(loadRoots);
  } else {
    await loadRoots();
  }

  return promise;
}

async function chooseFolder({ title, initialPath = "" }) {
  try {
    const payload = await api("/api/dialog/folder", {
      method: "POST",
      body: JSON.stringify({ title, initialPath })
    });
    return payload.path || "";
  } catch (error) {
    setText("#job-status", `Проводник не открылся: ${error.message}. Открываю встроенный выбор.`);
    return chooseFolderInApp({ title, initialPath });
  }
}

function selectedSource() {
  return sourceById(state.selectedSourceId);
}

function selectedIndexStatus() {
  return selectedSource()?.indexStatus || { status: "not_indexed", message: "Не индексировалось" };
}

function skippedTotal(status = {}) {
  return Number(status.skippedTotal ?? ((status.unsupportedFiles || 0) + (status.temporaryFiles || 0) + (status.excludedFiles || 0)));
}

function optionalNumber(value) {
  if (value === undefined || value === null || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function formatQdrantSummaryPart(status = {}) {
  const qdrantPoints = optionalNumber(status.qdrantPoints);
  const qdrantStepState = sourceQdrantStepState(status);
  if (status.qdrantAvailable === true || qdrantStepState === "done") {
    return qdrantPoints === null ? "Qdrant: точек нет данных" : `Qdrant ${qdrantPoints}`;
  }
  if (sourceNeedsQdrantReindex(status) || sourceNeedsQdrantRefresh(status)) return "Qdrant ожидает переиндексации";
  return "";
}

function indexProgressText(status = {}) {
  const total = Number(status.total || status.eligibleFiles || status.files || 0);
  if (!total) return "";
  return `${Number(status.processed || 0)}/${total}`;
}

function shortDateTime(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString("ru-RU", {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  });
}

function indexHealthStatus(status = {}) {
  const healthStatus = String(status.health?.status || "");
  if (healthStatus) return healthStatus;
  if (status.status === "failed" && status.phase === "interrupted") return "interrupted";
  if (status.status === "running") return "active";
  return String(status.status || "idle");
}

function indexHealthNeedsAttention(status = {}) {
  return ["stale", "interrupted"].includes(indexHealthStatus(status));
}

function formatDurationShort(ms) {
  const value = Number(ms);
  if (!Number.isFinite(value) || value < 0) return "";
  if (value < 60_000) return `${Math.max(1, Math.round(value / 1000))} \u0441`;
  const minutes = Math.max(1, Math.round(value / 60_000));
  if (minutes < 60) return `${minutes} \u043c\u0438\u043d`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours} \u0447 ${rest} \u043c\u0438\u043d` : `${hours} \u0447`;
}

function indexHealthDetail(status = {}, options = {}) {
  const health = indexHealthStatus(status);
  const age = formatDurationShort(status.health?.progressAgeMs);
  const progress = indexProgressText(status);
  if (health === "stale") {
    return [`\u043d\u0435\u0442 \u043e\u0431\u043d\u043e\u0432\u043b\u0435\u043d\u0438\u0439${age ? ` ${age}` : ""}`, progress].filter(Boolean).join(" · ");
  }
  if (health === "interrupted") return "\u043f\u0440\u043e\u0446\u0435\u0441\u0441 \u0438\u043d\u0434\u0435\u043a\u0441\u0430\u0446\u0438\u0438 \u043d\u0435 \u043d\u0430\u0439\u0434\u0435\u043d";
  if (status.status === "running") {
    return [options.activeText || "\u043f\u0440\u043e\u0433\u0440\u0435\u0441\u0441 \u0438\u0434\u0435\u0442", progress].filter(Boolean).join(" · ");
  }
  return "";
}

function formatIndexSummary(status = {}) {
  if (status.status === "running") {
    const health = indexHealthStatus(status);
    const detail = indexHealthDetail(status);
    if (health === "stale") return `\u0418\u043d\u0434\u0435\u043a\u0441\u0430\u0446\u0438\u044f \u0431\u0435\u0437 \u043f\u0440\u043e\u0433\u0440\u0435\u0441\u0441\u0430: ${detail}`;
    if (health === "interrupted") return `\u0418\u043d\u0434\u0435\u043a\u0441\u0430\u0446\u0438\u044f \u043f\u0440\u0435\u0440\u0432\u0430\u043d\u0430: ${detail}`;
    return `\u0418\u043d\u0434\u0435\u043a\u0441\u0438\u0440\u0443\u0435\u0442\u0441\u044f${detail ? ` · ${detail}` : ""}`;
  }

  if (status.status === "failed") {
    if (indexHealthStatus(status) === "interrupted") {
      return `\u0418\u043d\u0434\u0435\u043a\u0441\u0430\u0446\u0438\u044f \u043f\u0440\u0435\u0440\u0432\u0430\u043d\u0430: ${indexHealthDetail(status)}`;
    }
    return `Ошибка индексации${status.message ? `: ${status.message}` : ""}`;
  }

  if (status.status === "cancelled") {
    return "Индексация остановлена";
  }

  if (status.status === "completed") {
    const parts = [`индексировано ${status.indexedFiles || 0}`];
    if (status.chunks) parts.push(`фрагментов ${status.chunks}`);
    if (status.vectorsTotal) parts.push(`векторов ${status.vectorsTotal}`);
    if (status.reindexRetried) parts.push(`\u043f\u043e\u0432\u0442\u043e\u0440\u043e\u0432 ${status.reindexRetried}`);
    if (status.reindexUnresolved) parts.push(`\u043d\u0443\u0436\u043d\u0430 \u043f\u0440\u043e\u0432\u0435\u0440\u043a\u0430 ${status.reindexUnresolved}`);
    const qdrantPart = formatQdrantSummaryPart(status);
    if (qdrantPart) parts.push(qdrantPart);
    const skipped = skippedTotal(status);
    if (skipped) parts.push(`пропущено ${skipped}`);
    const updated = shortDateTime(status.finishedAt || status.updatedAt);
    if (updated) parts.push(updated);
    return parts.join("; ");
  }

  return "не индексировалось";
}

function formatToolbarIndexInfo(status = {}) {
  if (status.status === "running") {
    const health = indexHealthStatus(status);
    const detail = indexHealthDetail(status);
    if (health === "stale") return `\u041d\u0435\u0442 \u043e\u0431\u043d\u043e\u0432\u043b\u0435\u043d\u0438\u0439 \u043f\u0440\u043e\u0433\u0440\u0435\u0441\u0441\u0430: ${detail}`;
    if (health === "interrupted") return `\u0418\u043d\u0434\u0435\u043a\u0441\u0430\u0446\u0438\u044f \u043f\u0440\u0435\u0440\u0432\u0430\u043d\u0430: ${detail}`;
    return `\u0418\u0434\u0435\u0442 \u0438\u043d\u0434\u0435\u043a\u0441\u0430\u0446\u0438\u044f${detail ? ` · ${detail}` : ""}`;
  }

  if (status.status === "failed") {
    if (indexHealthStatus(status) === "interrupted") {
      return `\u0418\u043d\u0434\u0435\u043a\u0441\u0430\u0446\u0438\u044f \u043f\u0440\u0435\u0440\u0432\u0430\u043d\u0430: ${indexHealthDetail(status)}`;
    }
    return `Ошибка индексации${status.message ? `: ${status.message}` : ""}`;
  }

  if (status.status === "cancelled") {
    return "Индексация остановлена";
  }

  if (status.status === "completed") {
    const updated = shortDateTime(status.finishedAt || status.updatedAt);
    return updated ? `Индекс готов · обновлено ${updated}` : "Индекс готов";
  }

  return "Не индексировалось";
}

function sourceHasReadyIndex(status = {}) {
  return status.status === "completed"
    || Number(status.indexedFiles || 0) > 0
    || Number(status.chunks || 0) > 0;
}

function sourceHasVectorStoreResult(status = {}) {
  const providerUsed = String(status.vectorProviderUsed || status.vectorStoreProvider || "").toLowerCase();
  return Boolean(
    providerUsed
    || (status.qdrantAvailable !== null && status.qdrantAvailable !== undefined)
    || status.qdrantError
    || status.warning
  );
}

function qdrantIsReadyForIndexing() {
  const vectorStore = state.integrationsStatus?.vectorStore || {};
  return Boolean(vectorStore.qdrantEnabled && vectorStore.qdrantAvailable);
}

function sourceNeedsQdrantReindex(status = {}) {
  return sourceHasReadyIndex(status)
    && qdrantIsReadyForIndexing()
    && !sourceHasVectorStoreResult(status)
    && sourceQdrantStepState(status) === "pending";
}

function sourceNeedsQdrantRefresh(status = {}) {
  const hadQdrantFailure = status.qdrantAvailable === false
    || Boolean(status.qdrantError)
    || (status.warning && /qdrant/i.test(String(status.warning)));
  return sourceHasReadyIndex(status) && qdrantIsReadyForIndexing() && hadQdrantFailure;
}

function indexActionLabel(status = {}) {
  if (status.status === "running") return "Индексируется";
  if (sourceNeedsQdrantReindex(status) || sourceNeedsQdrantRefresh(status)) return "Переиндексировать в Qdrant";
  return sourceHasReadyIndex(status) ? "Переиндексировать" : "Индексировать";
}

const INDEX_PIPELINE_STEPS = [
  { key: "scan", label: "Сканирование", phases: ["queued", "cleanup", "scan"] },
  { key: "files", label: "Файлы/OCR", phases: ["convert", "ocr"] },
  { key: "chunks", label: "Фрагменты", phases: ["index"] },
  { key: "embed", label: "Векторы", phases: ["embed"] },
  { key: "qdrant", label: "Qdrant", phases: ["vector_store"] }
];

function indexPipelineStepIndex(status = {}) {
  if (status.status === "completed") return INDEX_PIPELINE_STEPS.length - 1;
  const phase = String(status.phase || "").toLowerCase();
  if (phase === "reindex") return INDEX_PIPELINE_STEPS.findIndex((step) => step.key === "files");
  const index = INDEX_PIPELINE_STEPS.findIndex((step) => step.phases.includes(phase));
  return index >= 0 ? index : 0;
}

function indexPipelineProgress(status = {}) {
  if (status.status === "completed") return 100;
  if (!sourceHasReadyIndex(status) && status.status !== "running" && status.status !== "failed") return 0;
  return jobProgressPercent(status) ?? (status.status === "failed" ? 100 : 0);
}

function sourceQdrantStepState(status = {}) {
  const providerUsed = String(status.vectorProviderUsed || status.vectorStoreProvider || "").toLowerCase();
  if (sourceNeedsQdrantRefresh(status)) return "warning";
  if (status.qdrantAvailable === false || status.qdrantError) return "error";
  if (status.qdrantAvailable === true) return "done";
  if (providerUsed === "qdrant" && status.status === "completed") return "done";
  if (status.warning && /qdrant/i.test(String(status.warning))) return "error";
  return "pending";
}

function indexPipelineStepState(status = {}, stepIndex) {
  if (!sourceHasReadyIndex(status) && status.status !== "running" && status.status !== "failed") return "pending";

  const activeIndex = indexPipelineStepIndex(status);
  if (status.status === "failed") return stepIndex < activeIndex ? "done" : (stepIndex === activeIndex ? "error" : "pending");
  if (status.status === "running" && indexHealthStatus(status) === "stale") {
    return stepIndex < activeIndex ? "done" : (stepIndex === activeIndex ? "warning" : "pending");
  }
  if (status.status === "running") return stepIndex < activeIndex ? "done" : (stepIndex === activeIndex ? "active" : "pending");

  const step = INDEX_PIPELINE_STEPS[stepIndex];
  if (step?.key === "qdrant") {
    return sourceQdrantStepState(status);
  }
  return "done";
}

function indexPipelineStepTitle(status = {}, step, stepState) {
  if (stepState === "done") return `${step.label}: готово`;
  if (stepState === "active") return `${step.label}: выполняется`;
  if (stepState === "warning") {
    return step.key === "qdrant"
      ? `${step.label}: сейчас доступен, нужна переиндексация папки`
      : `${step.label}: требует внимания`;
  }
  if (stepState === "error") {
    const vectorStore = state.integrationsStatus?.vectorStore || {};
    const qdrantError = status.qdrantError || status.warning || vectorStore.qdrantError;
    return `${step.label}: ${step.key === "qdrant" ? (qdrantError || "нет связи") : (status.message || "ошибка")}`;
  }
  if (step?.key === "qdrant" && sourceNeedsQdrantReindex(status)) {
    return `${step.label}: ожидает переиндексации папки`;
  }
  return `${step.label}: ожидает`;
}

function renderIndexPipeline(status = {}) {
  const wrapper = document.createElement("div");
  wrapper.className = "index-step-line";
  wrapper.style.setProperty("--index-step-progress", `${indexPipelineProgress(status)}%`);
  wrapper.innerHTML = `
    <div class="index-step-track" aria-hidden="true">
      <div class="index-step-track-fill"></div>
    </div>
    <div class="index-step-list"></div>
  `;

  const list = wrapper.querySelector(".index-step-list");
  for (const [index, step] of INDEX_PIPELINE_STEPS.entries()) {
    const stepState = indexPipelineStepState(status, index);
    const item = document.createElement("div");
    item.className = `index-step is-${stepState}`;
    item.title = indexPipelineStepTitle(status, step, stepState);
    item.innerHTML = `
      <span class="index-step-dot" aria-hidden="true"></span>
      <span class="index-step-label"></span>
    `;
    item.querySelector(".index-step-label").textContent = step.label;
    list.append(item);
  }

  return wrapper;
}

function indexPipelineText(status = {}) {
  if (status.status === "running") {
    if (status.phase === "embed") return formatJobStatus(status);
    if (status.phase === "vector_store") return "Записываю векторы в Qdrant";
    return "Создаю фрагменты документов; затем автоматически пойдет векторизация.";
  }

  const vectorStore = state.integrationsStatus?.vectorStore || {};
  const reranker = state.integrationsStatus?.reranker || {};
  const steps = ["файлы", "фрагменты", "embeddings"];
  const qdrantStepState = sourceQdrantStepState(status);
  if (qdrantStepState === "done") steps.push("Qdrant");
  else if (qdrantStepState === "warning") steps.push("локальные векторы, нужна переиндексация в Qdrant");
  else if (qdrantStepState === "error") steps.push("локальные векторы, Qdrant недоступен");
  else if (sourceNeedsQdrantReindex(status)) steps.push("Qdrant после переиндексации");
  else if (sourceHasVectorStoreResult(status) || sourceHasReadyIndex(status)) steps.push("локальные векторы");
  else if (vectorStore.qdrantEnabled && vectorStore.qdrantAvailable) steps.push("Qdrant");
  else if (vectorStore.qdrantEnabled) steps.push("локальные векторы, Qdrant недоступен");
  else steps.push("локальные векторы");

  const rerankerText = reranker.enabled && reranker.configured
    ? "; reranker включится при поиске"
    : "";
  return `Одна кнопка: ${steps.join(" -> ")}${rerankerText}.`;
}

function auditPanelVisible() {
  const panel = $("#settings-panel-audit");
  return Boolean(panel && !panel.hidden);
}

function auditToneFromStatus(status = "") {
  if (["running", "starting", "stopping", "queued"].includes(status)) return "running";
  if (["completed", "ready", "online", "done"].includes(status)) return "ready";
  if (["warning", "completed_with_errors", "interrupted", "cancelled"].includes(status)) return "warning";
  if (["failed", "error", "offline"].includes(status)) return "error";
  return "idle";
}

function auditPhaseLabel(phase = "") {
  return {
    queued: "очередь",
    cleanup: "очистка кэша",
    scan: "сканирование",
    convert: "конвертация",
    reindex: "\u043f\u043e\u0432\u0442\u043e\u0440",
    ocr: "OCR",
    "google-context": "Google context",
    index: "фрагменты",
    embed: "векторизация",
    vector_store: "запись в Qdrant",
    done: "готово",
    manifest: "готовый индекс",
    interrupted: "прервано",
    error: "ошибка"
  }[phase] || phase || "ожидание";
}

function auditProgressText(status = {}) {
  if (status.phase === "embed") {
    const processed = Number(status.vectorsProcessed || 0);
    const total = Number(status.vectorsTotal || 0);
    return total ? `векторы ${formatCount(processed)}/${formatCount(total)}` : "векторизация";
  }

  const processed = Number(status.processed || 0);
  const total = Number(status.total || status.files || 0);
  if (total) return `${formatCount(processed)}/${formatCount(total)}`;
  if (status.totalFiles) return `найдено файлов ${formatCount(status.totalFiles)}`;
  return "";
}

function auditFileTitleFromPath(value = "") {
  const parts = String(value || "").split(/[\\/]/).filter(Boolean);
  return parts.at(-1) || String(value || "");
}

function auditFileExtensionFromName(value = "") {
  const match = String(value || "").match(/(\.[A-Za-z0-9]{1,12})$/);
  return match ? match[1].toLowerCase() : "";
}

function auditFileFromMessage(message = "") {
  const text = String(message || "").trim();
  if (/loading recognition model/i.test(text)) return null;

  const match = text.match(/^(?:OCR|OCRmyPDF|Docling|Reindex|Конвертация):\s*(.+?)(?:\s+\(\d+\/\d+\))?$/i);
  if (!match) return null;

  const title = auditFileTitleFromPath(match[1].trim());
  if (!title || title.includes(": loading ")) return null;
  return {
    title,
    relativePath: match[1].trim(),
    extension: auditFileExtensionFromName(title)
  };
}

function auditCurrentFile(status = {}) {
  const title = String(status.currentFileTitle || "").trim();
  const relativePath = String(status.currentFileRelativePath || "").trim();
  if (title || relativePath) {
    const fallbackTitle = auditFileTitleFromPath(relativePath);
    return {
      title: title || fallbackTitle,
      relativePath: relativePath || title || fallbackTitle,
      extension: String(status.currentFileExtension || auditFileExtensionFromName(title || relativePath) || "").toLowerCase()
    };
  }

  if (status.currentGoogleContextTitle) {
    const googleTitle = String(status.currentGoogleContextTitle).trim();
    return {
      title: googleTitle,
      relativePath: googleTitle,
      extension: ".google"
    };
  }

  return auditFileFromMessage(status.message);
}

function auditMovementDetail(status = {}) {
  if (indexHealthNeedsAttention(status)) return formatIndexSummary(status);
  if (status.currentGoogleContextTitle) return `Google context: ${status.currentGoogleContextTitle}`;
  if (status.phase === "embed" || status.phase === "vector_store") return formatJobStatus(status);
  if (status.message) return status.message;
  if (status.status === "completed") return formatIndexSummary(status);
  if (status.status === "failed") return "Ошибка индексации";
  if (status.status === "cancelled") return "Индексация остановлена";
  return "Ожидание";
}

function auditPipelineDetail(status = {}, file = null) {
  if (status.phase === "ocr") {
    const page = Number(status.ocrPage || 0);
    const total = Number(status.ocrPages || status.ocrTotalPages || 0);
    if (page && total) return `OCR: страница ${formatCount(page)}/${formatCount(total)}`;
  }

  if (status.phase === "embed" || status.phase === "vector_store") {
    return formatJobStatus(status);
  }

  const detail = auditMovementDetail(status);
  const progress = auditProgressText(status);
  const parts = [auditPhaseLabel(status.phase)];
  if (progress) parts.push(progress);
  if (detail && (!file?.title || !detail.includes(file.title))) parts.push(detail);
  return [...new Set(parts.filter(Boolean))].join(" · ");
}

function auditStatusMeta(status = {}) {
  const parts = [
    auditPhaseLabel(status.phase),
    auditProgressText(status),
    status.force ? "полная переиндексация" : "",
    status.updatedAt ? `обновлено ${shortDateTime(status.updatedAt)}` : ""
  ].filter(Boolean);
  return parts.join(" · ");
}

function auditItemElement({ label, value, detail = "", tone = "idle", meta = "", currentFile = "", pipelineStatus = null } = {}) {
  const item = document.createElement("article");
  item.className = `audit-list-item is-${tone}`;
  if (pipelineStatus) item.classList.add("has-pipeline");
  item.innerHTML = `
    <span class="audit-list-dot" aria-hidden="true"></span>
    <span class="audit-list-main">
      <span class="audit-list-head">
        <span class="audit-list-label"></span>
        <strong class="audit-list-value"></strong>
      </span>
      <span class="audit-list-file"></span>
      <span class="audit-list-meta"></span>
      <span class="audit-list-detail"></span>
    </span>
  `;
  item.querySelector(".audit-list-label").textContent = label || "";
  item.querySelector(".audit-list-value").textContent = value || "";
  const fileNode = item.querySelector(".audit-list-file");
  fileNode.textContent = currentFile ? `Файл: ${currentFile}` : "";
  fileNode.hidden = !fileNode.textContent;
  const metaNode = item.querySelector(".audit-list-meta");
  const detailNode = item.querySelector(".audit-list-detail");
  metaNode.textContent = meta || "";
  detailNode.textContent = detail || "";
  metaNode.hidden = !metaNode.textContent;
  detailNode.hidden = !detailNode.textContent;
  if (pipelineStatus) {
    const pipeline = renderIndexPipeline(pipelineStatus);
    pipeline.classList.add("audit-pipeline");
    item.querySelector(".audit-list-main").append(pipeline);
  }
  return item;
}

function auditActiveMovements() {
  const rows = [];
  const seenSourceIds = new Set();

  for (const source of state.sources) {
    const status = source?.indexStatus || {};
    if (status.status !== "running") continue;
    seenSourceIds.add(source.id);
    const file = auditCurrentFile(status);
    rows.push({
      sourceId: source.id,
      file,
      phase: status.phase || "",
      progress: auditProgressText(status),
      label: source.title || source.id,
      value: auditPhaseLabel(status.phase),
      currentFile: file ? (file.title || file.relativePath) : "",
      meta: [
        file?.relativePath && file.relativePath !== file.title ? file.relativePath : "",
        status.updatedAt ? `обновлено ${shortDateTime(status.updatedAt)}` : ""
      ].filter(Boolean).join(" · "),
      detail: auditPipelineDetail(status, file),
      tone: indexHealthStatus(status) === "stale" ? "warning" : "running",
      pipelineStatus: status
    });
  }

  const run = state.agentStatus.latestRun;
  const current = isAgentRunActive(run) ? currentAgentSourceRun(run) : null;
  if (current && !seenSourceIds.has(current.sourceId)) {
    const source = sourceById(current.sourceId);
    const file = auditCurrentFile(current);
    rows.push({
      sourceId: current.sourceId || "",
      file,
      phase: current.phase || "",
      progress: auditProgressText(current),
      label: source?.title || current.sourceTitle || current.sourceId || "Агент индексации",
      value: auditPhaseLabel(current.phase),
      currentFile: file ? (file.title || file.relativePath) : "",
      meta: [
        agentSourcePosition(run, current),
        current.updatedAt ? `обновлено ${shortDateTime(current.updatedAt)}` : ""
      ].filter(Boolean).join(" · "),
      detail: auditPipelineDetail(current, file) || current.message || formatAgentRunStatus(run),
      tone: "running",
      pipelineStatus: {
        status: "running",
        ...current
      }
    });
  }

  return rows;
}

function auditRecentMovements(limit = 5) {
  return state.sources
    .map((source) => ({ source, status: source?.indexStatus || {} }))
    .filter(({ status }) => status.status && status.status !== "not_indexed")
    .sort((left, right) => {
      const leftTime = new Date(left.status.updatedAt || left.status.finishedAt || left.status.startedAt || 0).getTime();
      const rightTime = new Date(right.status.updatedAt || right.status.finishedAt || right.status.startedAt || 0).getTime();
      return rightTime - leftTime;
    })
    .slice(0, limit)
    .map(({ source, status }) => ({
      label: source.title || source.id,
      value: status.status === "completed" ? "готово" : auditPhaseLabel(status.phase || status.status),
      meta: [sourceTypeLabel(source), auditStatusMeta(status)].filter(Boolean).join(" · "),
      detail: auditMovementDetail(status),
      tone: auditToneFromStatus(status.status)
    }));
}

function auditStatusRows(activeMovements = auditActiveMovements()) {
  const overview = state.indexOverview || {};
  const files = overview.files || {};
  const running = overview.running || {};
  const vectorStore = state.integrationsStatus?.vectorStore || {};
  const reranker = state.integrationsStatus?.reranker || {};
  const latestRun = state.agentStatus.latestRun || null;
  const remoteContextAllowed = Boolean(state.llm?.remote?.enabled || state.llm?.allowRemoteContext);
  const provider = state.llm?.provider || "local";
  const fallback = Boolean(state.llm?.fallbackToLocalOnRemoteError);
  const recognized = Number(files.recognized || 0);
  const indexed = Number(files.indexed || 0);
  const total = Number(files.total || indexed || 0);
  const chunks = Number(files.chunks || 0);
  const runningJobs = Number(running.jobs || activeMovements.length || 0);
  const qdrantEnabled = vectorStore.qdrantEnabled ?? overview.qdrant?.enabled;
  const qdrantAvailable = vectorStore.qdrantAvailable ?? overview.qdrant?.available;
  const qdrantPoints = optionalNumber(vectorStore.qdrantPoints) ?? optionalNumber(overview.qdrant?.points);
  const qdrantUnknown = qdrantEnabled === undefined && qdrantAvailable === undefined;

  const rows = [
    {
      label: "Бэкенд",
      value: state.backendProcessStatus?.running === false ? "недоступен" : "работает",
      tone: state.backendProcessStatus?.running === false ? "error" : "ready",
      detail: state.backendProcessStatus?.state || "running"
    },
    {
      label: "Индексация",
      value: runningJobs ? `идёт: ${formatCount(runningJobs)}` : (indexed ? "нет активных jobs" : "индекс ещё пуст"),
      tone: runningJobs ? "running" : (indexed ? "ready" : "idle"),
      detail: total ? `распознано ${formatCount(recognized)}/${formatCount(total)}, фрагментов ${formatCount(chunks)}` : ""
    },
    {
      label: "Агент",
      value: isAgentRunActive(latestRun) || isAgentStarting(latestRun) ? "работает" : (latestRun?.status || "не запускался"),
      tone: isAgentRunActive(latestRun) || isAgentStarting(latestRun) ? "running" : auditToneFromStatus(latestRun?.status),
      detail: latestRun ? formatAgentRunStatus(latestRun) : ""
    },
    {
      label: "Векторы",
      value: qdrantUnknown ? "проверка" : (qdrantEnabled === false ? "JSON fallback" : (qdrantAvailable ? "Qdrant подключён" : "Qdrant недоступен")),
      tone: qdrantUnknown ? "idle" : (qdrantEnabled === false ? "idle" : (qdrantAvailable ? "ready" : "warning")),
      detail: qdrantPoints === null ? "" : `точек ${formatCount(qdrantPoints)}`
    },
    {
      label: "Reranker",
      value: reranker.enabled ? (reranker.configured ? "готов" : "включён без URL") : "выключен",
      tone: reranker.enabled ? (reranker.configured ? "ready" : "warning") : "idle",
      detail: reranker.enabled && reranker.model ? `модель ${reranker.model}` : ""
    },
    {
      label: "LLM route",
      value: provider === "remote"
        ? (remoteContextAllowed ? "remote context разрешён" : "remote выбран, context выключен")
        : (provider === "auto" ? "auto local-first" : "local-first"),
      tone: provider === "remote" && !remoteContextAllowed ? "warning" : "ready",
      detail: fallback ? "fallback remote -> local разрешён" : "fallback remote -> local выключен"
    }
  ];

  if (state.audit.error) {
    rows.unshift({
      label: "Аудит",
      value: "ошибка обновления",
      tone: "error",
      detail: state.audit.error
    });
  }

  return rows;
}

function auditSummaryText(activeMovements = auditActiveMovements()) {
  if (state.audit.loading) return "Обновляю статусы...";
  if (state.audit.error) return state.audit.error;
  const overview = state.indexOverview || {};
  const files = overview.files || {};
  const recognized = Number(files.recognized || 0);
  const total = Number(files.total || files.indexed || 0);
  const updated = state.audit.updatedAt ? shortDateTime(state.audit.updatedAt) : "";
  const base = activeMovements.length
    ? `Активно: ${formatCount(activeMovements.length)}`
    : "Активных процессов нет";
  const index = total ? `распознано ${formatCount(recognized)}/${formatCount(total)}` : "";
  return [base, index, updated ? `обновлено ${updated}` : ""].filter(Boolean).join(" · ");
}

function renderAuditStatusBar(activeMovements = auditActiveMovements()) {
  const statusNode = $("#audit-job-status");
  const progress = $("#audit-index-progress");
  const fill = $("#audit-index-progress-fill");
  const label = $("#audit-index-progress-label");
  if (!statusNode || !progress || !fill || !label) return;

  const activeJob = activeMovements.find((row) => row.pipelineStatus)?.pipelineStatus || null;
  if (!activeJob) {
    setIndexStatusBarTone("#audit-index-status-bar", state.audit.loading ? "checking" : (state.audit.error ? "error" : "empty"));
    statusNode.textContent = state.audit.loading ? "Обновляю статусы..." : "Активной индексации нет.";
    resetIndexProgressTarget({ progress, fill, label });
    return;
  }

  setIndexStatusBarTone("#audit-index-status-bar", indexStatusTone(activeJob));
  statusNode.textContent = jobStatusText(activeJob);
  renderIndexProgressTarget({ progress, fill, label }, activeJob);
}

function renderAuditPanel() {
  const statusList = $("#audit-status-list");
  const movementList = $("#audit-movement-list");
  if (!statusList || !movementList) return;

  const activeMovements = auditActiveMovements();
  const movementRows = activeMovements.length ? activeMovements : auditRecentMovements();
  renderAuditStatusBar(activeMovements);
  setText("#audit-status-summary", auditSummaryText(activeMovements));
  setText(
    "#audit-movement-summary",
    activeMovements.length
      ? `Сейчас в работе: ${formatCount(activeMovements.length)}`
      : (movementRows.length ? "Активных движений нет; показаны последние статусы." : "Активных движений с файлами сейчас нет.")
  );

  statusList.innerHTML = "";
  for (const row of auditStatusRows(activeMovements)) {
    statusList.append(auditStatusPill(row));
  }

  recordAuditFeed(activeMovements);
  renderAuditFeed(activeMovements);
  renderAuditRecentFiles();

  movementList.innerHTML = "";
  if (!activeMovements.length) {
    movementList.append(auditItemElement({
      label: "Сейчас",
      value: "нет активных движений",
      tone: "idle",
      detail: movementRows.length
        ? "Индексатор, OCR, embeddings и Qdrant сейчас ничего не записывают; ниже — последние обработанные файлы."
        : "Индексатор, OCR, embeddings и Qdrant сейчас ничего не записывают."
    }));
    return;
  }

  for (const row of activeMovements) {
    movementList.append(auditNowCard(row));
  }
}

// Компактная пилюля системного статуса: название + значение, расшифровка — в title.
function auditStatusPill({ label, value, detail = "", tone = "idle" } = {}) {
  const pill = document.createElement("span");
  pill.className = `audit-status-pill is-${tone}`;
  if (detail) pill.title = detail;
  pill.innerHTML = `
    <span class="audit-status-pill-dot" aria-hidden="true"></span>
    <span class="audit-status-pill-label"></span>
    <strong class="audit-status-pill-value"></strong>
  `;
  pill.querySelector(".audit-status-pill-label").textContent = label || "";
  pill.querySelector(".audit-status-pill-value").textContent = value || "";
  return pill;
}

function auditFileIcon(extension = "") {
  const value = String(extension || "").toLowerCase();
  if (value.includes("pdf")) return "📕";
  if (value.includes("xls") || value.includes("csv")) return "📊";
  if (value.includes("doc") || value.includes("rtf")) return "📄";
  if (value.includes("ppt")) return "📽";
  if (value.includes("google")) return "🌐";
  return "📁";
}

// Прогресс внутри файла: OCR считает страницы, векторизация — фрагменты.
// Если бэкенд не даёт счётчиков, показываем неопределённый бар (percent = null).
function auditFileProgress(status = {}) {
  const phase = String(status.phase || "");
  if (phase === "ocr") {
    const page = Number(status.ocrPage || 0);
    const pages = Number(status.ocrPages || status.ocrTotalPages || 0);
    if (pages > 0) {
      return {
        percent: Math.min(100, Math.round((page / pages) * 100)),
        label: `OCR: страница ${formatCount(page)}/${formatCount(pages)}`
      };
    }
    return { percent: null, label: "OCR распознаёт страницы" };
  }

  if (phase === "embed" || phase === "vector_store") {
    const processed = Number(status.vectorsProcessed || 0);
    const total = Number(status.vectorsTotal || 0);
    if (total > 0) {
      return {
        percent: Math.min(100, Math.round((processed / total) * 100)),
        label: `Векторы: ${formatCount(processed)}/${formatCount(total)}`
      };
    }
    return { percent: null, label: "Векторизация фрагментов" };
  }

  const label = auditPhaseLabel(phase);
  return { percent: null, label: label ? `Обработка: ${label}` : "Обработка файла" };
}

function auditProgressBar({ percent = null, label = "", variant = "file" } = {}) {
  const wrapper = document.createElement("div");
  wrapper.className = `audit-progress audit-progress--${variant}`;
  if (percent === null) wrapper.classList.add("is-indeterminate");
  wrapper.innerHTML = `
    <div class="audit-progress-head">
      <span class="audit-progress-label"></span>
      <span class="audit-progress-value"></span>
    </div>
    <div class="audit-progress-track" role="progressbar" aria-valuemin="0" aria-valuemax="100">
      <div class="audit-progress-fill"></div>
    </div>
  `;
  wrapper.querySelector(".audit-progress-label").textContent = label;
  const value = wrapper.querySelector(".audit-progress-value");
  const track = wrapper.querySelector(".audit-progress-track");
  const fill = wrapper.querySelector(".audit-progress-fill");
  if (percent === null) {
    value.textContent = "";
    track.setAttribute("aria-valuetext", label || "выполняется");
  } else {
    value.textContent = `${percent}%`;
    track.setAttribute("aria-valuenow", String(percent));
    fill.style.width = `${percent}%`;
  }
  return wrapper;
}

// Карточка «сейчас в работе»: крупно файл, под ним путь, этапы и прогресс.
function auditNowCard(row) {
  const card = document.createElement("article");
  card.className = `audit-now-card is-${row.tone || "running"}`;
  card.innerHTML = `
    <header class="audit-now-head">
      <span class="audit-now-project"></span>
      <span class="audit-now-phase"></span>
      <span class="audit-now-progress"></span>
    </header>
    <div class="audit-now-file">
      <span class="audit-now-file-icon" aria-hidden="true"></span>
      <span class="audit-now-file-text">
        <span class="audit-now-file-title"></span>
        <span class="audit-now-file-path"></span>
      </span>
    </div>
    <div class="audit-now-detail"></div>
  `;
  card.querySelector(".audit-now-project").textContent = row.label || "";
  card.querySelector(".audit-now-phase").textContent = row.value || "";
  const progressNode = card.querySelector(".audit-now-progress");
  progressNode.textContent = row.progress || "";
  progressNode.hidden = !progressNode.textContent;

  const fileBlock = card.querySelector(".audit-now-file");
  if (row.file) {
    card.querySelector(".audit-now-file-icon").textContent = auditFileIcon(row.file.extension);
    card.querySelector(".audit-now-file-title").textContent = row.file.title || row.file.relativePath;
    const pathNode = card.querySelector(".audit-now-file-path");
    const relative = row.file.relativePath && row.file.relativePath !== row.file.title ? row.file.relativePath : "";
    pathNode.textContent = relative;
    pathNode.hidden = !relative;
  } else {
    fileBlock.hidden = true;
  }

  const detailNode = card.querySelector(".audit-now-detail");
  detailNode.textContent = row.detail || "";
  detailNode.hidden = !detailNode.textContent;

  const status = row.pipelineStatus || {};
  if (row.file) {
    const fileProgress = auditFileProgress(status);
    fileBlock.after(auditProgressBar({ ...fileProgress, variant: "file" }));
  }

  const processed = Number(status.processed || 0);
  const totalFiles = Number(status.total || status.files || 0);
  const overallPercent = jobProgressPercent(status) ?? null;
  if (totalFiles > 0 || overallPercent !== null) {
    card.append(auditProgressBar({
      percent: overallPercent,
      label: totalFiles > 0
        ? `Файлы проекта: ${formatCount(processed)}/${formatCount(totalFiles)}`
        : "Прогресс проекта",
      variant: "source"
    }));
  }

  if (row.pipelineStatus) {
    const pipeline = renderIndexPipeline(row.pipelineStatus);
    pipeline.classList.add("audit-pipeline");
    card.append(pipeline);
  }
  return card;
}

// Лента: запоминаем каждый новый файл, который видим в текущих движениях.
function recordAuditFeed(activeMovements) {
  for (const row of activeMovements) {
    if (!row.file) continue;
    const key = `${row.sourceId || row.label}:${row.file.relativePath || row.file.title}`;
    const last = state.audit.feed[0];
    if (last && last.key === key) {
      last.phase = row.value || last.phase;
      continue;
    }
    if (state.audit.feed.some((entry) => entry.key === key && Date.now() - entry.at < 60000)) continue;
    state.audit.feed.unshift({
      key,
      at: Date.now(),
      sourceId: row.sourceId || "",
      sourceTitle: row.label || "",
      title: row.file.title || row.file.relativePath,
      relativePath: row.file.relativePath || "",
      extension: row.file.extension || "",
      phase: row.value || ""
    });
  }
  state.audit.feed = state.audit.feed.slice(0, 40);
}

function renderAuditFeed(activeMovements = []) {
  const list = $("#audit-feed-list");
  if (!list) return;
  const activeKeys = new Set(activeMovements
    .filter((row) => row.file)
    .map((row) => `${row.sourceId || row.label}:${row.file.relativePath || row.file.title}`));
  list.innerHTML = "";
  if (!state.audit.feed.length) {
    setText("#audit-feed-summary", "Пока ничего не обрабатывалось в этой сессии.");
    list.innerHTML = '<div class="empty">Запустите индексацию — файлы будут появляться здесь по мере обработки.</div>';
    return;
  }

  setText("#audit-feed-summary", `За сессию: ${formatCount(state.audit.feed.length)}`);
  for (const entry of state.audit.feed) {
    const item = document.createElement("div");
    const inWork = activeKeys.has(entry.key);
    item.className = `audit-feed-item${inWork ? " is-active" : ""}`;
    item.innerHTML = `
      <span class="audit-feed-time"></span>
      <span class="audit-feed-icon" aria-hidden="true"></span>
      <span class="audit-feed-main">
        <span class="audit-feed-title"></span>
        <span class="audit-feed-meta"></span>
      </span>
      <span class="audit-feed-phase"></span>
    `;
    item.querySelector(".audit-feed-time").textContent = new Date(entry.at)
      .toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
    item.querySelector(".audit-feed-icon").textContent = auditFileIcon(entry.extension);
    item.querySelector(".audit-feed-title").textContent = entry.title;
    item.querySelector(".audit-feed-title").title = entry.relativePath || entry.title;
    item.querySelector(".audit-feed-meta").textContent = entry.sourceTitle;
    item.querySelector(".audit-feed-phase").textContent = inWork ? `${entry.phase} · в работе` : entry.phase;
    list.append(item);
  }
}

function auditRecentFileTone(file) {
  const quality = file.quality?.status || "";
  if (quality === "error" || Number(file.chunks || 0) <= 0) return "error";
  if (quality === "warning") return "warning";
  return "ready";
}

function renderAuditRecentFiles() {
  const list = $("#audit-recent-list");
  if (!list) return;
  const recent = state.audit.recent;
  list.innerHTML = "";

  if (recent.loading && !recent.files.length) {
    setText("#audit-recent-summary", "Загрузка файлов...");
    list.innerHTML = '<div class="empty">Загрузка...</div>';
    return;
  }
  if (recent.error) {
    setText("#audit-recent-summary", recent.error);
    list.innerHTML = `<div class="empty">${recent.error}</div>`;
    return;
  }
  if (!recent.files.length) {
    setText("#audit-recent-summary", "Проиндексированных файлов пока нет.");
    list.innerHTML = '<div class="empty">Файлы появятся после первой индексации.</div>';
    return;
  }

  setText("#audit-recent-summary", `Последние ${formatCount(recent.files.length)} файлов по времени индексации`);
  for (const file of recent.files) {
    const item = document.createElement("div");
    item.className = `audit-recent-item is-${auditRecentFileTone(file)}`;
    item.innerHTML = `
      <span class="audit-recent-icon" aria-hidden="true"></span>
      <span class="audit-recent-main">
        <span class="audit-recent-title"></span>
        <span class="audit-recent-meta"></span>
      </span>
      <span class="audit-recent-chunks"></span>
      <span class="audit-recent-actions">
        <button type="button" class="secondary btn-small audit-recent-open">Открыть</button>
        <button type="button" class="secondary btn-small audit-recent-reveal">В папке</button>
      </span>
    `;
    item.querySelector(".audit-recent-icon").textContent = auditFileIcon(file.extension);
    const titleNode = item.querySelector(".audit-recent-title");
    titleNode.textContent = file.title;
    titleNode.title = file.relativePath || file.title;
    item.querySelector(".audit-recent-meta").textContent = [
      file.sourceTitle,
      file.indexedAt ? shortDateTime(file.indexedAt) : ""
    ].filter(Boolean).join(" · ");
    item.querySelector(".audit-recent-chunks").textContent = Number(file.chunks || 0) > 0
      ? `${formatCount(file.chunks)} фрагм.`
      : "нет фрагментов";
    item.querySelector(".audit-recent-open")
      .addEventListener("click", () => openPreviewSystemFile("open", file));
    item.querySelector(".audit-recent-reveal")
      .addEventListener("click", () => openPreviewSystemFile("reveal", file));
    list.append(item);
  }
}

// История берётся из уже существующего /indexed-files по самым свежим источникам —
// отдельного бэкенд-эндпойнта под ленту нет.
async function loadAuditRecentFiles({ limitSources = 4, limitFiles = 20 } = {}) {
  const recent = state.audit.recent;
  if (recent.loading) return;

  const candidates = state.sources
    .filter((source) => source?.indexStatus?.status && source.indexStatus.status !== "not_indexed")
    .sort((left, right) => {
      const leftRunning = left.indexStatus.status === "running" ? 1 : 0;
      const rightRunning = right.indexStatus.status === "running" ? 1 : 0;
      if (leftRunning !== rightRunning) return rightRunning - leftRunning;
      const leftTime = new Date(left.indexStatus.updatedAt || left.indexStatus.finishedAt || 0).getTime();
      const rightTime = new Date(right.indexStatus.updatedAt || right.indexStatus.finishedAt || 0).getTime();
      return rightTime - leftTime;
    })
    .slice(0, limitSources);

  if (!candidates.length) {
    state.audit.recent = { loading: false, error: "", files: [], updatedAt: Date.now() };
    renderAuditRecentFiles();
    return;
  }

  recent.loading = true;
  renderAuditRecentFiles();

  const results = await Promise.allSettled(candidates.map((source) =>
    api(`/api/sources/${encodeURIComponent(source.id)}/indexed-files`)
  ));

  const files = [];
  const seen = new Set();
  for (const result of results) {
    if (result.status !== "fulfilled") continue;
    for (const file of result.value.files || []) {
      const key = file.fileId || `${file.sourceId}:${file.relativePath}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (file.indexedAt) files.push(file);
    }
  }
  files.sort((left, right) => new Date(right.indexedAt).getTime() - new Date(left.indexedAt).getTime());

  const failed = results.every((result) => result.status === "rejected");
  state.audit.recent = {
    loading: false,
    error: failed ? "Не удалось загрузить список файлов" : "",
    files: files.slice(0, limitFiles),
    updatedAt: Date.now()
  };
  renderAuditRecentFiles();
}

async function refreshAuditStatus({ silent = false } = {}) {
  if (state.audit.loading) return;
  if (!auditPanelVisible() && silent) return;

  state.audit.loading = true;
  state.audit.error = "";
  if (!silent) setText("#audit-status-summary", "Обновляю статусы...");
  renderAuditPanel();

  const results = await Promise.allSettled([
    loadSources(),
    refreshIndexOverviewStatus({ silent: true }),
    refreshIntegrationsStatus(),
    refreshAgentStatus({ silent: true })
  ]);
  const failed = results.find((result) => result.status === "rejected");
  state.audit.error = failed ? apiErrorMessage(failed.reason, "Не удалось обновить аудит") : "";
  state.audit.updatedAt = Date.now();
  state.audit.loading = false;
  renderAuditPanel();
  loadAuditRecentFiles().catch(() => {});
}

function sourceIndexDotClass(status = {}) {
  const health = indexHealthStatus(status);
  if (health === "stale") return "is-stalled";
  if (health === "interrupted") return "is-error";
  if (status.status === "running") return "is-indexing";
  if (status.status === "failed") return "is-error";
  if (sourceHasReadyIndex(status)) return "is-indexed";
  return "is-empty";
}

function sourceIndexDotTitle(status = {}) {
  if (indexHealthNeedsAttention(status)) return formatIndexSummary(status);
  if (status.status === "running") return formatIndexSummary(status);
  if (status.status === "failed") return formatIndexSummary(status);
  if (sourceHasReadyIndex(status)) return "Индекс готов";
  return "Индекс не создан";
}

function latestIndexedAt(files = []) {
  return files
    .map((file) => file.indexedAt)
    .filter(Boolean)
    .sort()
    .at(-1);
}

function syncSourceStatusFromIndexedFiles(sourceId, indexedFiles = {}) {
  const source = sourceById(sourceId);
  if (!source) return false;

  const files = indexedFiles.files || [];
  const indexedFilesCount = Number(indexedFiles.total || files.length || 0);
  const chunks = Number(indexedFiles.chunks || files.reduce((sum, file) => sum + Number(file.chunks || 0), 0));
  if (!indexedFilesCount && !chunks) return false;

  const current = source.indexStatus || {};
  const next = {
    ...current,
    indexedFiles: Math.max(Number(current.indexedFiles || 0), indexedFilesCount),
    total: Math.max(Number(current.total || 0), indexedFilesCount),
    eligibleFiles: Math.max(Number(current.eligibleFiles || 0), indexedFilesCount),
    chunks: Math.max(Number(current.chunks || 0), chunks),
    vectorsTotal: Math.max(Number(current.vectorsTotal || 0), chunks)
  };

  if (current.status !== "running") {
    next.status = "completed";
    next.phase = current.phase || "manifest";
    next.message = current.status === "completed" ? (current.message || "Готово") : "Индекс найден";
    next.finishedAt = current.finishedAt || current.updatedAt || latestIndexedAt(files);
    next.updatedAt = current.updatedAt || next.finishedAt;
  }

  const changed = JSON.stringify(current) !== JSON.stringify(next);
  if (changed) source.indexStatus = next;
  return changed;
}

function updateChatReadyBadge(source, status = {}) {
  const badge = $("#chat-ready-status");
  badge.classList.remove("ready", "indexing", "error", "not-ready");
  const statusBar = $("#chat-index-status-bar");
  if (!statusBar?.classList.contains("has-progress") || status.status === "running") {
    setIndexStatusBarTone(statusBar, source ? indexStatusTone(status) : "ready");
  }
  const health = indexHealthStatus(status);

  if (!source) {
    badge.classList.add("ready");
    badge.textContent = "Авто по вопросу";
    return;
  }

  if (health === "stale") {
    badge.classList.add("error");
    badge.textContent = "\u041d\u0435\u0442 \u043f\u0440\u043e\u0433\u0440\u0435\u0441\u0441\u0430";
    return;
  }

  if (health === "interrupted") {
    badge.classList.add("error");
    badge.textContent = "\u0418\u043d\u0434\u0435\u043a\u0441 \u0443\u043f\u0430\u043b";
    return;
  }

  if (status.status === "completed") {
    badge.classList.add("ready");
    badge.textContent = "Готов к чату";
    return;
  }

  if (status.status === "running") {
    badge.classList.add("indexing");
    badge.textContent = "Индексируется";
    return;
  }

  if (status.status === "failed") {
    badge.classList.add("error");
    badge.textContent = "Ошибка индекса";
    return;
  }

  badge.classList.add("not-ready");
  badge.textContent = "Нужна индексация";
}

function updateProjectIndexUi() {
  const source = selectedSource();
  const status = selectedIndexStatus();
  const info = $("#project-index-info");

  updateChatReadyBadge(source, status);
  if (status.status === "running") {
    showIndexProgress(status);
    if (status.id) pollJob(status.id);
  }
  info.textContent = source ? formatToolbarIndexInfo(status) : "Проект определится из вопроса";
}

function sourceSummaryStatsParts(source, summary = null) {
  const indexStatus = source?.indexStatus || {};
  const fileCount = optionalNumber(summary?.fileCount) ?? optionalNumber(indexStatus.indexedFiles) ?? optionalNumber(indexStatus.total);
  const chunkCount = optionalNumber(summary?.chunkCount) ?? optionalNumber(indexStatus.chunks);
  const vectorsTotal = optionalNumber(indexStatus.vectorsTotal);
  const updated = shortDateTime(summary?.updatedAt || indexStatus.finishedAt || indexStatus.updatedAt);
  const parts = [];

  if (fileCount !== null) parts.push(`${fileCount} файлов`);
  if (chunkCount !== null) parts.push(`${chunkCount} фрагментов`);
  if (vectorsTotal) parts.push(`${vectorsTotal} векторов`);
  const qdrantPart = formatQdrantSummaryPart(indexStatus);
  if (qdrantPart) parts.push(qdrantPart);
  if (updated) parts.push(`обновлено ${updated}`);

  return parts;
}

function renderSourceSummaryCard(source) {
  const summary = source?.summary || null;
  const indexStatus = source?.indexStatus || {};
  const card = document.createElement("div");
  card.className = "source-summary-card";

  const title = document.createElement("div");
  title.className = "source-summary-title";
  title.textContent = "Сводка папки";
  card.append(title);

  if (!summary && !sourceHasReadyIndex(indexStatus)) {
    const empty = document.createElement("div");
    empty.className = "source-summary-muted";
    empty.textContent = "Появится после индексации.";
    card.append(empty);
    return card;
  }

  const stats = document.createElement("div");
  stats.className = "source-summary-stats";
  stats.textContent = sourceSummaryStatsParts(source, summary).join(" · ") || "Индекс готов";
  card.append(stats);

  const topTypes = Array.isArray(summary?.topFileTypes) ? summary.topFileTypes : [];
  if (topTypes.length) {
    const types = document.createElement("div");
    types.className = "source-summary-types";
    types.textContent = topTypes
      .map((item) => {
        const extension = item.extension === "[no extension]" ? "без расширения" : item.extension || "без расширения";
        return `${extension} ${Number(item.count || 0)}`;
      })
      .join(" · ");
    card.append(types);
  }

  if (summary?.tenderRecognition) {
    const tender = summary.tenderRecognition;
    const tenderLine = document.createElement("div");
    tenderLine.className = "source-summary-types";
    tenderLine.textContent = [
      `КП ${Number(tender.commercialProposals || 0)}`,
      `цены ${Number(tender.priceSignalFiles || 0)}`,
      `сметы ${Number(tender.estimateSignalFiles || 0)}`
    ].join(" · ");
    card.append(tenderLine);
  }

  const warnings = summary?.qualityWarnings || {};
  const warningCount = Number(warnings.total || 0);
  if (warningCount > 0) {
    const warningBox = document.createElement("div");
    warningBox.className = "source-summary-warnings";
    const reasonText = (warnings.byWarning || [])
      .slice(0, 3)
      .map((item) => `${INDEXED_QUALITY_REASON_LABELS[item.warning] || item.warning}: ${Number(item.count || 0)}`)
      .join("; ");
    warningBox.textContent = reasonText
      ? `Предупреждения качества: ${reasonText}`
      : `Предупреждения качества: ${warningCount}`;
    card.append(warningBox);
  }

  if (summary?.llmSummary) {
    const llmSummary = document.createElement("div");
    llmSummary.className = "source-summary-llm";
    llmSummary.textContent = summary.llmSummary;
    card.append(llmSummary);
  }

  return card;
}

function recognitionQualityStatusLabel(status) {
  return {
    ok: "\u0445\u043e\u0440\u043e\u0448\u043e",
    warning: "\u043d\u0443\u0436\u043d\u043e \u043f\u0440\u043e\u0432\u0435\u0440\u0438\u0442\u044c",
    error: "\u0435\u0441\u0442\u044c \u043e\u0448\u0438\u0431\u043a\u0438",
    empty: "\u043d\u0435\u0442 \u0434\u0430\u043d\u043d\u044b\u0445"
  }[status] || "\u043d\u0435\u0442 \u0434\u0430\u043d\u043d\u044b\u0445";
}

function roundedPercent(value) {
  const number = optionalNumber(value);
  return number === null ? "-" : `${Math.round(number)}%`;
}

function formatRecognitionQualityStatusHint(quality = {}, score = 0) {
  const files = quality.files || {};
  const ocr = quality.ocr || {};
  const parts = [];
  const errorFiles = Number(files.error || 0);
  const totalFiles = Number(files.total || 0);
  const searchable = Number(files.searchable || 0);
  const filesWithoutSearch = Math.max(0, totalFiles - searchable);

  if (errorFiles > 0) {
    parts.push(`${formatCount(errorFiles)} ${pluralRu(errorFiles, "\u0444\u0430\u0439\u043b \u0441 \u043e\u0448\u0438\u0431\u043a\u043e\u0439", "\u0444\u0430\u0439\u043b\u0430 \u0441 \u043e\u0448\u0438\u0431\u043a\u0430\u043c\u0438", "\u0444\u0430\u0439\u043b\u043e\u0432 \u0441 \u043e\u0448\u0438\u0431\u043a\u0430\u043c\u0438")}`);
  }
  if (filesWithoutSearch > 0) {
    parts.push(`${formatCount(filesWithoutSearch)} ${pluralRu(filesWithoutSearch, "\u0444\u0430\u0439\u043b \u0431\u0435\u0437 \u043f\u043e\u0438\u0441\u043a\u0430", "\u0444\u0430\u0439\u043b\u0430 \u0431\u0435\u0437 \u043f\u043e\u0438\u0441\u043a\u0430", "\u0444\u0430\u0439\u043b\u043e\u0432 \u0431\u0435\u0437 \u043f\u043e\u0438\u0441\u043a\u0430")}`);
  }
  if (Number(ocr.lowConfidenceFiles || 0) > 0) {
    const count = Number(ocr.lowConfidenceFiles || 0);
    parts.push(`\u043d\u0438\u0437\u043a\u0430\u044f OCR-\u0443\u0432\u0435\u0440\u0435\u043d\u043d\u043e\u0441\u0442\u044c: ${formatCount(count)} ${pluralRu(count, "\u0444\u0430\u0439\u043b", "\u0444\u0430\u0439\u043b\u0430", "\u0444\u0430\u0439\u043b\u043e\u0432")}`);
  }
  if (Number(ocr.emptyPages || 0) > 0) {
    const count = Number(ocr.emptyPages || 0);
    parts.push(`\u043f\u0443\u0441\u0442\u044b\u0435 OCR-\u0441\u0442\u0440\u0430\u043d\u0438\u0446\u044b: ${formatCount(count)}`);
  }

  if (parts.length) {
    return `\u0421\u0440\u0435\u0434\u043d\u0438\u0439 \u0431\u0430\u043b\u043b ${score}%, \u043d\u043e \u0435\u0441\u0442\u044c \u043f\u0440\u043e\u0431\u043b\u0435\u043c\u044b: ${parts.join("; ")}.`;
  }
  if (quality.status === "warning") return `\u0421\u0440\u0435\u0434\u043d\u0438\u0439 \u0431\u0430\u043b\u043b ${score}%, \u043d\u043e \u0435\u0441\u0442\u044c \u0444\u0430\u0439\u043b\u044b \u0434\u043b\u044f \u0440\u0443\u0447\u043d\u043e\u0439 \u043f\u0440\u043e\u0432\u0435\u0440\u043a\u0438.`;
  if (quality.status === "error") return `\u0421\u0440\u0435\u0434\u043d\u0438\u0439 \u0431\u0430\u043b\u043b ${score}%; \u043e\u0448\u0438\u0431\u043a\u0438 \u0432\u0438\u0434\u043d\u044b \u0432 \u0441\u043f\u0438\u0441\u043a\u0435 \u043d\u0438\u0436\u0435.`;
  return `\u0421\u0440\u0435\u0434\u043d\u0438\u0439 \u0431\u0430\u043b\u043b ${score}%; \u043a\u0440\u0438\u0442\u0438\u0447\u043d\u044b\u0445 \u043f\u0440\u043e\u0431\u043b\u0435\u043c \u043d\u0435 \u0432\u0438\u0434\u043d\u043e.`;
}

function formatOcrConfidenceValue(confidence, confidenceP10) {
  if (confidence === null) return "-";
  const avg = `\u0441\u0440\u0435\u0434\u043d\u044f\u044f ${Math.round(confidence)}%`;
  return confidenceP10 === null
    ? avg
    : `${avg}; 10% \u0441\u0442\u0440. \u0434\u043e ${Math.round(confidenceP10)}%`;
}

function appendRecognitionQualityMetric(container, label, value, title = "") {
  const row = document.createElement("div");
  row.className = "recognition-quality-metric";
  if (title) row.title = title;
  row.innerHTML = `
    <span class="recognition-quality-metric-label"></span>
    <span class="recognition-quality-metric-value"></span>
  `;
  row.querySelector(".recognition-quality-metric-label").textContent = label;
  row.querySelector(".recognition-quality-metric-value").textContent = value;
  container.append(row);
}

function recognitionQualityFocusItems(summary = {}, quality = {}) {
  const warnings = Array.isArray(summary?.qualityWarnings?.byWarning) ? summary.qualityWarnings.byWarning : [];
  const files = quality.files || {};
  const ocr = quality.ocr || {};
  const items = [];

  if (Number(files.total || 0) > Number(files.searchable || 0)) {
    items.push(`\u0444\u0430\u0439\u043b\u044b \u0431\u0435\u0437 \u043f\u043e\u0438\u0441\u043a\u043e\u0432\u044b\u0445 \u0444\u0440\u0430\u0433\u043c\u0435\u043d\u0442\u043e\u0432: ${formatCount(Number(files.total || 0) - Number(files.searchable || 0))}`);
  }
  const coveredWarnings = new Set();
  if (Number(files.total || 0) > Number(files.searchable || 0)) coveredWarnings.add("no_chunks");
  if (Number(ocr.limitedFiles || 0) > 0) {
    items.push(`OCR \u043e\u0431\u0440\u0430\u0431\u043e\u0442\u0430\u043b \u043d\u0435 \u0432\u0441\u0435 \u0441\u0442\u0440\u0430\u043d\u0438\u0446\u044b: ${formatCount(ocr.limitedFiles)}`);
    coveredWarnings.add("ocr_limited");
  }
  if (Number(ocr.lowConfidenceFiles || 0) > 0) {
    items.push(`\u043d\u0438\u0437\u043a\u0430\u044f OCR-\u0443\u0432\u0435\u0440\u0435\u043d\u043d\u043e\u0441\u0442\u044c: ${formatCount(ocr.lowConfidenceFiles)}`);
    coveredWarnings.add("low_ocr_confidence");
    coveredWarnings.add("low_ocr_page_confidence");
  }
  if (Number(ocr.emptyPages || 0) > 0) {
    items.push(`\u043f\u0443\u0441\u0442\u044b\u0435 OCR-\u0441\u0442\u0440\u0430\u043d\u0438\u0446\u044b: ${formatCount(ocr.emptyPages)}`);
    coveredWarnings.add("empty_ocr_pages");
  }

  for (const item of warnings) {
    if (items.length >= 5) break;
    const warning = item.warning || "";
    if (coveredWarnings.has(warning)) continue;
    const label = INDEXED_QUALITY_REASON_LABELS[warning] || warning;
    const value = `${label}: ${formatCount(item.count)}`;
    if (!items.includes(value)) items.push(value);
  }

  if (!items.length) {
    items.push("\u0421\u043b\u0430\u0431\u044b\u0445 \u043c\u0435\u0441\u0442 \u043f\u043e \u0441\u043e\u0445\u0440\u0430\u043d\u0435\u043d\u043d\u044b\u043c \u043c\u0435\u0442\u0440\u0438\u043a\u0430\u043c \u043d\u0435 \u0432\u0438\u0434\u043d\u043e.");
  }

  return items.slice(0, 5);
}

function renderRecognitionQualityCard(source) {
  const summary = source?.summary || null;
  const quality = summary?.recognitionQuality || null;
  const card = document.createElement("div");
  card.className = `recognition-quality-card is-${quality?.status || "empty"}`;

  const head = document.createElement("div");
  head.className = "recognition-quality-head";
  head.innerHTML = `
    <div class="recognition-quality-title"></div>
    <div class="recognition-quality-badge"></div>
  `;
  head.querySelector(".recognition-quality-title").textContent = "\u041a\u0430\u0447\u0435\u0441\u0442\u0432\u043e \u0440\u0430\u0441\u043f\u043e\u0437\u043d\u0430\u0432\u0430\u043d\u0438\u044f";
  head.querySelector(".recognition-quality-badge").textContent = recognitionQualityStatusLabel(quality?.status || "empty");
  card.append(head);

  if (!quality) {
    const empty = document.createElement("div");
    empty.className = "recognition-quality-muted";
    empty.textContent = "\u041f\u043e\u044f\u0432\u0438\u0442\u0441\u044f \u043f\u043e\u0441\u043b\u0435 \u0438\u043d\u0434\u0435\u043a\u0441\u0430\u0446\u0438\u0438.";
    card.append(empty);
    return card;
  }

  const score = Math.max(0, Math.min(100, Math.round(Number(quality.score || 0))));
  const scorebar = document.createElement("div");
  scorebar.className = "recognition-quality-scorebar";
  scorebar.style.setProperty("--recognition-score", `${score}%`);
  scorebar.title = `\u0421\u0440\u0435\u0434\u043d\u0438\u0439 \u0431\u0430\u043b\u043b: ${score}%. \u0421\u0442\u0430\u0442\u0443\u0441 \u0443\u0447\u0438\u0442\u044b\u0432\u0430\u0435\u0442 \u043e\u0442\u0434\u0435\u043b\u044c\u043d\u044b\u0435 \u043e\u0448\u0438\u0431\u043a\u0438 \u0444\u0430\u0439\u043b\u043e\u0432 \u0438 OCR.`;
  scorebar.innerHTML = '<span></span>';
  card.append(scorebar);

  const statusNote = document.createElement("div");
  statusNote.className = "recognition-quality-status-note";
  statusNote.textContent = formatRecognitionQualityStatusHint(quality, score);
  card.append(statusNote);

  const metrics = document.createElement("div");
  metrics.className = "recognition-quality-metrics";
  const files = quality.files || {};
  const text = quality.text || {};
  const ocr = quality.ocr || {};
  const searchable = optionalNumber(files.searchable) ?? 0;
  const total = optionalNumber(files.total) ?? 0;
  const ocrPages = optionalNumber(ocr.pages);
  const ocrTotalPages = optionalNumber(ocr.totalPages);
  const confidence = optionalNumber(ocr.avgConfidence);
  const confidenceP10 = optionalNumber(ocr.confidenceP10);
  appendRecognitionQualityMetric(metrics, "\u0421\u0440\u0435\u0434\u043d\u0438\u0439 \u0431\u0430\u043b\u043b", `${score}%`);
  appendRecognitionQualityMetric(metrics, "\u0422\u0435\u043a\u0441\u0442 \u0432 \u043f\u043e\u0438\u0441\u043a\u0435", `${formatCount(searchable)}/${formatCount(total)} (${roundedPercent(files.textCoveragePercent)})`);
  appendRecognitionQualityMetric(
    metrics,
    "OCR \u0441\u0442\u0440\u0430\u043d\u0438\u0446\u044b",
    ocrTotalPages ? `${formatCount(ocrPages || 0)}/${formatCount(ocrTotalPages)} (${roundedPercent(ocr.coveragePercent)})` : (ocr.files ? "\u043d\u0435\u0442 \u0441\u0442\u0440\u0430\u043d\u0438\u0446" : "\u043d\u0435\u0442 OCR")
  );
  appendRecognitionQualityMetric(
    metrics,
    "\u0423\u0432\u0435\u0440\u0435\u043d\u043d\u043e\u0441\u0442\u044c OCR",
    formatOcrConfidenceValue(confidence, confidenceP10),
    "\u0421\u0440\u0435\u0434\u043d\u044f\u044f \u0443\u0432\u0435\u0440\u0435\u043d\u043d\u043e\u0441\u0442\u044c OCR; \u00ab10% \u0441\u0442\u0440. \u0434\u043e\u00bb \u043f\u043e\u043a\u0430\u0437\u044b\u0432\u0430\u0435\u0442 \u043f\u043e\u0440\u043e\u0433 \u0434\u043b\u044f \u0441\u0430\u043c\u044b\u0445 \u0441\u043b\u0430\u0431\u044b\u0445 \u0441\u0442\u0440\u0430\u043d\u0438\u0446."
  );
  appendRecognitionQualityMetric(metrics, "\u0424\u0430\u0439\u043b\u044b OCR", `${formatCount(ocr.files || 0)}${ocr.limitedFiles ? `, \u043b\u0438\u043c\u0438\u0442 ${formatCount(ocr.limitedFiles)}` : ""}`);
  appendRecognitionQualityMetric(metrics, "\u0421\u0438\u043c\u0432\u043e\u043b\u043e\u0432/\u0441\u043b\u043e\u0432", `${formatCount(text.avgChars || 0)}/${formatCount(text.avgWords || 0)} \u0441\u0440.`);
  card.append(metrics);

  const focus = document.createElement("div");
  focus.className = "recognition-quality-focus";
  const focusTitle = document.createElement("div");
  focusTitle.className = "recognition-quality-focus-title";
  focusTitle.textContent = "\u0427\u0442\u043e \u0434\u043e\u0440\u0430\u0431\u043e\u0442\u0430\u0442\u044c";
  const focusList = document.createElement("div");
  focusList.className = "recognition-quality-focus-list";
  focusList.textContent = recognitionQualityFocusItems(summary, quality).join("; ");
  focus.append(focusTitle, focusList);
  card.append(focus);

  return card;
}

function renderTenderLinkForm(source) {
  const form = document.createElement("form");
  form.className = "tender-link-form";

  const category = document.createElement("div");
  category.className = "tender-link-meta";
  category.textContent = source.tenderCategory
    ? `Категория тендера: ${source.tenderCategory}`
    : "Категория тендера не задана";

  const field = document.createElement("label");
  field.className = "field";

  const caption = document.createElement("span");
  caption.className = "field-caption";
  caption.textContent = "Привязанный договор";

  const select = document.createElement("select");
  select.setAttribute("aria-label", "Привязанный договор");

  const emptyOption = document.createElement("option");
  emptyOption.value = "";
  emptyOption.textContent = "Без договора";
  select.append(emptyOption);

  for (const contract of contractSourcesForUi()) {
    const option = document.createElement("option");
    option.value = contract.id;
    option.textContent = contract.title;
    select.append(option);
  }
  select.value = source.linkedContractId || "";

  field.append(caption, select);

  const actions = document.createElement("div");
  actions.className = "selected-source-actions";
  const saveButton = document.createElement("button");
  saveButton.type = "submit";
  saveButton.textContent = "Сохранить";
  actions.append(saveButton);

  const status = document.createElement("div");
  status.className = "hint";

  form.append(category, field, actions, status);
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    saveTenderLink(source.id, select.value, status);
  });

  return form;
}

function renderSourceNameForm(source) {
  const form = document.createElement("form");
  form.className = "source-name-form";

  const field = document.createElement("label");
  field.className = "field";

  const caption = document.createElement("span");
  caption.className = "field-caption";
  caption.textContent = "Наименование";

  const input = document.createElement("input");
  input.type = "text";
  input.value = source.title || "";
  input.autocomplete = "off";
  input.setAttribute("aria-label", "Наименование");

  field.append(caption, input);

  const actions = document.createElement("div");
  actions.className = "selected-source-actions";
  const saveButton = document.createElement("button");
  saveButton.type = "submit";
  saveButton.textContent = "Сохранить";
  actions.append(saveButton);

  const status = document.createElement("div");
  status.className = "hint";

  form.append(field, actions, status);
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    saveSourceTitle(source.id, input.value, status);
  });

  return form;
}

function sourceAdditionalPaths(source) {
  return Array.isArray(source?.additionalPaths)
    ? source.additionalPaths.map((entry) => String(entry || "").trim()).filter(Boolean)
    : [];
}

function sourcePathRows(source) {
  return [
    String(source?.path || "").trim(),
    ...sourceAdditionalPaths(source)
  ].filter(Boolean).map((path, index) => ({
    path,
    removable: index > 0
  }));
}

function folderPathCountLabel(count) {
  const value = Number(count || 0);
  const mod10 = value % 10;
  const mod100 = value % 100;
  const noun = mod10 === 1 && mod100 !== 11
    ? "путь"
    : mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)
      ? "пути"
      : "путей";
  const verb = noun === "путь" ? "Загружен" : "Загружено";
  return `${verb} ${value} ${noun}`;
}

function folderPathHref(folderPath = "") {
  const value = String(folderPath || "").trim();
  if (!value) return "#";
  const normalized = value.replace(/\\/g, "/");
  const encoded = (pathValue) => encodeURI(pathValue).replace(/#/g, "%23").replace(/\?/g, "%3F");
  if (/^[a-zA-Z]:\//.test(normalized)) return `file:///${encoded(normalized)}`;
  if (normalized.startsWith("//")) return `file://${encoded(normalized.slice(2))}`;
  if (normalized.startsWith("/")) return `file://${encoded(normalized)}`;
  return `file:///${encoded(normalized)}`;
}

function dedupeAdditionalPaths(source, paths = []) {
  const primaryKey = normalizedSourcePath(source?.path);
  const seen = new Set();
  const result = [];
  for (const entry of paths) {
    const nextPath = String(entry || "").trim();
    const key = normalizedSourcePath(nextPath).replace(/\/+$/, "");
    if (!key || key === primaryKey || seen.has(key)) continue;
    seen.add(key);
    result.push(nextPath);
  }
  return result;
}

async function saveSourceAdditionalPaths(sourceId, additionalPaths, statusNode) {
  if (statusNode) statusNode.textContent = "Сохраняю пути...";
  try {
    const source = await api(`/api/sources/${encodeURIComponent(sourceId)}`, {
      method: "PUT",
      body: JSON.stringify({ additionalPaths })
    });
    replaceSource(source);
    state.settingsSourceId = source.id;
    if (state.indexedFiles.sourceId === source.id) loadIndexedFiles(source.id, { force: true, silent: true });
    renderSources();
    setText("#job-status", "Пути папок сохранены. Запустите переиндексацию, чтобы добавить новые файлы в индекс.");
  } catch (error) {
    if (statusNode) statusNode.textContent = apiErrorMessage(error, "Не удалось сохранить пути");
  }
}

function renderSourcePathsPanel(source = selectedSettingsSource()) {
  const panel = $("#source-paths-panel");
  if (!panel) return;
  panel.innerHTML = "";
  panel.hidden = !source;
  if (!source) return;

  const header = document.createElement("div");
  header.className = "source-paths-header";
  const title = document.createElement("div");
  title.className = "source-paths-title";
  title.textContent = "Пути папок";
  const count = document.createElement("div");
  count.className = "hint";
  const pathRows = sourcePathRows(source);
  count.textContent = folderPathCountLabel(pathRows.length);
  header.append(title, count);

  const list = document.createElement("div");
  list.className = "source-paths-list";
  const additionalPaths = sourceAdditionalPaths(source);
  for (const row of pathRows) {
    const item = document.createElement("div");
    item.className = "source-path-row";

    const meta = document.createElement("div");
    meta.className = "source-path-meta";
    const pathLink = document.createElement("a");
    pathLink.className = "source-path-link";
    pathLink.href = folderPathHref(row.path);
    pathLink.target = "_blank";
    pathLink.rel = "noreferrer";
    pathLink.title = row.path;
    pathLink.textContent = row.path;
    meta.append(pathLink);
    item.append(meta);

    if (row.removable) {
      const removeButton = document.createElement("button");
      removeButton.type = "button";
      removeButton.className = "secondary icon-button compact-icon-button source-path-remove";
      removeButton.textContent = "×";
      removeButton.title = "Удалить путь";
      removeButton.setAttribute("aria-label", `Удалить путь ${row.path}`);
      removeButton.addEventListener("click", () => {
        const nextPaths = additionalPaths.filter((entry) => normalizedSourcePath(entry) !== normalizedSourcePath(row.path));
        saveSourceAdditionalPaths(source.id, nextPaths, panel.querySelector(".source-path-status"));
      });
      item.append(removeButton);
    }

    list.append(item);
  }

  const form = document.createElement("form");
  form.className = "source-path-add-form";
  form.innerHTML = `
    <input type="text" class="source-path-add-input" placeholder="Добавить путь к папке">
    <button type="button" class="secondary source-path-pick">Выбрать</button>
    <button type="submit">Добавить путь</button>
    <div class="source-path-status hint" aria-live="polite"></div>
  `;
  const input = form.querySelector(".source-path-add-input");
  const status = form.querySelector(".source-path-status");
  form.querySelector(".source-path-pick").addEventListener("click", async () => {
    status.textContent = "Открываю проводник...";
    const selected = await chooseFolder({
      title: "Выберите путь для этой папки RAG",
      initialPath: input.value.trim() || source.path
    });
    status.textContent = "";
    if (selected) input.value = selected;
  });
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const nextPath = input.value.trim();
    if (!nextPath) {
      status.textContent = "Укажите путь к папке.";
      return;
    }
    const nextPaths = dedupeAdditionalPaths(source, [...additionalPaths, nextPath]);
    if (nextPaths.length === additionalPaths.length) {
      status.textContent = "Этот путь уже есть в списке.";
      return;
    }
    saveSourceAdditionalPaths(source.id, nextPaths, status);
  });

  panel.append(header, list, form);
}

function createSelectedSourceActions(source, className = "selected-source-actions") {
  const status = source.indexStatus || { status: "not_indexed", message: "Не индексировалось" };
  const actions = document.createElement("div");
  actions.className = className;
  const needsQdrantReindex = sourceNeedsQdrantReindex(status);

  const indexButton = document.createElement("button");
  indexButton.type = "button";
  indexButton.textContent = indexActionLabel(status);
  indexButton.disabled = status.status === "running";
  indexButton.title = status.status === "running"
    ? "Индексация папки уже выполняется"
    : sourceHasReadyIndex(status)
      ? (needsQdrantReindex ? "Запустить переиндексацию и запись в Qdrant" : "Запустить повторную индексацию этой папки")
      : "Запустить индексацию этой папки";
  indexButton.addEventListener("click", () => {
    state.selectedSourceId = source.id;
    indexSelected(false, source.id);
  });

  const chooseButton = document.createElement("button");
  chooseButton.type = "button";
  chooseButton.className = "secondary";
  const linkedContractExists = contractSourcesForUi().some((contract) => contract.id === source.linkedContractId);
  const chatSourceId = isContractSource(source) ? source.id : (linkedContractExists ? source.linkedContractId : "");
  chooseButton.textContent = isContractSource(source) ? "Выбрать в чате" : "Выбрать договор в чате";
  chooseButton.disabled = !chatSourceId;
  chooseButton.title = chatSourceId
    ? "Открыть чат с договором"
    : "В чате выбираются только договоры; сначала привяжите тендер к договору";
  chooseButton.addEventListener("click", () => {
    if (!chatSourceId) return;
    state.selectedSourceId = chatSourceId;
    const session = activeChat();
    if (session && !(session.messages || []).length) {
      session.sourceId = chatSourceId;
      touchActiveChat();
    }
    closeSettings();
    renderSources();
    $("#question").focus();
  });

  actions.append(indexButton, chooseButton);
  if (!isContractSource(source)) {
    const moveToContractButton = document.createElement("button");
    moveToContractButton.type = "button";
    moveToContractButton.className = "secondary";
    moveToContractButton.textContent = "\u041f\u0435\u0440\u0435\u043d\u0435\u0441\u0442\u0438 \u0432 \u0434\u043e\u0433\u043e\u0432\u043e\u0440\u044b";
    moveToContractButton.addEventListener("click", () => moveTenderToContracts(source.id));
    actions.append(moveToContractButton);
  }
  const deleteButton = document.createElement("button");
  deleteButton.type = "button";
  deleteButton.className = "danger";
  deleteButton.textContent = "Удалить";
  deleteButton.disabled = state.deletingSourceIds.has(source.id) || status.status === "running";
  deleteButton.title = status.status === "running"
    ? "Дождитесь завершения индексации перед удалением"
    : "Удалить папку из RAG";
  deleteButton.addEventListener("click", () => deleteSource(source.id));
  actions.append(deleteButton);

  return actions;
}

function renderSettingsSourceActions(source = selectedSettingsSource()) {
  const container = $("#settings-source-actions");
  if (!container) return;

  const settingsOpen = !$("#settings-page")?.hidden;
  const sourcesTabActive = !$("#settings-panel-sources")?.hidden;
  const shouldShow = Boolean(settingsOpen && sourcesTabActive && !state.addingSource && source);
  container.innerHTML = "";
  container.hidden = !shouldShow;
  if (!shouldShow) return;

  const actions = createSelectedSourceActions(source, "settings-source-actions-inner");
  container.append(...Array.from(actions.childNodes));
}

function renderSelectedSourceSettings() {
  const container = $("#selected-source-settings");
  if (!container) return;

  const source = selectedSettingsSource();
  container.innerHTML = "";

  if (!source) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = "Выберите папку слева или добавьте папку в текущий RAG.";
    container.append(empty);
    return;
  }

  const status = source.indexStatus || { status: "not_indexed", message: "Не индексировалось" };
  const pipeline = document.createElement("div");
  pipeline.className = "selected-source-pipeline";
  pipeline.textContent = indexPipelineText(status);

  const stepLine = renderIndexPipeline(status);

  const blocks = [stepLine, renderSourceSummaryCard(source), pipeline, renderRecognitionQualityCard(source)];
  if (!isContractSource(source)) blocks.push(renderTenderLinkForm(source));
  container.append(...blocks);
}

function resetIndexedFilesState(sourceId = "") {
  state.indexedFiles = {
    sourceId,
    loading: false,
    loaded: false,
    error: "",
    total: 0,
    searchable: 0,
    chunks: 0,
    refreshedAt: 0,
    files: []
  };
}

function indexedFilePathParts(file) {
  const relativePath = String(file.relativePath || file.title || file.path || "").trim();
  const parts = relativePath.split(/[\\/]/).map((part) => part.trim()).filter(Boolean);
  return parts.length ? parts : [file.title || fileName(file.path)];
}

function buildIndexedFileTree(files = []) {
  const root = { name: "", key: "", folders: new Map(), files: [], fileCount: 0, chunkCount: 0 };

  for (const file of files) {
    const parts = indexedFilePathParts(file);
    const folderParts = parts.slice(0, -1);
    let node = root;
    node.fileCount += 1;
    node.chunkCount += Number(file.chunks || 0);

    folderParts.forEach((part, index) => {
      const key = folderParts.slice(0, index + 1).join("/");
      if (!node.folders.has(part)) {
        node.folders.set(part, { name: part, key, folders: new Map(), files: [], fileCount: 0, chunkCount: 0 });
      }
      node = node.folders.get(part);
      node.fileCount += 1;
      node.chunkCount += Number(file.chunks || 0);
    });

    node.files.push(file);
  }

  return root;
}

function sortedIndexedFolders(node) {
  return Array.from(node.folders.values()).sort((a, b) => a.name.localeCompare(b.name, "ru", { sensitivity: "base", numeric: true }));
}

function sortedIndexedFiles(node) {
  return [...node.files].sort((a, b) => (a.title || a.relativePath || "").localeCompare(b.title || b.relativePath || "", "ru", { sensitivity: "base", numeric: true }));
}

function indexedQualityStatus(file) {
  return file.quality?.status || (file.chunks ? "unchecked" : "error");
}

function indexedQualityLabel(file) {
  const status = indexedQualityStatus(file);
  if (!file.chunks) return "нет фрагментов";
  if (status === "ok") return `проверено ${file.quality?.score ?? 100}`;
  if (status === "warning") return `проверить ${file.quality?.score ?? ""}`.trim();
  if (status === "error") return "ошибка проверки";
  return "без проверки";
}

function indexedQualityMark(file) {
  const status = indexedQualityStatus(file);
  if (status === "ok") return "OK";
  if (status === "warning") return "!";
  if (status === "error") return "!";
  return "?";
}

const INDEXED_QUALITY_REASON_LABELS = {
  no_chunks: "файл не дал текстовых фрагментов",
  too_little_text: "слишком мало извлеченного текста",
  too_few_words: "слишком мало распознанных слов",
  low_text_density: "низкая доля читаемого текста",
  encoding_noise: "похоже на проблему кодировки",
  ocr_limited: "OCR обработал не все страницы из-за лимита",
  low_ocr_confidence: "низкая уверенность OCR",
  empty_pdf_text: "в PDF не найден извлекаемый текст"
};

Object.assign(INDEXED_QUALITY_REASON_LABELS, {
  low_ocr_page_confidence: "низкая уверенность OCR на отдельных страницах",
  empty_ocr_pages: "пустые или почти пустые OCR-страницы",
  pdf_text_layer_noise: "текстовый слой PDF выглядит зашумленным",
  ocr_text_noise: "OCR выдал зашумленный текст",
  ocr_rejected_pages: "часть OCR-страниц отбракована по качеству",
  no_usable_ocr_pages: "ни одна OCR-страница не прошла проверку качества",
  ocr_failed_pages: "OCR упал на отдельных страницах",
  ocr_page_failed: "OCR упал на этой странице",
  chunks_skipped_for_quality: "фрагменты не сохранены из-за низкого качества",
  conversion_error: "не удалось обработать файл",
  unsupported_google_context_link: "Google ссылка пока не поддерживается для индексации",
  unsupported_google_drive_file: "тип Google Drive файла пока не поддерживается",
  empty_google_context_export: "Google export не вернул текст",
  empty_google_drive_export: "Google Drive файл не дал текст",
  google_context_fetch_failed: "не удалось получить Google документ"
});

function indexedQualityReasons(file) {
  const reasons = [];
  if (!file.chunks) reasons.push("файл не попал в поиск: нет фрагментов");
  for (const warning of file.quality?.warnings || []) {
    reasons.push(INDEXED_QUALITY_REASON_LABELS[warning] || warning);
  }
  if (!reasons.length && indexedQualityStatus(file) === "error") reasons.push("проверка качества завершилась ошибкой");
  if (file.reindex?.retried) {
    const reindexReasons = Array.isArray(file.reindex.reasons) ? file.reindex.reasons.join(", ") : "";
    reasons.push(`reindex ${file.reindex.status || "done"}${reindexReasons ? `: ${reindexReasons}` : ""}`);
  }
  return [...new Set(reasons)];
}

function indexedQualityTooltip(file) {
  const reasons = indexedQualityReasons(file);
  const stats = [];
  if (Number.isFinite(Number(file.quality?.chars))) stats.push(`символов: ${file.quality.chars}`);
  if (Number.isFinite(Number(file.quality?.words))) stats.push(`слов: ${file.quality.words}`);
  if (Number.isFinite(Number(file.chunks))) stats.push(`фрагментов: ${file.chunks}`);

  const recognition = file.recognition || {};
  const details = [];
  if (recognition.errorMessage) details.push(`Ошибка: ${recognition.errorMessage}`);
  if (recognition.externalConverterError) details.push(`Конвертер: ${recognition.externalConverterError}`);
  for (const pageError of (recognition.ocrPageErrors || []).slice(0, 3)) {
    details.push(`OCR стр. ${pageError.page}: ${pageError.message}`);
  }

  return [
    file.relativePath || file.path,
    indexedQualityLabel(file),
    reasons.length ? `Причина: ${reasons.join("; ")}` : "",
    ...details,
    stats.length ? stats.join(", ") : ""
  ].filter(Boolean).join("\n");
}

function indexedFileSourceLabel(file) {
  if (!file?.sourceType && !file?.sourceTitle) return "";
  const label = sourceTypeLabel(file);
  return file.sourceTitle ? `${label}: ${file.sourceTitle}` : label;
}

function indexedFilesIndexingPhaseLabel(status = {}) {
  return {
    queued: "\u043e\u0436\u0438\u0434\u0430\u0435\u0442 \u0437\u0430\u043f\u0443\u0441\u043a\u0430",
    cleanup: "\u043e\u0447\u0438\u0441\u0442\u043a\u0430 \u0441\u0442\u0430\u0440\u043e\u0433\u043e \u0438\u043d\u0434\u0435\u043a\u0441\u0430",
    scan: "\u0441\u043a\u0430\u043d\u0438\u0440\u043e\u0432\u0430\u043d\u0438\u0435 \u0444\u0430\u0439\u043b\u043e\u0432",
    convert: "\u0438\u0437\u0432\u043b\u0435\u0447\u0435\u043d\u0438\u0435 \u0442\u0435\u043a\u0441\u0442\u0430",
    reindex: "\u043f\u043e\u0432\u0442\u043e\u0440\u043d\u0430\u044f \u043e\u0431\u0440\u0430\u0431\u043e\u0442\u043a\u0430",
    ocr: "OCR \u0440\u0430\u0441\u043f\u043e\u0437\u043d\u0430\u0432\u0430\u043d\u0438\u0435",
    index: "\u0441\u0431\u043e\u0440\u043a\u0430 \u0444\u0440\u0430\u0433\u043c\u0435\u043d\u0442\u043e\u0432",
    embed: "\u0432\u0435\u043a\u0442\u043e\u0440\u0438\u0437\u0430\u0446\u0438\u044f",
    vector_store: "\u0437\u0430\u043f\u0438\u0441\u044c \u0432 Qdrant"
  }[String(status.phase || "").toLowerCase()] || "\u0438\u043d\u0434\u0435\u043a\u0441\u0430\u0446\u0438\u044f";
}

function indexedFilesIndexingDetail(status = {}, visibleFiles = 0) {
  const parts = [indexedFilesIndexingPhaseLabel(status)];
  const progress = indexProgressText(status);
  if (progress) parts.push(progress);
  if (visibleFiles) parts.push(`\u0443\u0436\u0435 \u0432 \u0434\u0435\u0440\u0435\u0432\u0435: ${formatCount(visibleFiles)}`);
  return parts.join(" \u00b7 ");
}

function appendIndexedFilesIndexingBanner(container, status = {}, visibleFiles = 0) {
  const percent = jobProgressPercent(status);
  const banner = document.createElement("div");
  banner.className = "indexed-files-indexing";
  banner.classList.toggle("is-indeterminate", percent == null);
  banner.style.setProperty("--indexed-progress", percent == null ? "42%" : `${Math.round(percent)}%`);
  banner.innerHTML = `
    <span class="indexed-files-indexing-spinner" aria-hidden="true"></span>
    <span class="indexed-files-indexing-main">
      <span class="indexed-files-indexing-title"></span>
      <span class="indexed-files-indexing-detail"></span>
      <span class="indexed-files-indexing-track" aria-hidden="true"><span></span></span>
    </span>
    <span class="indexed-files-indexing-percent"></span>
  `;
  banner.querySelector(".indexed-files-indexing-title").textContent = status.force
    ? "\u041f\u043e\u043b\u043d\u0430\u044f \u043f\u0435\u0440\u0435\u0438\u043d\u0434\u0435\u043a\u0441\u0430\u0446\u0438\u044f \u0432 \u0440\u0430\u0431\u043e\u0442\u0435"
    : "\u0418\u043d\u0434\u0435\u043a\u0441\u0430\u0446\u0438\u044f \u0432 \u0440\u0430\u0431\u043e\u0442\u0435";
  banner.querySelector(".indexed-files-indexing-detail").textContent = indexedFilesIndexingDetail(status, visibleFiles);
  banner.querySelector(".indexed-files-indexing-percent").textContent = percent == null ? "..." : `${Math.round(percent)}%`;
  container.append(banner);
}

function appendIndexedFilesIndexingSkeleton(container, rows = 6) {
  const skeleton = document.createElement("div");
  skeleton.className = "indexed-files-indexing-skeleton";
  for (let index = 0; index < rows; index += 1) {
    const row = document.createElement("div");
    row.className = "indexed-files-indexing-skeleton-row";
    row.style.setProperty("--skeleton-delay", `${index * 90}ms`);
    skeleton.append(row);
  }
  container.append(skeleton);
}

function hideIndexedFileMenu() {
  indexedFileContextMenu?.remove();
  indexedFileContextMenu = null;
}

function indexedFileSystemActionLabel(action) {
  return action === "reveal" ? "Открыть в проводнике" : "Открыть оригинал";
}

async function runIndexedFileSystemAction(file, action) {
  hideIndexedFileMenu();
  const summary = $("#indexed-files-summary");
  try {
    await api("/api/files/system-open", {
      method: "POST",
      body: JSON.stringify({
        action,
        sourceId: file.sourceId || state.indexedFiles.sourceId,
        fileId: file.fileId || "",
        path: file.path || ""
      })
    });
    if (summary) summary.textContent = `${indexedFileSystemActionLabel(action)}: ${file.title || fileName(file.path)}`;
  } catch (error) {
    if (summary) {
      const fallback = action === "reveal"
        ? "Не удалось открыть файл в проводнике"
        : "Не удалось открыть оригинальный файл";
      summary.textContent = apiErrorMessage(error, fallback);
    }
  }
}

function placeIndexedFileMenu(menu, x, y) {
  const margin = 8;
  const rect = menu.getBoundingClientRect();
  const maxLeft = Math.max(margin, window.innerWidth - rect.width - margin);
  const maxTop = Math.max(margin, window.innerHeight - rect.height - margin);
  const left = Math.min(Math.max(margin, x), maxLeft);
  const top = Math.min(Math.max(margin, y), maxTop);
  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;
}

function showIndexedFileMenuAt(file, x, y) {
  hideIndexedFileMenu();

  const menu = document.createElement("div");
  menu.className = "indexed-file-context-menu";
  menu.setAttribute("role", "menu");

  const openButton = document.createElement("button");
  openButton.type = "button";
  openButton.setAttribute("role", "menuitem");
  openButton.textContent = indexedFileSystemActionLabel("open");
  openButton.addEventListener("click", () => runIndexedFileSystemAction(file, "open"));

  const revealButton = document.createElement("button");
  revealButton.type = "button";
  revealButton.setAttribute("role", "menuitem");
  revealButton.textContent = indexedFileSystemActionLabel("reveal");
  revealButton.addEventListener("click", () => runIndexedFileSystemAction(file, "reveal"));

  menu.append(openButton, revealButton);
  menu.addEventListener("click", (event) => event.stopPropagation());
  document.body.append(menu);
  indexedFileContextMenu = menu;
  placeIndexedFileMenu(menu, x, y);
  requestAnimationFrame(() => openButton.focus());
}

function showIndexedFileMenu(event, file) {
  event.preventDefault();
  event.stopPropagation();
  showIndexedFileMenuAt(file, event.clientX, event.clientY);
}

function hasOcrSignal(recognition = {}) {
  return Number(recognition.ocrTotalPages) > 0
    || Number(recognition.ocrPages) > 0
    || Array.isArray(recognition.ocrPageStats)
    || Number.isFinite(Number(recognition.ocrConfidence));
}

// Page counts must distinguish "recognized" from "accepted": a file where every page was OCR'd
// but rejected by the quality gate used to render as a healthy "OCR 30/30".
function ocrStatsLabel(recognition = {}) {
  const total = Number(recognition.ocrTotalPages) || Number(recognition.ocrPages) || 0;
  const raw = Number(recognition.ocrRawRecognizedPages);
  const accepted = Number(recognition.ocrAcceptedPages ?? recognition.ocrRecognizedPages);
  const parts = [];

  if (total) parts.push(`${total} стр.`);
  if (Number.isFinite(raw) && Number.isFinite(accepted) && raw !== accepted) {
    parts.push(`распознано ${raw}, принято ${accepted}`);
  } else if (Number.isFinite(accepted)) {
    parts.push(`принято ${accepted}`);
  }
  if (Number.isFinite(Number(recognition.ocrConfidence))) parts.push(`сред. ${Math.round(Number(recognition.ocrConfidence))}%`);
  if (Number.isFinite(Number(recognition.ocrConfidenceP10))) parts.push(`10% стр. до ${Math.round(Number(recognition.ocrConfidenceP10))}%`);

  const failed = Array.isArray(recognition.ocrFailedPages) ? recognition.ocrFailedPages.length : 0;
  if (failed) parts.push(`ошибок стр.: ${failed}`);

  const cachedPages = Number(recognition.ocrCachedPages);
  if (Number.isFinite(cachedPages) && cachedPages > 0) parts.push(`кэш ${cachedPages}`);
  if (recognition.pdfOcrMode && recognition.pdfOcrMode !== "auto") parts.push(recognition.pdfOcrMode);
  if (recognition.ocrLimited) parts.push("лимит");

  return parts.join(", ");
}

function indexedRecognitionLabel(file) {
  const recognition = file.recognition || {};
  if (["ocr", "ocr-cache", "ocrmypdf"].includes(recognition.method)) {
    const engine = recognition.method === "ocrmypdf" ? "OCRmyPDF" : "OCR";
    const stats = ocrStatsLabel(recognition);
    return stats ? `${engine} ${stats}` : engine;
  }
  if (recognition.method === "pdf-empty") {
    // The OCR diagnostics still exist here — showing "PDF пустой" alone hides why it is empty.
    const stats = hasOcrSignal(recognition) ? ocrStatsLabel(recognition) : "";
    return stats ? `PDF без текста · OCR ${stats}` : "PDF пустой";
  }
  if (recognition.method === "conversion-error") return "ошибка обработки";
  if (recognition.method === "pdf-text") return "PDF текст";
  if (recognition.method === "docling") return "Docling";
  if (recognition.method === "docx") return "DOCX";
  if (recognition.method === "xlsx") return "XLSX";
  if (recognition.method === "xlsm") return "XLSM";
  if (recognition.method === "xls") return "XLS";
  if (recognition.method === "text") return "текст";
  if (recognition.method === "google-doc") return "Google Doc";
  if (recognition.method === "google-sheet") return "Google Sheet";
  if (recognition.method === "google-context-error") return "Google context";
  if (String(recognition.method || "").startsWith("google-drive-")) return "Google Drive";
  return "";
}

function renderIndexedFolderChildren(node, container, depth = 0) {
  for (const folder of sortedIndexedFolders(node)) {
    const expanded = state.expandedIndexedFolders.has(folder.key);
    const row = document.createElement("button");
    row.type = "button";
    row.className = "indexed-tree-row indexed-tree-folder";
    row.style.setProperty("--depth", depth);
    row.innerHTML = `
      <span class="indexed-tree-toggle"></span>
      <span class="indexed-tree-name"></span>
      <span class="indexed-tree-count"></span>
    `;
    row.querySelector(".indexed-tree-toggle").textContent = expanded ? "-" : "+";
    row.querySelector(".indexed-tree-name").textContent = folder.name;
    row.querySelector(".indexed-tree-count").textContent = `${folder.fileCount}`;
    row.addEventListener("click", () => {
      if (expanded) {
        state.expandedIndexedFolders.delete(folder.key);
      } else {
        state.expandedIndexedFolders.add(folder.key);
      }
      renderIndexedFilesPanel();
    });
    container.append(row);

    if (expanded) renderIndexedFolderChildren(folder, container, depth + 1);
  }

  for (const file of sortedIndexedFiles(node)) {
    const row = document.createElement("button");
    row.type = "button";
    row.className = "indexed-tree-row indexed-tree-file";
    row.classList.toggle("is-empty", !file.chunks);
    row.classList.toggle("has-quality-ok", indexedQualityStatus(file) === "ok");
    row.classList.toggle("has-quality-warning", indexedQualityStatus(file) === "warning");
    row.classList.toggle("has-quality-error", indexedQualityStatus(file) === "error");
    row.style.setProperty("--depth", depth);
    row.innerHTML = `
      <span class="indexed-tree-file-dot"></span>
      <span class="indexed-tree-file-icon" aria-hidden="true"></span>
      <span class="indexed-tree-file-main">
        <span class="indexed-tree-name-line">
          <span class="indexed-tree-name"></span>
          <span class="indexed-tree-source-chip"></span>
        </span>
        <span class="indexed-tree-meta"></span>
      </span>
      <span class="indexed-tree-quality"></span>
    `;
    row.querySelector(".indexed-tree-file-icon").textContent = auditFileIcon(
      file.extension || auditFileExtensionFromName(file.title || file.path)
    );
    const meta = [
      file.chunks ? `${file.chunks} фрагм.` : "нет фрагментов",
      indexedRecognitionLabel(file),
      indexedQualityLabel(file),
      formatFileSize(file.size),
      shortDateTime(file.indexedAt)
    ].filter(Boolean).join(" · ");
    row.querySelector(".indexed-tree-name").textContent = file.title || fileName(file.path);
    const sourceChip = row.querySelector(".indexed-tree-source-chip");
    const sourceLabel = indexedFileSourceLabel(file);
    sourceChip.textContent = sourceLabel;
    sourceChip.hidden = !sourceLabel;
    sourceChip.title = file.sourcePath || file.sourceTitle || "";
    row.querySelector(".indexed-tree-meta").textContent = meta;
    const qualityMark = row.querySelector(".indexed-tree-quality");
    const qualityTooltip = indexedQualityTooltip(file);
    qualityMark.textContent = indexedQualityMark(file);
    qualityMark.title = qualityTooltip;
    qualityMark.setAttribute("aria-label", qualityTooltip);
    row.title = qualityTooltip;
    row.addEventListener("click", () => openSourcePreview(file));
    row.addEventListener("contextmenu", (event) => showIndexedFileMenu(event, file));
    row.addEventListener("keydown", (event) => {
      if (event.key !== "ContextMenu" && !(event.shiftKey && event.key === "F10")) return;
      event.preventDefault();
      const rect = row.getBoundingClientRect();
      showIndexedFileMenuAt(file, rect.left + 24, rect.top + 24);
    });
    container.append(row);
  }
}

function renderIndexedFilesPanel() {
  const summary = $("#indexed-files-summary");
  const tree = $("#indexed-files-tree");
  if (!summary || !tree) return;

  const source = selectedSettingsSource();
  hideIndexedFileMenu();
  tree.innerHTML = "";

  if (!source) {
    summary.textContent = "";
    tree.classList.remove("is-indexing");
    tree.innerHTML = '<div class="empty">Выберите папку слева, чтобы увидеть файлы индекса.</div>';
    return;
  }

  const current = state.indexedFiles;
  const status = source.indexStatus || {};
  const indexing = status.status === "running";
  tree.classList.toggle("is-indexing", indexing);
  if (current.sourceId !== source.id) {
    if (indexing) {
      summary.textContent = `\u0418\u043d\u0434\u0435\u043a\u0441\u0438\u0440\u0443\u0435\u0442\u0441\u044f \u00b7 ${indexedFilesIndexingDetail(status)}`;
      appendIndexedFilesIndexingBanner(tree, status);
      appendIndexedFilesIndexingSkeleton(tree);
      return;
    }
    summary.textContent = "Загружаю список файлов...";
    tree.innerHTML = '<div class="empty">Читаю текущий индекс папки.</div>';
    return;
  }

  if (current.loading) {
    const files = current.files || [];
    if (indexing && files.length) {
      const chunks = current.chunks || files.reduce((sum, file) => sum + Number(file.chunks || 0), 0);
      const searchable = current.searchable ?? files.filter((file) => Number(file.chunks || 0) > 0).length;
      summary.textContent = `\u0418\u043d\u0434\u0435\u043a\u0441\u0438\u0440\u0443\u0435\u0442\u0441\u044f \u00b7 ${indexedFilesIndexingDetail(status, files.length)} \u00b7 ${formatCount(searchable)} \u0441 \u0444\u0440\u0430\u0433\u043c\u0435\u043d\u0442\u0430\u043c\u0438 \u00b7 ${formatCount(chunks)} \u0444\u0440\u0430\u0433\u043c\u0435\u043d\u0442\u043e\u0432`;
      appendIndexedFilesIndexingBanner(tree, status, files.length);
      renderIndexedFolderChildren(buildIndexedFileTree(files), tree, 0);
      return;
    }
    if (indexing) {
      summary.textContent = `\u0418\u043d\u0434\u0435\u043a\u0441\u0438\u0440\u0443\u0435\u0442\u0441\u044f \u00b7 ${indexedFilesIndexingDetail(status)}`;
      appendIndexedFilesIndexingBanner(tree, status);
      appendIndexedFilesIndexingSkeleton(tree);
      return;
    }
    if (files.length) {
      const chunks = current.chunks || files.reduce((sum, file) => sum + Number(file.chunks || 0), 0);
      const searchable = current.searchable ?? files.filter((file) => Number(file.chunks || 0) > 0).length;
      summary.textContent = `Обновляю дерево · сейчас доступно: ${files.length} файлов · ${searchable} с фрагментами · ${chunks} фрагментов`;
      renderIndexedFolderChildren(buildIndexedFileTree(files), tree, 0);
      return;
    }

    summary.textContent = "Загружаю список файлов...";
    tree.innerHTML = '<div class="empty">Читаю текущий индекс папки.</div>';
    return;
  }

  if (current.error) {
    summary.textContent = "Не удалось загрузить список.";
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = current.error;
    tree.append(empty);
    return;
  }

  const files = current.files || [];
  const progress = indexProgressText(status);

  if (!files.length) {
    if (indexing) {
      summary.textContent = `\u0418\u043d\u0434\u0435\u043a\u0441\u0438\u0440\u0443\u0435\u0442\u0441\u044f${progress ? ` ${progress}` : ""}. \u0413\u043e\u0442\u043e\u0432\u044b\u0445 \u0444\u0430\u0439\u043b\u043e\u0432 \u0432 \u0438\u043d\u0434\u0435\u043a\u0441\u0435 \u043f\u043e\u043a\u0430 \u043d\u0435\u0442.`;
      appendIndexedFilesIndexingBanner(tree, status);
      appendIndexedFilesIndexingSkeleton(tree);
      return;
    }
    if (indexing) {
      summary.textContent = `Индексируется${progress ? ` ${progress}` : ""}. Готовых файлов в индексе пока нет.`;
      tree.innerHTML = '<div class="empty">Идет распознавание первых документов. Запускать индексацию повторно не нужно.</div>';
    } else if (status.status === "failed") {
      summary.textContent = "Индекс не готов: последняя индексация завершилась ошибкой.";
      tree.innerHTML = '<div class="empty">Проверьте ошибку индексации слева и запустите обработку заново.</div>';
    } else {
      summary.textContent = "Индекс еще не создан.";
      tree.innerHTML = '<div class="empty">Запустите агента в шапке или дождитесь плановой индексации.</div>';
    }
    return;
  }

  const chunks = current.chunks || files.reduce((sum, file) => sum + Number(file.chunks || 0), 0);
  const searchable = current.searchable ?? files.filter((file) => Number(file.chunks || 0) > 0).length;
  const indexedSummary = `${files.length} файлов · ${searchable} с фрагментами · ${chunks} фрагментов`;
  summary.textContent = indexing
    ? `Индексируется${progress ? ` ${progress}` : ""} · уже доступно: ${indexedSummary}`
    : indexedSummary;
  if (indexing) appendIndexedFilesIndexingBanner(tree, status, files.length);
  renderIndexedFolderChildren(buildIndexedFileTree(files), tree, 0);
}

async function loadIndexedFiles(sourceId, options = {}) {
  if (!sourceId) {
    resetIndexedFilesState();
    renderIndexedFilesPanel();
    return;
  }

  if (!options.force && state.indexedFiles.sourceId === sourceId && (state.indexedFiles.loading || state.indexedFiles.loaded)) {
    return;
  }

  const previous = state.indexedFiles.sourceId === sourceId ? state.indexedFiles : null;
  const keepPrevious = Boolean(options.silent && previous);
  state.indexedFiles = {
    sourceId,
    loading: true,
    loaded: keepPrevious ? previous.loaded : false,
    error: "",
    total: keepPrevious ? previous.total : 0,
    searchable: keepPrevious ? previous.searchable : 0,
    chunks: keepPrevious ? previous.chunks : 0,
    refreshedAt: Date.now(),
    files: keepPrevious ? previous.files : []
  };
  if (!options.silent) renderIndexedFilesPanel();

  try {
    const payload = await api(`/api/sources/${encodeURIComponent(sourceId)}/indexed-files`);
    if (state.indexedFiles.sourceId !== sourceId) return;
    const files = payload.files || [];
    state.indexedFiles = {
      sourceId,
      loading: false,
      loaded: true,
      error: "",
      total: payload.total || files.length,
      searchable: payload.searchable ?? files.filter((file) => Number(file.chunks || 0) > 0).length,
      chunks: payload.chunks || 0,
      refreshedAt: Date.now(),
      files
    };
    if (syncSourceStatusFromIndexedFiles(sourceId, state.indexedFiles)) renderSources();
    const expanded = new Set([""]);
    for (const file of files) {
      const firstFolder = indexedFilePathParts(file).slice(0, -1)[0];
      if (firstFolder) expanded.add(firstFolder);
    }
    state.expandedIndexedFolders = expanded;
  } catch (error) {
    if (state.indexedFiles.sourceId !== sourceId) return;
    state.indexedFiles = {
      sourceId,
      loading: false,
      loaded: false,
      error: apiErrorMessage(error, "Не удалось загрузить список индексированных файлов"),
      total: 0,
      searchable: 0,
      chunks: 0,
      refreshedAt: Date.now(),
      files: []
    };
  }

  renderIndexedFilesPanel();
}

function ensureIndexedFilesLoaded(sourceId) {
  if (!sourceId) return;
  const current = state.indexedFiles;
  if (current.sourceId === sourceId && (current.loading || current.loaded || current.error)) return;
  loadIndexedFiles(sourceId);
}

function renderSources() {
  const list = $("#sources");
  const select = $("#source-select");

  list.innerHTML = "";
  select.innerHTML = "";
  const settingsOpen = !$("#settings-page")?.hidden;
  const addingSource = settingsOpen && state.addingSource;
  if (addingSource) clearSourceTitleEditing();
  if (settingsOpen && !addingSource) ensureSettingsSourceVisibleInTab();
  const settingsSource = settingsOpen && !addingSource ? selectedSettingsSource() : null;
  const hasSettingsSource = Boolean(settingsSource);
  const sourceDetailEmpty = settingsOpen && !addingSource && !hasSettingsSource;
  const activeListSourceId = settingsOpen ? (addingSource ? "" : state.settingsSourceId) : state.selectedSourceId;

  $("#settings-project-detail")?.classList.toggle("adding-source", addingSource);
  $("#settings-project-detail")?.classList.toggle("source-detail-empty", sourceDetailEmpty);
  const selectedSourcePanel = $("#selected-source-panel");
  const sourcePathsPanel = $("#source-paths-panel");
  const indexedFilesPanel = $("#indexed-files-panel");
  const newSourcePanel = $("#new-source-panel");
  if (selectedSourcePanel) selectedSourcePanel.hidden = addingSource || !hasSettingsSource;
  if (sourcePathsPanel) sourcePathsPanel.hidden = addingSource || !hasSettingsSource;
  if (indexedFilesPanel) indexedFilesPanel.hidden = addingSource || !hasSettingsSource;
  if (newSourcePanel) newSourcePanel.hidden = !addingSource;
  newSourcePanel?.classList.toggle("add-source-mode", addingSource);
  $("#source-add-shortcut")?.classList.toggle("active", addingSource);
  $("#source-add-shortcut")?.setAttribute("aria-pressed", String(addingSource));
  if (addingSource && state.sourceSelectionMode) {
    state.sourceSelectionMode = false;
    state.selectedSourceIds.clear();
  }
  syncSelectedSourceIdsWithSources();
  renderSourceSelectionControls();
  syncSourceListTabs();
  syncNewSourceFormText();

  const emptyOption = document.createElement("option");
  emptyOption.value = "";
  emptyOption.textContent = "Авто: определить по вопросу";
  select.append(emptyOption);

  const visibleSources = settingsOpen ? sourceListTabSources() : state.sources;

  for (const source of visibleSources) {
    const editingTitle = settingsOpen && !state.sourceSelectionMode && isSourceTitleEditing(source);
    const item = document.createElement("div");
    item.className = `source ${source.id === activeListSourceId ? "active" : ""} ${state.sourceSelectionMode ? "selection-mode" : ""} ${editingTitle ? "editing-title" : ""}`;
    item.dataset.sourceId = source.id;
    if (editingTitle) {
      const form = document.createElement("form");
      form.className = "source-title-edit-form";
      form.innerHTML = `
        <span class="source-index-dot" aria-hidden="true"></span>
        <input class="source-title-edit-input" type="text" autocomplete="off">
        <button type="submit" class="icon-button compact-icon-button" title="Сохранить наименование" aria-label="Сохранить наименование">✓</button>
        <button type="button" class="secondary icon-button compact-icon-button source-title-edit-cancel" title="Отменить" aria-label="Отменить">×</button>
        <span class="source-title-edit-status" aria-live="polite"></span>
      `;
      const dot = form.querySelector(".source-index-dot");
      dot.classList.add(sourceIndexDotClass(source.indexStatus));
      dot.title = sourceIndexDotTitle(source.indexStatus);
      const input = form.querySelector(".source-title-edit-input");
      input.value = source.title || "";
      input.dataset.sourceId = source.id;
      form.querySelector(".source-title-edit-cancel").addEventListener("click", () => setSourceTitleEditing(false));
      form.addEventListener("submit", (event) => {
        event.preventDefault();
        saveSourceTitle(source.id, input.value, form.querySelector(".source-title-edit-status"));
      });
      item.append(form);
      list.append(item);
      if (isContractSource(source)) {
        const option = document.createElement("option");
        option.value = source.id;
        option.textContent = source.title;
        select.append(option);
      }
      continue;
    }

    item.innerHTML = `
      ${state.sourceSelectionMode ? '<label class="source-checkbox-wrap"><input type="checkbox" class="source-checkbox"><span aria-hidden="true"></span></label>' : ""}
      <button type="button" class="source-select"></button>
    `;
    const selectButton = item.querySelector(".source-select");
    selectButton.innerHTML = `
      <span class="source-index-dot" aria-hidden="true"></span>
      <span class="source-title"></span>
      <span class="source-path"></span>
      <span class="source-index-status"></span>
    `;
    selectButton.setAttribute("aria-label", `Выбрать папку RAG ${source.title}`);
    const dot = selectButton.querySelector(".source-index-dot");
    dot.classList.add(sourceIndexDotClass(source.indexStatus));
    dot.title = sourceIndexDotTitle(source.indexStatus);
    const titleNode = selectButton.querySelector(".source-title");
    titleNode.textContent = source.title;
    const chip = document.createElement("span");
    chip.className = isContractSource(source)
      ? "source-kind-chip source-kind-chip--contract"
      : "source-kind-chip source-kind-chip--tender";
    chip.textContent = sourceTypeLabel(source);
    titleNode.append(" ", chip);
    selectButton.querySelector(".source-path").textContent = source.path;
    selectButton.querySelector(".source-index-status").textContent = formatIndexSummary(source.indexStatus);
    const checkbox = item.querySelector(".source-checkbox");
    if (checkbox) {
      checkbox.checked = state.selectedSourceIds.has(source.id);
      checkbox.disabled = state.deletingSourceIds.has(source.id);
      checkbox.setAttribute("aria-label", `Выбрать папку RAG ${source.title}`);
      checkbox.addEventListener("change", () => toggleSourceSelection(source.id, checkbox.checked));
    }
    selectButton.addEventListener("click", () => {
      if (state.sourceSelectionMode) {
        toggleSourceSelection(source.id);
        return;
      }
      if (settingsOpen) {
        state.addingSource = false;
        if (state.settingsSourceId !== source.id) clearSourceTitleEditing();
        state.settingsSourceId = source.id;
        if (state.indexedFiles.sourceId !== source.id) state.expandedIndexedFolders = new Set([""]);
      } else {
        state.selectedSourceId = source.id;
      }
      renderSources();
    });
    if (settingsOpen && !state.sourceSelectionMode && source.id === activeListSourceId) {
      const editButton = document.createElement("button");
      editButton.type = "button";
      editButton.className = "secondary icon-button compact-icon-button source-title-edit-button";
      editButton.textContent = "✎";
      editButton.title = "Изменить наименование";
      editButton.setAttribute("aria-label", `Изменить наименование папки ${source.title}`);
      editButton.addEventListener("click", () => {
        state.addingSource = false;
        state.settingsSourceId = source.id;
        setSourceTitleEditing(true, source.id);
      });
      item.append(editButton);
    }
    list.append(item);

    if (!isContractSource(source)) continue;

    const option = document.createElement("option");
    option.value = source.id;
    option.textContent = source.title;
    select.append(option);
  }

  if (state.sources.length === 0) {
    list.innerHTML = '<div class="empty">Добавьте первую папку в текущий RAG.</div>';
  } else if (settingsOpen && visibleSources.length === 0) {
    list.innerHTML = state.sourceListTab === "tender"
      ? '<div class="empty">Тендеров пока нет. Запустите синхронизацию с Google Drive.</div>'
      : '<div class="empty">Договоров пока нет. Добавьте папку договора в RAG.</div>';
  } else if (contractSourcesForUi().length === 0) {
    const option = document.createElement("option");
    option.value = "";
    option.textContent = "Нет договоров — только тендеры";
    select.append(option);
  }

  if (state.selectedSourceId && !contractSourcesForUi().some((source) => source.id === state.selectedSourceId)) {
    state.selectedSourceId = "";
  }

  select.value = state.selectedSourceId;
  select.disabled = state.sources.length === 0;
  updateProjectIndexUi();
  renderSelectedSourceSettings();
  renderSettingsSourceActions(settingsSource);
  renderSourcePathsPanel(settingsSource);
  renderIndexedFilesPanel();
  if (settingsOpen && !addingSource && settingsSource) ensureIndexedFilesLoaded(settingsSource.id);
  renderChatHistory();
  renderAuditPanel();
}

async function loadSources() {
  const previousSettingsSourceId = state.settingsSourceId;
  state.sources = await api("/api/sources");
  syncSelectedSourceIdsWithSources();
  if (!state.sources.some((source) => source.id === state.selectedSourceId)) {
    state.selectedSourceId = "";
  }
  if (!state.sources.some((source) => source.id === state.settingsSourceId)) {
    state.settingsSourceId = contractSourcesForUi()[0]?.id || state.sources[0]?.id || "";
  }
  const settingsSource = sourceById(state.settingsSourceId);
  if (settingsSource) state.sourceListTab = sourceListTabForSource(settingsSource);
  if (previousSettingsSourceId !== state.settingsSourceId) clearSourceTitleEditing();
  renderSources();
}

function skippedReasonLabel(reason) {
  return {
    unsupported: "Неподдерживаемый тип",
    temporary: "Временный файл",
    excluded: "Исключен правилом"
  }[reason] || reason || "Пропущено";
}

function renderSkippedFiles() {
  const summary = $("#skipped-summary");
  const list = $("#skipped-files");
  const subtitle = $("#skipped-modal-subtitle");
  const forceButton = $("#force-reindex-button");
  const source = skippedModalSource();
  const indexStatus = source?.indexStatus || { status: "not_indexed" };
  summary.innerHTML = "";
  list.innerHTML = "";
  subtitle.textContent = source?.title || "Файлы выбранной папки";
  forceButton.disabled = !source || indexStatus.status === "running";

  if (!source) {
    summary.innerHTML = '<div class="empty">Выберите папку.</div>';
    return;
  }

  if (state.skippedLoading) {
    summary.innerHTML = '<div class="empty">Сканирую пропущенные файлы...</div>';
    return;
  }

  const payload = state.skipped;
  if (!payload) {
    summary.innerHTML = '<div class="empty">Откройте модалку еще раз, чтобы загрузить список.</div>';
    return;
  }

  const skipped = payload.skippedFiles || [];
  const unsupportedByExt = Object.entries(payload.unsupportedByExt || {})
    .filter(([, count]) => count > 0)
    .sort((a, b) => b[1] - a[1])
    .map(([ext, count]) => `${ext} ${count}`);

  const summaryParts = [
    `Пропущено ${payload.skippedTotal || skipped.length}`,
    `к индексации ${payload.eligibleTotal || 0}`
  ];
  if (unsupportedByExt.length) summaryParts.push(unsupportedByExt.join(", "));
  if (payload.temporaryFiles) summaryParts.push(`временные ${payload.temporaryFiles}`);
  if (payload.excludedFiles) summaryParts.push(`исключенные ${payload.excludedFiles}`);
  summary.textContent = summaryParts.join("; ");

  if (!skipped.length) {
    list.innerHTML = '<div class="empty">Пропущенных файлов нет.</div>';
    return;
  }

  for (const file of skipped) {
    const item = document.createElement("article");
    item.className = "skipped-file";
    item.innerHTML = `
      <div class="skipped-file-title"></div>
      <div class="skipped-file-meta"></div>
      <div class="skipped-file-path"></div>
    `;
    item.querySelector(".skipped-file-title").textContent = file.title || file.relativePath || file.path;
    item.querySelector(".skipped-file-meta").textContent = `${skippedReasonLabel(file.reason)} · ${file.extension || ""}`;
    item.querySelector(".skipped-file-path").textContent = file.relativePath || file.path;
    list.append(item);
  }
}

async function loadSkippedFiles() {
  const sourceId = state.skippedSourceId || state.selectedSourceId;
  if (!sourceId) {
    state.skipped = null;
    renderSkippedFiles();
    return;
  }

  state.skippedLoading = true;
  renderSkippedFiles();

  try {
    state.skipped = await api(`/api/sources/${encodeURIComponent(sourceId)}/skipped`);
    const source = sourceById(sourceId);
    if (source) {
      source.indexStatus = {
        ...(source.indexStatus || {}),
        skippedTotal: state.skipped.skippedTotal || 0,
        unsupportedFiles: state.skipped.unsupportedFiles || 0,
        temporaryFiles: state.skipped.temporaryFiles || 0,
        excludedFiles: state.skipped.excludedFiles || 0,
        totalFiles: state.skipped.totalFiles || source.indexStatus?.totalFiles || 0,
        eligibleFiles: state.skipped.eligibleTotal || source.indexStatus?.eligibleFiles || 0,
        unsupportedByExt: state.skipped.unsupportedByExt || {}
      };
      updateProjectIndexUi();
      renderSources();
    }
  } catch (error) {
    state.skipped = {
      skippedFiles: [],
      skippedTotal: 0,
      eligibleTotal: 0,
      scanError: error.message
    };
    $("#skipped-summary").innerHTML = `<div class="error">${error.message}</div>`;
    return;
  } finally {
    state.skippedLoading = false;
  }

  renderSkippedFiles();
}

function openSkippedModal(sourceId = "") {
  state.skippedSourceId = sourceId || state.selectedSourceId;
  $("#skipped-modal").hidden = false;
  loadSkippedFiles();
}

function closeSkippedModal() {
  $("#skipped-modal").hidden = true;
  state.skippedSourceId = "";
}

async function loadSettings() {
  const settings = await api("/api/settings");
  state.storagePath = settings.dataDir;
  state.storageEnvLocked = Boolean(settings.envLocked);
  state.llm = settings.llm || {};
  state.embeddings = settings.embeddings || {};
  state.vectorStore = settings.vectorStore || {};
  state.reranker = settings.reranker || {};
  const remoteLlm = state.llm.remote || {};
  const qdrant = state.vectorStore.qdrant || {};
  const reranker = state.reranker || {};
  $("#storage-path").value = settings.dataDir;
  $("#llm-enabled").checked = Boolean(state.llm.enabled);
  $("#llm-provider").value = state.llm.provider || "local";
  syncLlmRouteCards();
  $("#llm-base-url").value = state.llm.baseUrl || "http://127.0.0.1:1234/v1";
  setSelectOptions("#llm-model", state.llm.model ? [state.llm.model] : [], state.llm.model || "", "Локальные модели не загружены");
  $("#remote-context-enabled").checked = Boolean(remoteLlm.enabled || state.llm.allowRemoteContext);
  $("#remote-fallback-local").checked = Boolean(state.llm.fallbackToLocalOnRemoteError);
  $("#remote-llm-base-url").value = remoteLlm.baseUrl || REMOTE_LM_DEFAULT_BASE_URL;
  $("#remote-llm-runtime").value = remoteLlm.runtime || "lmstudio";
  syncLlmSecretPlaceholder();
  setSelectOptions("#remote-llm-model", [remoteLlm.model || REMOTE_LM_DEFAULT_MODEL], remoteLlm.model || REMOTE_LM_DEFAULT_MODEL, "Удаленные модели не загружены");
  setSelectOptions("#embedding-model", state.embeddings.model ? [state.embeddings.model] : [], state.embeddings.model || "text-embedding-bge-m3", "Embeddings не загружены");
  $("#vector-store-enabled").checked = state.vectorStore.enabled !== false;
  $("#vector-store-provider").value = state.vectorStore.provider || "auto";
  $("#qdrant-distance").value = qdrant.distance || "Cosine";
  $("#qdrant-url").value = qdrant.url || "http://127.0.0.1:6333";
  $("#qdrant-collection").value = qdrant.collection || "localai_chunks";
  $("#qdrant-batch-size").value = qdrant.batchSize || 128;
  syncVectorStoreSecretPlaceholder();
  updateQdrantApiKeyHint();
  $("#reranker-enabled").checked = Boolean(reranker.enabled);
  $("#reranker-url").value = reranker.baseUrl || "";
  $("#reranker-model").value = reranker.model || "jina-reranker-v2-base-multilingual";
  $("#reranker-candidates").value = reranker.candidateCount || 30;
  $("#reranker-max-chars").value = reranker.maxChars || 4000;
  $("#reranker-timeout").value = reranker.timeoutSeconds || 30;
  syncRerankerSecretPlaceholder();
  updateRerankerApiKeyHint();
  syncStorageFormLock();
  setText("#settings-status", "");
  syncRemoteContextWarning();
  renderAutoRoute();
  syncLlmFormLock();
  syncIndexFormLocks();
  refreshLmStudioStatus();
  refreshRemoteDiagnostics();
  refreshIntegrationsStatus();
  refreshDifyStatus({ silent: true });
  refreshLmUsage();
}

function syncStorageFormLock() {
  $("#storage-path").readOnly = state.storageEnvLocked;
  $("#choose-storage-folder").disabled = state.storageEnvLocked;
  $("#storage-save-button").disabled = state.storageEnvLocked;
  const lockTitle = state.storageEnvLocked ? "Путь задан переменной RAG_DATA_DIR" : "";
  $("#storage-path").title = lockTitle;
  $("#choose-storage-folder").title = lockTitle;
  $("#storage-save-button").title = lockTitle;
}

async function pickSourceFolder() {
  if (!$("#settings-page")?.hidden && !state.addingSource) {
    state.addingSource = true;
    state.settingsSourceId = "";
    clearSourceTitleEditing();
    renderSources();
  }
  setText("#settings-status", "");
  setText("#job-status", "Открываю проводник для выбора папки RAG...");
  const selected = await chooseFolder({
    title: "Выберите папку для текущего RAG",
    initialPath: $("#source-path").value.trim() || state.selectedSourcePath
  });
  if (!selected) {
    setText("#job-status", "");
    return;
  }

  state.selectedSourcePath = selected;
  $("#source-path").value = selected;
  setText("#job-status", "");
}

async function pickStorageFolder() {
  if (state.storageEnvLocked) {
    setText("#settings-status", "Хранилище задано переменной RAG_DATA_DIR.");
    return;
  }
  setText("#settings-status", "Открываю проводник для выбора хранилища...");
  const selected = await chooseFolder({
    title: "Выберите папку для хранения индексов и Markdown",
    initialPath: $("#storage-path").value.trim() || state.storagePath
  });
  if (!selected) {
    setText("#settings-status", "");
    return;
  }
  state.storagePath = selected;
  $("#storage-path").value = selected;
  setText("#settings-status", "Нажмите «Сохранить», чтобы применить путь.");
}

function focusNewSourceForm() {
  state.addingSource = true;
  state.settingsSourceId = "";
  clearSourceTitleEditing();
  state.selectedSourcePath = "";
  state.sourceSelectionMode = false;
  state.selectedSourceIds.clear();
  $("#source-title").value = "";
  $("#source-path").value = "";
  setText("#job-status", "");
  renderSources();
  requestAnimationFrame(() => {
    $("#new-source-panel")?.scrollIntoView({ block: "start", behavior: "smooth" });
    $("#source-path")?.focus();
  });
}

function syncSourcePathInput() {
  if (!$("#settings-page")?.hidden && !state.addingSource) {
    state.addingSource = true;
    state.settingsSourceId = "";
    clearSourceTitleEditing();
    renderSources();
  }
  const sourcePath = $("#source-path").value.trim();
  state.selectedSourcePath = sourcePath;
}

function syncStoragePathInput() {
  if (state.storageEnvLocked) return;
  state.storagePath = $("#storage-path").value.trim();
  setText("#settings-status", "Нажмите «Сохранить», чтобы применить путь.");
}

async function saveSettings(event) {
  event.preventDefault();
  if (state.storageEnvLocked) {
    setText("#settings-status", "Хранилище задано переменной RAG_DATA_DIR.");
    return;
  }
  const dataDir = $("#storage-path").value.trim();
  if (!dataDir) return;

  const settings = await api("/api/settings", {
    method: "PUT",
    body: JSON.stringify({ dataDir })
  });
  state.storagePath = settings.dataDir;
  $("#storage-path").value = settings.dataDir;
  setText("#settings-status", "Хранилище обновлено.");
}

function readLlmForm() {
  const remoteLlm = state.llm.remote || {};
  const remoteToken = $("#remote-llm-token").value.trim();
  const remote = {
    enabled: $("#remote-context-enabled")?.checked ?? false,
    baseUrl: $("#remote-llm-base-url").value.trim() || REMOTE_LM_DEFAULT_BASE_URL,
    runtime: $("#remote-llm-runtime")?.value || remoteLlm.runtime || "lmstudio",
    model: $("#remote-llm-model").value.trim() || REMOTE_LM_DEFAULT_MODEL,
    timeoutSeconds: Math.max(REMOTE_AUTO_TIMEOUT_SECONDS, Number(remoteLlm.timeoutSeconds || state.llm.timeoutSeconds || 120))
  };
  if (remoteToken) remote.apiKey = remoteToken;

  const llm = {
    enabled: $("#llm-enabled").checked,
    provider: $("#llm-provider")?.value || state.llm.provider || "local",
    fallbackToLocalOnRemoteError: $("#remote-fallback-local")?.checked ?? false,
    allowRemoteContext: remote.enabled,
    baseUrl: $("#llm-base-url").value.trim() || "http://127.0.0.1:1234/v1",
    model: $("#llm-model").value.trim(),
    temperature: Number(state.llm.temperature ?? 0.1),
    maxTokens: Number(state.llm.maxTokens ?? 700),
    timeoutSeconds: state.llm.timeoutSeconds || 120,
    remote
  };
  if (state.llm.apiKey) llm.apiKey = state.llm.apiKey;

  return llm;
}

function readEmbeddingForm() {
  const embeddings = {
    enabled: state.embeddings.enabled !== false,
    baseUrl: $("#llm-base-url").value.trim() || "http://127.0.0.1:1234/v1",
    model: $("#embedding-model").value.trim() || "text-embedding-bge-m3",
    batchSize: Number(state.embeddings.batchSize || 16),
    timeoutSeconds: state.embeddings.timeoutSeconds || 120
  };
  const apiKey = state.embeddings.apiKey || state.llm.apiKey;
  if (apiKey) embeddings.apiKey = apiKey;
  return embeddings;
}

function readVectorStoreForm() {
  const qdrantApiKey = $("#qdrant-api-key").value.trim();
  const qdrant = {
    url: $("#qdrant-url").value.trim() || "http://127.0.0.1:6333",
    collection: $("#qdrant-collection").value.trim() || "localai_chunks",
    distance: $("#qdrant-distance").value || "Cosine",
    batchSize: Number($("#qdrant-batch-size").value || state.vectorStore.qdrant?.batchSize || 128)
  };
  if (qdrantApiKey) qdrant.apiKey = qdrantApiKey;

  return {
    enabled: $("#vector-store-enabled").checked,
    provider: $("#vector-store-provider").value || "auto",
    qdrant
  };
}

function readRerankerForm() {
  const apiKey = $("#reranker-api-key").value.trim();
  const reranker = {
    enabled: $("#reranker-enabled").checked,
    baseUrl: $("#reranker-url").value.trim().replace(/\/$/, ""),
    model: $("#reranker-model").value.trim() || "jina-reranker-v2-base-multilingual",
    candidateCount: Number($("#reranker-candidates").value || state.reranker.candidateCount || 30),
    maxChars: Number($("#reranker-max-chars").value || state.reranker.maxChars || 4000),
    timeoutSeconds: Number($("#reranker-timeout").value || state.reranker.timeoutSeconds || 30)
  };
  if (apiKey) reranker.apiKey = apiKey;
  return reranker;
}

function isLocalQdrantUrl(value = "") {
  try {
    const hostname = new URL(value || "http://127.0.0.1:6333").hostname.toLowerCase();
    return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
  } catch {
    return true;
  }
}

function updateQdrantApiKeyHint() {
  const details = $("#qdrant-api-key-details");
  if (!details) return;

  const qdrant = state.vectorStore.qdrant || {};
  const url = $("#qdrant-url")?.value || qdrant.url || "http://127.0.0.1:6333";
  const isLocal = isLocalQdrantUrl(url);
  details.open = Boolean(qdrant.hasApiKey) || !isLocal;
  setText(
    "#qdrant-api-key-hint",
    isLocal
      ? "Для локального Qdrant API key не нужен; оставьте поле пустым."
      : "Заполняйте только если Qdrant Cloud или ваш сервер требует ключ."
  );
}

function updateRerankerApiKeyHint() {
  const details = $("#reranker-api-key-details");
  if (!details) return;

  const reranker = state.reranker || {};
  const url = $("#reranker-url")?.value || reranker.baseUrl || "http://127.0.0.1:8080";
  const isLocal = isLocalQdrantUrl(url);
  details.open = Boolean(reranker.hasApiKey) || !isLocal;
  setText(
    "#reranker-api-key-hint",
    isLocal
      ? "Для локального reranker API key обычно не нужен; оставьте поле пустым."
      : "Заполняйте только если удаленный reranker требует ключ."
  );
}

function setVectorConnectionStatus(status, text) {
  const box = $("#vector-connection-status");
  if (!box) return;
  box.classList.remove("online", "offline", "checking", "disabled");
  box.classList.add(status);
  setText("#vector-connection-status-text", text);
}

function setRerankerConnectionStatus(status, text) {
  const box = $("#reranker-connection-status");
  if (!box) return;
  box.classList.remove("online", "offline", "checking", "disabled");
  box.classList.add(status);
  setText("#reranker-connection-status-text", text);
}

function setDiagnosticBadge(selector, status, text) {
  const element = $(selector);
  if (!element) return;
  element.classList.remove("online", "offline", "checking", "disabled", "error");
  element.classList.add(status);
  element.textContent = text;
}

function diagnosticStatusLabel(status) {
  return {
    online: "подключен",
    offline: "нет связи",
    disabled: "выключен",
    checking: "проверка",
    error: "ошибка"
  }[status] || status;
}

function renderIntegrationsStatus(payload = state.integrationsStatus) {
  if (!$("#qdrant-diag-state")) return;
  const vectorStore = payload?.vectorStore || {};
  const reranker = payload?.reranker || {};
  const pdf = payload?.pdf || {};

  const qdrantState = vectorStore.qdrantEnabled
    ? (vectorStore.qdrantAvailable ? "online" : "offline")
    : "disabled";
  const qdrantPoints = Number(vectorStore.qdrantPoints || 0);
  setDiagnosticBadge("#qdrant-diag-state", qdrantState, diagnosticStatusLabel(qdrantState));
  if (!vectorStore.qdrantEnabled) {
    setVectorConnectionStatus("disabled", "Qdrant выключен, поиск идет через JSON fallback.");
  } else if (vectorStore.qdrantAvailable) {
    setVectorConnectionStatus(
      "online",
      `Qdrant подключен: ${vectorStore.qdrantCollection || "коллекция"} · ${qdrantPoints} точек.`
    );
  } else {
    setVectorConnectionStatus("offline", `Qdrant не отвечает${vectorStore.qdrantError ? `: ${vectorStore.qdrantError}` : "."}`);
  }
  setText(
    "#qdrant-diag-collection",
    vectorStore.qdrantCollection
      ? `${vectorStore.qdrantCollection} · ${qdrantPoints}`
      : "not configured"
  );

  const rerankerState = reranker.enabled
    ? (reranker.configured ? "online" : "offline")
    : "disabled";
  setDiagnosticBadge("#reranker-diag-state", rerankerState, diagnosticStatusLabel(rerankerState));
  if (!reranker.enabled) {
    setRerankerConnectionStatus("disabled", "Reranker выключен.");
    setRerankerProcessStatus("disabled", {
      ...(state.rerankerProcessStatus || {}),
      enabled: false,
      running: Boolean(state.rerankerProcessStatus?.running),
      model: reranker.model || state.rerankerProcessStatus?.model || ""
    });
  } else if (reranker.configured) {
    setRerankerConnectionStatus("online", `Reranker готов: ${reranker.model} · кандидатов ${reranker.candidateCount}.`);
  } else {
    setRerankerConnectionStatus("offline", "Reranker включен, но URL не задан.");
  }

  const pdfParts = [
    pdf.pdfConverter || "builtin",
    pdf.pdfOcrMode ? `pdf-ocr ${pdf.pdfOcrMode}` : "",
    pdf.builtinOcr?.enabled ? `ocr ${pdf.builtinOcr.langs}, ${pdf.builtinOcr.maxPages ? `max ${pdf.builtinOcr.maxPages} pages` : "all pages"}` : "ocr off",
    pdf.docling?.enabled ? "docling" : "",
    pdf.ocrmypdf?.enabled ? "ocrmypdf" : ""
  ].filter(Boolean);
  setText("#pdf-diag-state", pdfParts.join(" · "));

  const detail = [
    vectorStore.qdrantError ? `Qdrant: ${vectorStore.qdrantError}` : "",
    reranker.enabled && !reranker.configured ? "Reranker: укажите URL сервиса" : "",
    reranker.configured ? `Reranker endpoint: ${reranker.endpoint}` : "",
    pdf.builtinOcr?.enabled && pdf.builtinOcr.maxPages ? `OCR limit: first ${pdf.builtinOcr.maxPages} pages; set RAG_OCR_MAX_PAGES=0 and force reindex for full OCR` : "",
    pdf.docling?.enabled ? `Docling: ${pdf.docling.command}` : "",
    pdf.ocrmypdf?.enabled ? `OCRmyPDF: ${pdf.ocrmypdf.command}` : ""
  ].filter(Boolean).join(" · ");
  setText("#integrations-status-detail", detail);
  syncIndexFormLocks();
  renderAuditPanel();
}

async function refreshIntegrationsStatus() {
  if (!$("#qdrant-diag-state")) return;
  setDiagnosticBadge("#qdrant-diag-state", "checking", diagnosticStatusLabel("checking"));
  setDiagnosticBadge("#reranker-diag-state", "checking", diagnosticStatusLabel("checking"));
  setVectorConnectionStatus("checking", "Проверяю подключение к Qdrant...");
  setRerankerConnectionStatus("checking", "Проверяю настройки reranker...");
  try {
    const payload = await api("/api/integrations/status");
    state.integrationsStatus = payload;
    renderIntegrationsStatus(payload);
    renderSelectedSourceSettings();
  } catch (error) {
    state.integrationsStatus = null;
    setDiagnosticBadge("#qdrant-diag-state", "error", diagnosticStatusLabel("error"));
    setVectorConnectionStatus("offline", `Ошибка проверки Qdrant: ${error.message}`);
    setRerankerConnectionStatus("offline", `Ошибка проверки reranker: ${error.message}`);
    setText("#integrations-status-detail", error.message);
    syncIndexFormLocks();
    renderAuditPanel();
  }
}

async function saveVectorStoreSettings(event) {
  event.preventDefault();
  setText("#vector-store-status", "Сохраняю...");
  const settings = await api("/api/settings", {
    method: "PUT",
    body: JSON.stringify({ vectorStore: readVectorStoreForm() })
  });
  state.vectorStore = settings.vectorStore || {};
  state.vectorStoreEditing = false;
  const qdrant = state.vectorStore.qdrant || {};
  $("#qdrant-api-key").value = "";
  $("#qdrant-api-key").placeholder = qdrant.hasApiKey ? "Ключ сохранен; новый ввод заменит" : "Локальный Qdrant: оставьте пустым";
  updateQdrantApiKeyHint();
  syncVectorStoreSecretPlaceholder();
  setText("#vector-store-status", "Индекс сохранен.");
  await refreshIntegrationsStatus();
  syncIndexFormLocks();
}

async function saveRerankerSettings(event) {
  event.preventDefault();
  setText("#reranker-status", "Сохраняю...");
  const settings = await api("/api/settings", {
    method: "PUT",
    body: JSON.stringify({ reranker: readRerankerForm() })
  });
  state.reranker = settings.reranker || {};
  state.rerankerEditing = false;
  $("#reranker-api-key").value = "";
  $("#reranker-api-key").placeholder = state.reranker.hasApiKey ? "Ключ сохранен; новый ввод заменит" : "Локальный reranker: оставьте пустым";
  updateRerankerApiKeyHint();
  syncRerankerSecretPlaceholder();
  setText("#reranker-status", "Reranker сохранен.");
  await refreshIntegrationsStatus();
  await refreshRerankerProcessStatus({ silent: true });
  syncIndexFormLocks();
}

function setLmStatusState(stateName, text, detail = "") {
  const status = $("#lm-studio-status");
  status.classList.remove("online", "offline", "checking");
  status.classList.add(stateName);
  $("#lm-studio-status-text").textContent = text;
  $("#lm-studio-status-detail").textContent = detail;
}

function setRemoteLmStatusState(stateName, text, detail = "") {
  const status = $("#remote-lm-studio-status");
  if (!status) return;
  status.classList.remove("online", "offline", "checking");
  status.classList.add(stateName);
  $("#remote-lm-studio-status-text").textContent = text;
  $("#remote-lm-studio-status-detail").textContent = detail;
}

function setLmMiniState(stateName, title, detail) {
  const mini = $("#lm-mini");
  mini.classList.remove("online", "offline", "busy", "checking", "warning");
  mini.classList.add(stateName);
  $("#lm-mini-title").textContent = title;
  $("#lm-mini-detail").textContent = detail;
  const mirror = $("#settings-lm-mini");
  if (mirror) {
    mirror.classList.remove("online", "offline", "busy", "checking", "warning");
    mirror.classList.add(stateName);
    mirror.title = `${title}: ${detail}`;
    setText("#settings-lm-mini-detail", detail);
  }
}

function setDifyMiniState(stateName, detail, title = detail) {
  const mini = $("#dify-mini");
  const detailNode = $("#dify-mini-detail");
  if (!mini || !detailNode) return;
  mini.classList.remove("online", "offline", "busy", "checking");
  mini.classList.add(stateName);
  detailNode.textContent = detail;
  mini.title = `Dify: ${title}`;
  const mirror = $("#settings-dify-mini");
  if (mirror) {
    mirror.classList.remove("online", "offline", "busy", "checking");
    mirror.classList.add(stateName);
    mirror.title = `Dify: ${title}`;
    setText("#settings-dify-mini-detail", detail);
  }
}

function renderDifyMiniStatus(status) {
  if (!status?.configured) {
    if (status?.adapterTokenConfigured) {
      setDifyMiniState("busy", "адаптер готов", "адаптер готов, LOCALAI_DIFY_URL не задан");
    } else {
      setDifyMiniState("offline", "нет токена", "LOCALAI_DIFY_ADAPTER_TOKEN не задан");
    }
    return;
  }

  if (status.reachable) {
    const suffix = status.urlLabel ? ` · ${status.urlLabel}` : "";
    setDifyMiniState("online", "Dify запущен", `Dify отвечает${suffix}`);
    return;
  }

  setDifyMiniState("offline", "не отвечает", status.urlLabel ? `Dify не отвечает · ${status.urlLabel}` : "Dify не отвечает");
}

async function refreshDifyStatus(options = {}) {
  if (!options.silent) setDifyMiniState("checking", "проверка...");
  try {
    const status = await api("/api/dify/status");
    state.difyStatus = status;
    renderDifyMiniStatus(status);
  } catch (error) {
    state.difyStatus = null;
    const detail = error?.status === 404 ? "нужен рестарт backend" : "статус недоступен";
    setDifyMiniState("offline", detail, error.message || detail);
  }
}

function formatLmUsageDetail(payload) {
  const computer = payload?.computer || {};
  const processes = Array.isArray(computer.processes) ? computer.processes : [];
  const memory = computer.memoryPercent ? `RAM ${computer.memoryPercent}%` : "";
  const cpu = computer.cpuPercent ? `CPU ${computer.cpuPercent}%` : "";
  const processMem = processes.length
    ? `${Math.round(processes.reduce((sum, item) => sum + Number(item.memoryMb || 0), 0))} МБ`
    : "";
  const parts = [cpu, memory, processMem].filter(Boolean);
  return parts.join(" · ") || "ожидание";
}

async function refreshLmUsage() {
  try {
    const payload = await api("/api/llm/usage");
    state.llmUsage = payload;

    const processes = payload.computer?.processes || [];
    const active = payload.activeRequestsCount || 0;
    if (active > 0) {
      const request = payload.activeRequests?.[0] || {};
      const model = request.model || state.llm.model || "модель";
      const provider = request.providerLabel || "LM занята";
      setLmMiniState("busy", provider, `${model} · ${formatLmUsageDetail(payload)}`);
    } else if (processes.length) {
      setLmMiniState("online", "LM готова", formatLmUsageDetail(payload));
    } else {
      setLmMiniState("warning", "LM Studio", `процесс не найден · ${formatLmUsageDetail(payload)}`);
    }
    renderAutoRoute();
  } catch (error) {
    state.llmUsage = null;
    setLmMiniState("offline", "LM недоступна", error.message);
    renderAutoRoute();
  }
}

function modelAvailabilityText(model, available) {
  if (!model) return "не выбрана";
  return available ? model : `${model} не найдена`;
}

async function refreshLmStudioStatusLegacy() {
  setLmStatusState("checking", "LM Studio: проверка...");

  try {
    const status = await api("/api/llm/status");
    if (!status.online) {
      setLmStatusState("offline", "LM Studio: не отвечает", `${status.baseUrl || ""}${status.error ? ` · ${status.error}` : ""}`);
      return;
    }

    const detail = [
      `${status.baseUrl}`,
      `моделей ${status.modelsCount || 0}`,
      `chat: ${modelAvailabilityText(status.chatModel, status.chatModelAvailable)}`,
      `embeddings: ${modelAvailabilityText(status.embeddingModel, status.embeddingModelAvailable)}`
    ].filter(Boolean).join(" · ");

    const missing = !status.chatModelAvailable || !status.embeddingModelAvailable;
    setLmStatusState(
      missing ? "checking" : "online",
      missing ? "LM Studio: работает, но модель не найдена" : "LM Studio: работает",
      detail
    );
  } catch (error) {
    setLmStatusState("offline", "LM Studio: статус недоступен", error.message);
  }
}

function lmStatusDetail(status) {
  const detail = [
    `${status.baseUrl || ""}`,
    `моделей ${status.modelsCount || 0}`,
    `chat: ${modelAvailabilityText(status.chatModel, status.chatModelAvailable)}`
  ];
  if (status.embeddingChecked !== false) {
    detail.push(`embeddings: ${modelAvailabilityText(status.embeddingModel, status.embeddingModelAvailable)}`);
  }
  return detail.filter(Boolean).join(" · ");
}

function selectedRemoteModel() {
  return $("#remote-llm-model")?.value.trim()
    || state.llm.remote?.model
    || REMOTE_LM_DEFAULT_MODEL;
}

function selectedLocalModel() {
  return $("#llm-model")?.value.trim()
    || state.llm.model
    || "";
}

function configuredRemoteModelInfo() {
  const configured = state.remoteDiagnostics?.configuredModel;
  if (configured?.id || configured?.matchedId) return configured;

  const target = selectedRemoteModel();
  const targetKey = modelMatchKey(target);
  const items = state.remoteDiagnostics?.models?.items || [];
  const found = items.find((item) => item.id === target)
    || items.find((item) => String(item.id || "").toLowerCase() === String(target || "").toLowerCase())
    || items.find((item) => modelMatchKey(item.id) === targetKey);

  return found ? { ...found, available: true, matchedId: found.id } : null;
}

function modelLoadText(modelInfo, fallbackModel) {
  const model = modelInfo?.matchedId || modelInfo?.id || fallbackModel || "";
  if (!model) return "модель не выбрана";
  if (modelInfo?.available === false) return `${model} не найдена`;
  if (modelInfo?.loaded) return `${model} · загружена${modelInfo.loadedContextLength ? ` · ctx ${modelInfo.loadedContextLength}` : ""}`;
  if (modelInfo?.state === "not-loaded") return `${model} · доступна, загрузится при первом запросе`;
  if (modelInfo?.state) return `${model} · ${modelInfo.state}`;
  return model;
}

function localRouteText() {
  const status = state.localLmStatus;
  const model = selectedLocalModel();
  if (!status) return model ? `${model} · проверка` : "проверка локальной модели";
  if (!status.online) return `${model || "локальная модель"} · недоступна`;
  return modelAvailabilityText(status.chatModel || model, status.chatModelAvailable);
}

function setRouteBadgeState(stateName, text) {
  const badge = $("#auto-route-state");
  if (!badge) return;
  badge.classList.remove("online", "offline", "busy", "checking");
  badge.classList.add(stateName);
  badge.textContent = text;
}

function renderAutoRoute() {
  if (!$("#auto-route-panel")) return;

  const remoteToken = $("#remote-llm-token")?.value.trim();
  const hasSavedToken = Boolean(state.llm.remote?.hasApiKey);
  const provider = $("#llm-provider")?.value || state.llm.provider || "local";
  const remoteContextEnabled = $("#remote-context-enabled")?.checked ?? Boolean(state.llm.remote?.enabled || state.llm.allowRemoteContext);
  const fallbackToLocal = $("#remote-fallback-local")?.checked ?? Boolean(state.llm.fallbackToLocalOnRemoteError);
  const remoteStatus = state.remoteLmStatus;
  const remoteModel = selectedRemoteModel();
  const remoteModelInfo = configuredRemoteModelInfo();
  const localText = localRouteText();
  const llmEnabled = $("#llm-enabled")?.checked ?? Boolean(state.llm.enabled);

  if (!llmEnabled) {
    setText("#auto-route-local", localText);
    setRouteBadgeState("offline", "выключено");
    setText("#auto-route-remote", "LLM выключен");
    setText("#auto-route-note", "Включите ответы через LM Studio, чтобы auto-маршрут использовался в чате.");
    return;
  }

  setText("#auto-route-local", localText);
  syncRemoteContextWarning();

  if (!remoteContextEnabled) {
    setRouteBadgeState(provider === "remote" ? "offline" : "online", provider === "remote" ? "remote blocked" : "local only");
    setText("#auto-route-remote", "remote context выключен");
    setText("#auto-route-note", provider === "remote"
      ? "Provider remote не будет отправлять контекст, пока remote context не включен явно."
      : "Чат отправляет контекст только в локальную LM Studio.");
    return;
  }

  if (remoteToken && !hasSavedToken) {
    setRouteBadgeState("checking", "сохранить токен");
    setText("#auto-route-remote", `${remoteModel} · новый токен еще не сохранен`);
    setText("#auto-route-note", "Remote context включен, но новый токен еще не сохранен. Секреты не показываются.");
    return;
  }

  if (!hasSavedToken) {
    setRouteBadgeState(provider === "remote" ? "offline" : "online", provider === "remote" ? "remote token" : "local only");
    setText("#auto-route-remote", `${remoteModel} · нет сохраненного токена`);
    setText("#auto-route-note", provider === "remote"
      ? "Provider remote требует сохраненный токен. Автоматического local fallback нет без отдельного разрешения."
      : "Auto local-first останется локальным, пока удаленная LM Studio не настроена.");
    return;
  }

  if (!remoteStatus) {
    setRouteBadgeState("checking", "проверка");
    setText("#auto-route-remote", `${remoteModel} · проверка доступности`);
    setText("#auto-route-note", "Remote context разрешен. Auto все равно сначала пробует локальную LM Studio.");
    return;
  }

  if (!remoteStatus.online) {
    setRouteBadgeState(provider === "remote" ? "offline" : "online", provider === "remote" ? "remote offline" : "local-first");
    setText("#auto-route-remote", `${remoteModel} · не отвечает`);
    setText("#auto-route-note", provider === "remote"
      ? `Provider remote покажет ошибку${fallbackToLocal ? ", затем явно попробует local fallback" : "; local fallback выключен"}.`
      : "Auto local-first использует локальную LM Studio; remote может быть запасным маршрутом только после локальной ошибки.");
    return;
  }

  const remoteAvailable = remoteStatus.chatModelAvailable !== false && remoteModelInfo?.available !== false;
  const remoteText = modelLoadText(remoteModelInfo, remoteStatus.chatModel || remoteModel);
  if (!remoteAvailable) {
    setRouteBadgeState("checking", "модель?");
    setText("#auto-route-remote", remoteText);
    setText("#auto-route-note", "Удаленная LM Studio онлайн, но выбранная модель не подтверждена. Проверьте список моделей или обновите доступы.");
    return;
  }

  setRouteBadgeState("online", provider === "remote" ? "remote" : provider === "auto" ? "local-first" : "local");
  setText("#auto-route-remote", remoteText);
  setText("#auto-route-note", provider === "remote"
    ? `Provider remote отправляет контекст в удаленную LM Studio и ждет до ${formatRouteWait(REMOTE_AUTO_TIMEOUT_SECONDS)}${fallbackToLocal ? "; local fallback явно разрешен" : "; local fallback выключен"}.`
    : provider === "auto"
      ? `Auto local-first: сначала local, remote используется только после локальной ошибки и только потому, что remote context включен.`
      : "Provider local не отправляет контекст в remote, даже если remote context включен.");
}

function setRemoteDiagnosticsLoading(text = "проверка...") {
  setText("#remote-diag-connectivity", text);
  setText("#remote-diag-models", text);
  setText("#remote-diag-active", text);
  setText("#remote-diag-last", text);
  setText("#remote-diag-detail", "");
  renderAutoRoute();
}

function renderRemoteDiagnostics(payload) {
  state.remoteDiagnostics = payload;
  const remoteRows = remoteChatModelRows(payload);
  if (remoteRows.length) {
    const selected = setRemoteModelOptionsFromRows(remoteRows, selectedRemoteModel() || state.llm.remote?.model);
    if (state.llm.remote) state.llm.remote.model = selected;
  }
  const onlineText = payload.online
    ? `online${payload.latencyMs ? ` · ${formatLatency(payload.latencyMs)}` : ""}`
    : payload.configured === false
      ? "нужен токен"
      : "offline";
  const loadedText = payload.models?.loadedCount
    ? ` · загружено ${payload.models.loadedCount}`
    : "";
  const modelsText = payload.models?.count
    ? `${payload.models.count} всего · ${remoteRows.length || 0} для чата${loadedText}`
    : "нет данных";
  const activeText = payload.activeRequestsCount
    ? `${payload.activeRequestsCount} запрос`
    : "свободна";
  const native = payload.nativeRest || {};
  if (native.skipped && !native.available) {
    native.available = true;
    native.preferred = `skipped: ${native.reason || "runtime"}`;
  }
  const loadedNames = (payload.models?.loaded || []).map((model) => model.id).slice(0, 8).join(", ");
  const configuredModel = payload.configuredModel || {};
  const configuredModelText = configuredModel.id || configuredModel.matchedId
    ? `выбрана: ${modelLoadText(configuredModel, configuredModel.matchedId || configuredModel.id)}`
    : "";
  const detail = [
    payload.baseUrl,
    payload.remoteRuntime ? `runtime: ${payload.remoteRuntime}` : "",
    native.available ? `native REST ${native.preferred || "ok"}` : "native REST недоступен",
    payload.openai?.ok ? `/v1 ${formatLatency(payload.openai.latencyMs)}` : payload.openai?.error,
    configuredModelText,
    loadedNames ? `loaded: ${loadedNames}` : "",
    payload.error || ""
  ].filter(Boolean).join(" · ");

  setText("#remote-diag-connectivity", onlineText);
  setText("#remote-diag-models", modelsText);
  setText("#remote-diag-active", activeText);
  setText("#remote-diag-last", formatGenerationStats(payload.lastGeneration));
  setText("#remote-diag-detail", detail);
  renderAutoRoute();
  syncLlmFormLock();
}

async function refreshRemoteDiagnostics() {
  const remoteToken = $("#remote-llm-token")?.value.trim();
  const hasSavedToken = Boolean(state.llm.remote?.hasApiKey);
  if (remoteToken && !hasSavedToken) {
    state.remoteDiagnostics = null;
    setText("#remote-diag-connectivity", "сохраните токен");
    setText("#remote-diag-models", "ожидание");
    setText("#remote-diag-active", "ожидание");
    setText("#remote-diag-last", "нет данных");
    setText("#remote-diag-detail", "Токен введен в поле, но еще не сохранен. Нажмите «Сохранить доступы», затем «Обновить».");
    renderAutoRoute();
    return;
  }

  if (!hasSavedToken) {
    state.remoteDiagnostics = null;
    setText("#remote-diag-connectivity", "нужен токен");
    setText("#remote-diag-models", "ожидание");
    setText("#remote-diag-active", "ожидание");
    setText("#remote-diag-last", "нет данных");
    setText("#remote-diag-detail", "Введите токен и сохраните LLM, чтобы смотреть диагностику удаленной машины.");
    renderAutoRoute();
    return;
  }

  setRemoteDiagnosticsLoading();
  try {
    const payload = await api("/api/llm/diagnostics?provider=token");
    renderRemoteDiagnostics(payload);
  } catch (error) {
    setText("#remote-diag-connectivity", "ошибка");
    setText("#remote-diag-models", "нет данных");
    setText("#remote-diag-active", "нет данных");
    setText("#remote-diag-last", "нет данных");
    setText("#remote-diag-detail", error.message);
    renderAutoRoute();
  }
}

async function refreshProviderLmStudioStatus(provider, setStatus, title) {
  setStatus("checking", `${title}: проверка...`);

  try {
    const status = await api(`/api/llm/status?provider=${encodeURIComponent(provider)}`);
    if (!status.online) {
      setStatus("offline", `${title}: не отвечает`, `${status.baseUrl || ""}${status.error ? ` · ${status.error}` : ""}`);
      return status;
    }

    const missing = !status.chatModelAvailable || !status.embeddingModelAvailable;
    setStatus(
      missing ? "checking" : "online",
      missing ? `${title}: работает, но модель не найдена` : `${title}: работает`,
      lmStatusDetail(status)
    );
    return status;
  } catch (error) {
    setStatus("offline", `${title}: статус недоступен`, error.message);
    return {
      online: false,
      provider,
      error: error.message
    };
  }
}

async function refreshLmStudioStatus() {
  const remoteToken = $("#remote-llm-token")?.value.trim();
  const hasSavedToken = Boolean(state.llm.remote?.hasApiKey);
  const checks = [
    refreshProviderLmStudioStatus("local", setLmStatusState, "Локальный LM Studio")
      .then((status) => {
        state.localLmStatus = status;
      })
  ];

  if (remoteToken && !hasSavedToken) {
    state.remoteLmStatus = null;
    setRemoteLmStatusState(
      "checking",
      "LM Studio по токену: токен введен",
      "Нажмите «Сохранить доступы», затем «Обновить»."
    );
  } else {
    checks.push(
      refreshProviderLmStudioStatus("token", setRemoteLmStatusState, "LM Studio по токену")
        .then((status) => {
          state.remoteLmStatus = status;
        })
    );
  }

  await Promise.allSettled(checks);
  renderAutoRoute();
  syncLlmFormLock();
}

async function saveLlmSettings(event) {
  event.preventDefault();
  setText("#llm-status", "Сохраняю...");
  const settings = await api("/api/settings", {
    method: "PUT",
    body: JSON.stringify({ llm: readLlmForm(), embeddings: readEmbeddingForm() })
  });
  state.llm = settings.llm || {};
  state.embeddings = settings.embeddings || {};
  state.llmEditing = false;
  syncLlmSecretPlaceholder();
  syncLlmFormLock();
  setText("#llm-status", "LLM сохранен.");
  await refreshLmStudioStatus();
  await refreshRemoteDiagnostics();
  syncLlmFormLock();
}

async function loadLlmModels() {
  setText("#llm-status", "Проверяю LM Studio...");
  await api("/api/settings", {
    method: "PUT",
    body: JSON.stringify({ llm: readLlmForm(), embeddings: readEmbeddingForm() })
  });
  const payload = await api("/api/llm/models?provider=local");
  const models = payload.models || [];
  if (models.length) {
    setSelectOptions("#llm-model", models.filter((model) => !/embed|embedding/i.test(model)), preferredLocalModel(models, state.llm.model), "Локальные модели не загружены");
    setSelectOptions("#embedding-model", models.filter((model) => /embed|embedding/i.test(model)), preferredEmbeddingModel(models, state.embeddings.model), "Embeddings не загружены");
    const saved = await api("/api/settings", {
      method: "PUT",
      body: JSON.stringify({ llm: readLlmForm(), embeddings: readEmbeddingForm() })
    });
    state.llm = saved.llm || {};
    state.embeddings = saved.embeddings || {};
    syncLlmSecretPlaceholder();
  }
  setText("#llm-status", models.length ? `Моделей найдено: ${models.length}` : "Модели не найдены.");
  refreshLmStudioStatus();
  syncLlmFormLock();
}

async function loadRemoteLlmModels() {
  setText("#llm-status", "Проверяю второй LM Studio...");
  const settings = await api("/api/settings", {
    method: "PUT",
    body: JSON.stringify({ llm: readLlmForm(), embeddings: readEmbeddingForm() })
  });
  state.llm = settings.llm || {};
  state.embeddings = settings.embeddings || {};
  syncLlmSecretPlaceholder();
  syncLlmFormLock();

  try {
    const payload = await api("/api/llm/diagnostics?provider=token");
    renderRemoteDiagnostics(payload);
    const rows = remoteChatModelRows(payload);
    if (rows.length) {
      const saved = await api("/api/settings", {
        method: "PUT",
        body: JSON.stringify({ llm: readLlmForm(), embeddings: readEmbeddingForm() })
      });
      state.llm = saved.llm || {};
      state.embeddings = saved.embeddings || {};
      syncLlmSecretPlaceholder();
    }
    const total = payload.models?.count || rows.length;
    setText("#llm-status", rows.length ? `Моделей удаленной LM Studio: ${total}, для чата: ${rows.length}` : "Модели удаленной LM Studio не найдены.");
  } catch (error) {
    setText("#llm-status", error.message);
  } finally {
    refreshLmStudioStatus();
    refreshRemoteDiagnostics();
    syncLlmFormLock();
  }
}

function tenderSyncTotalLabel(key) {
  return {
    foldersOnDisk: "папок",
    created: "создать",
    updated: "обновить",
    applied: "записано",
    scopeCreated: "создано",
    scopeUpdated: "обновлено",
    linked: "привязано",
    manualLinked: "вручную",
    autoLinked: "авто",
    unlinked: "без договора",
    unlinkedReady: "создать без договора",
    review: "проверить",
    stale: "устарели"
  }[key] || key;
}

function tenderSyncNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function tenderSyncTotal(summary = {}, key) {
  return tenderSyncNumber(summary.totals?.[key]);
}

function tenderSyncTotalKeys(summary = {}) {
  return summary.apply && summary.applyScope === "unlinked"
    ? ["foldersOnDisk", "applied", "scopeCreated", "scopeUpdated", "unlinkedReady", "review", "stale"]
    : ["foldersOnDisk", "created", "updated", "linked", "manualLinked", "autoLinked", "unlinkedReady", "review", "stale"];
}

function tenderSyncLeadText(summary = {}) {
  if (summary.apply && summary.applyScope === "unlinked") {
    return "Созданы только тендеры без договора. Привязанные и спорные строки не записывались.";
  }
  if (summary.apply) {
    return "Источники обновлены. Оставшиеся тендеры без договора можно привязать вручную в группе «Тендеры».";
  }
  return "Это предварительный просмотр. Автоматически запишутся только уверенные привязки; спорные строки останутся без договора.";
}

function tenderSyncActionLabel(action) {
  return {
    create: "Создать",
    update: "Обновить"
  }[action] || action || "Проверить";
}

function tenderSyncItemNeedsReview(item = {}) {
  return Boolean(item.mappingError || (!item.linkedContractId && Array.isArray(item.matchCandidates) && item.matchCandidates.length));
}

function tenderSyncItemIsUnlinkedReady(item = {}) {
  return !item.linkedContractId && !tenderSyncItemNeedsReview(item);
}

function tenderSyncAutoLinkKey(item = {}) {
  return String(item.tenderId || item.path || item.title || "").trim();
}

function tenderSyncExcludedAutoLinksPayload() {
  const excluded = state.tenderSync?.excludedAutoLinks;
  if (!excluded || typeof excluded.values !== "function") return [];
  return Array.from(excluded.values())
    .map((item) => ({
      tenderId: String(item.tenderId || "").trim(),
      path: String(item.path || "").trim(),
      linkedContractId: String(item.linkedContractId || "").trim()
    }))
    .filter((item) => item.tenderId || item.path);
}

function tenderSyncSelectedLinksPayload() {
  const selected = state.tenderSync?.selectedTenderLinks;
  if (!selected || typeof selected.values !== "function") return [];
  return Array.from(selected.values())
    .map((item) => ({
      tenderId: String(item.tenderId || "").trim(),
      path: String(item.path || "").trim(),
      linkedContractId: String(item.linkedContractId || "").trim()
    }))
    .filter((item) => item.linkedContractId && (item.tenderId || item.path));
}

function tenderSyncItemIsAutoLinkExcluded(item = {}) {
  const key = tenderSyncAutoLinkKey(item);
  return Boolean(key && state.tenderSync?.excludedAutoLinks?.has(key));
}

function tenderSyncSelectedLinkForItem(item = {}) {
  const key = tenderSyncAutoLinkKey(item);
  return key ? state.tenderSync?.selectedTenderLinks?.get(key) || null : null;
}

function tenderSyncSelectedCandidateId(item = {}) {
  const selectedLink = tenderSyncSelectedLinkForItem(item);
  return String(selectedLink?.linkedContractId || item.linkedContractId || item.selectedMatchCandidateId || item.excludedLinkedContractId || "").trim();
}

function tenderSyncDisplayedCandidates(item = {}, limit = 5) {
  const candidates = Array.isArray(item.matchCandidates) ? item.matchCandidates : [];
  const max = Math.max(1, Number(limit) || 3);
  const selectedId = tenderSyncSelectedCandidateId(item);
  if (selectedId) {
    const selected = candidates.find((candidate) => candidate.id === selectedId);
    const rest = candidates.filter((candidate) => candidate.id !== selectedId);
    return (selected ? [selected, ...rest] : candidates).slice(0, max);
  }
  return candidates.slice(0, max);
}

function tenderSyncPrimaryCandidateTitle(item = {}) {
  return tenderSyncDisplayedCandidates(item, 1)[0]?.title || "";
}

function tenderSyncWithExcludedAutoLinks(summary = {}) {
  const planned = Array.isArray(summary.planned)
    ? summary.planned.map((item) => {
        const selectedLink = tenderSyncSelectedLinkForItem(item);
        if (selectedLink?.linkedContractId) {
          return {
            ...item,
            linkedContractId: selectedLink.linkedContractId,
            selectedMatchCandidateId: selectedLink.linkedContractId,
            selectedLinked: true,
            linkSource: "selected",
            manualLinked: false,
            autoLinked: false,
            autoLinkExcluded: false
          };
        }
        if (!item.autoLinked || !tenderSyncItemIsAutoLinkExcluded(item)) return item;
        return {
          ...item,
          excludedLinkedContractId: item.linkedContractId || "",
          linkedContractId: "",
          linkSource: "excluded-auto",
          autoLinked: false,
          autoLinkExcluded: true
        };
      })
    : [];
  const scopedPlanned = summary.applyScope === "unlinked"
    ? planned.filter((item) => tenderSyncItemIsUnlinkedReady(item))
    : planned;
  const totals = {
    ...(summary.totals || {}),
    applied: scopedPlanned.length,
    scopeCreated: scopedPlanned.filter((item) => item.action === "create").length,
    scopeUpdated: scopedPlanned.filter((item) => item.action === "update").length,
    linked: planned.filter((item) => item.linkedContractId).length,
    manualLinked: planned.filter((item) => item.manualLinked).length,
    selectedLinked: planned.filter((item) => item.selectedLinked).length,
    autoLinked: planned.filter((item) => item.autoLinked).length,
    autoLinkExcluded: planned.filter((item) => item.autoLinkExcluded).length,
    unlinked: planned.filter((item) => !item.linkedContractId).length,
    unlinkedReady: planned.filter((item) => tenderSyncItemIsUnlinkedReady(item)).length,
    review: planned.filter((item) => tenderSyncItemNeedsReview(item)).length
  };
  return { ...summary, totals, planned };
}

function tenderSyncItemStatus(item = {}) {
  if (item.mappingError) return { className: "is-error", label: "Ошибка mapping", detail: item.mappingError };
  if (item.autoLinkExcluded) {
    return { className: "needs-link", label: "Авто снято", detail: tenderSyncPrimaryCandidateTitle(item) };
  }
  if (item.selectedLinked) {
    return { className: "is-linked", label: "Добавлено вручную", detail: tenderSyncPrimaryCandidateTitle(item) || item.linkedContractId || "" };
  }
  if (item.manualLinked) {
    return { className: "is-linked", label: "Привязано вручную", detail: tenderSyncPrimaryCandidateTitle(item) || item.linkedContractId || "" };
  }
  if (item.autoLinked) {
    return { className: "is-linked", label: "Авто-привязка", detail: tenderSyncPrimaryCandidateTitle(item) || item.linkedContractId || "" };
  }
  if (item.linkedContractId) return { className: "is-linked", label: "Привязано", detail: item.linkedContractId };
  if (Array.isArray(item.matchCandidates) && item.matchCandidates.length) {
    return { className: "needs-link", label: "Нужна привязка", detail: "" };
  }
  return { className: "is-unlinked", label: "Без договора", detail: "" };
}

function tenderSyncReviewGroups(planned = []) {
  const groups = {
    linked: [],
    review: [],
    unlinked: []
  };

  for (const item of planned) {
    if (tenderSyncItemNeedsReview(item)) {
      groups.review.push(item);
    } else if (item.linkedContractId) {
      groups.linked.push(item);
    } else {
      groups.unlinked.push(item);
    }
  }

  return groups;
}

function candidateEvidenceText(candidate = {}, item = {}) {
  const parts = [];
  if (Number.isFinite(Number(candidate.score || item.matchScore))) {
    parts.push(`score ${Number(candidate.score || item.matchScore).toFixed(2).replace(/\.00$/, "")}`);
  }
  const tokens = Array.isArray(candidate.matchedTokens) ? candidate.matchedTokens : [];
  if (tokens.length) parts.push(`совпало: ${tokens.join(", ")}`);
  return parts.join(" · ");
}

function renderTenderSyncCandidate(candidate, item) {
  const line = document.createElement("div");
  line.className = "tender-sync-candidate";
  const selected = candidate.id && candidate.id === tenderSyncSelectedCandidateId(item);
  const title = document.createElement("span");
  title.className = "tender-sync-candidate-title";
  title.textContent = candidate.title || candidate.id || "Кандидат";
  const evidence = document.createElement("span");
  evidence.className = "tender-sync-candidate-evidence";
  evidence.textContent = candidateEvidenceText(candidate, item);
  line.append(title);
  if (evidence.textContent) line.append(evidence);
  if (candidate.id) {
    if (selected && item.linkedContractId) {
      const badge = document.createElement("span");
      badge.className = "tender-sync-candidate-selected";
      badge.textContent = item.autoLinked ? "Авто" : "Выбрано";
      line.append(badge);
    } else {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "tender-sync-candidate-action";
      button.textContent = "Добавить";
      button.addEventListener("click", () => selectTenderSyncCandidate(item, candidate));
      line.append(button);
    }
  }
  return line;
}

function selectTenderSyncCandidate(item = {}, candidate = {}) {
  if (!candidate.id) return;
  const key = tenderSyncAutoLinkKey(item);
  if (!key) return;
  state.tenderSync.selectedTenderLinks.set(key, {
    tenderId: item.tenderId || "",
    path: item.path || "",
    linkedContractId: candidate.id,
    title: item.title || "",
    contractTitle: candidate.title || candidate.id
  });
  state.tenderSync.excludedAutoLinks.delete(key);
  if (state.tenderSync.summary) showTenderSyncReport(state.tenderSync.summary);
  setText("#job-status", `Выбран договор для тендера: ${candidate.title || candidate.id}.`);
}

function tenderSyncCanRemoveAutoLink(item = {}) {
  return Boolean(item.autoLinked && item.linkedContractId && !item.manualLinked && tenderSyncAutoLinkKey(item));
}

function removeTenderSyncAutoLink(item = {}) {
  if (!tenderSyncCanRemoveAutoLink(item)) return;
  const key = tenderSyncAutoLinkKey(item);
  state.tenderSync.excludedAutoLinks.set(key, {
    tenderId: item.tenderId || "",
    path: item.path || "",
    linkedContractId: item.linkedContractId || "",
    title: item.title || ""
  });
  state.tenderSync.selectedTenderLinks.delete(key);
  if (state.tenderSync.summary) showTenderSyncReport(state.tenderSync.summary);
  setText("#job-status", "Автопривязка снята. При записи этот тендер останется без договора.");
}

function renderTenderSyncAutoLinkRemoveButton(item = {}) {
  if (!tenderSyncCanRemoveAutoLink(item)) return null;
  const button = document.createElement("button");
  button.type = "button";
  button.className = "tender-sync-remove-auto-link";
  button.textContent = "×";
  button.title = "Убрать автопривязку";
  button.setAttribute("aria-label", `Убрать автопривязку договора для ${item.title || "тендера"}`);
  button.addEventListener("click", () => removeTenderSyncAutoLink(item));
  return button;
}

function renderTenderSyncMetric(className, value, label, detail) {
  const card = document.createElement("div");
  card.className = `tender-sync-metric tender-sync-metric-${className}`;

  const number = document.createElement("div");
  number.className = "tender-sync-metric-number";
  number.textContent = `${value}`;

  const text = document.createElement("div");
  text.className = "tender-sync-metric-text";

  const title = document.createElement("div");
  title.className = "tender-sync-metric-label";
  title.textContent = label;

  const subtitle = document.createElement("div");
  subtitle.className = "tender-sync-metric-detail";
  subtitle.textContent = detail;

  text.append(title, subtitle);
  card.append(number, text);
  return card;
}

function renderTenderSyncFlowStep(step, title, detail, className = "") {
  const item = document.createElement("div");
  item.className = `tender-sync-flow-step${className ? ` ${className}` : ""}`;

  const number = document.createElement("span");
  number.className = "tender-sync-flow-number";
  number.textContent = step;

  const text = document.createElement("span");
  text.className = "tender-sync-flow-text";

  const titleLine = document.createElement("span");
  titleLine.className = "tender-sync-flow-title";
  titleLine.textContent = title;

  const detailLine = document.createElement("span");
  detailLine.className = "tender-sync-flow-detail";
  detailLine.textContent = detail;

  text.append(titleLine, detailLine);
  item.append(number, text);
  return item;
}

function renderTenderSyncTotals(summary = {}) {
  const totals = document.createElement("div");
  totals.className = "tender-sync-totals";

  for (const key of tenderSyncTotalKeys(summary)) {
    if (!Number.isFinite(Number(summary.totals?.[key]))) continue;
    const pill = document.createElement("span");
    pill.className = "tender-sync-pill";
    pill.textContent = `${tenderSyncTotalLabel(key)}: ${summary.totals[key]}`;
    totals.append(pill);
  }

  return totals;
}

function renderTenderSyncSummary(summary = {}, groups = {}) {
  const wrapper = document.createElement("div");
  wrapper.className = "tender-sync-summary";

  const isUnlinkedScope = summary.apply && summary.applyScope === "unlinked";
  const modeLabel = isUnlinkedScope
    ? "Запись без договора"
    : summary.apply
    ? "Запись завершена"
    : "Предпросмотр Google Drive";

  const hero = document.createElement("div");
  hero.className = "tender-sync-hero";

  const copy = document.createElement("div");
  copy.className = "tender-sync-hero-copy";

  const mode = document.createElement("div");
  mode.className = `tender-sync-mode${summary.apply ? " is-applied" : " is-dry-run"}`;
  mode.textContent = modeLabel;

  const lead = document.createElement("div");
  lead.className = "tender-sync-lead";
  lead.textContent = tenderSyncLeadText(summary);
  copy.append(mode, lead);

  const flow = document.createElement("div");
  flow.className = "tender-sync-flow";
  flow.append(
    renderTenderSyncFlowStep("1", "Скан Google Drive", `${tenderSyncTotal(summary, "foldersOnDisk")} папок`),
    renderTenderSyncFlowStep("2", "Разбор привязок", `${groups.linked?.length || 0} уверенно, ${groups.review?.length || 0} спорно`),
    renderTenderSyncFlowStep("3", "Запись источников", summary.apply ? "уже выполнена" : "после подтверждения", summary.apply ? "is-done" : "")
  );

  hero.append(copy, flow);

  const metrics = document.createElement("div");
  metrics.className = "tender-sync-metrics";
  metrics.append(
    renderTenderSyncMetric("folders", tenderSyncTotal(summary, "foldersOnDisk"), "Папок найдено", "из Google Drive"),
    renderTenderSyncMetric("linked", groups.linked?.length || 0, "Авто-привязка", "запишется с договором"),
    renderTenderSyncMetric("review", groups.review?.length || 0, "Проверить вручную", "останется без автопривязки"),
    renderTenderSyncMetric("unlinked", groups.unlinked?.length || 0, "Без договора", "создать отдельными тендерами")
  );

  const totals = renderTenderSyncTotals(summary);
  wrapper.append(hero, metrics);
  if (totals.childElementCount) wrapper.append(totals);
  return wrapper;
}

function tenderSyncSectionIntro(key, count) {
  if (key === "linked") {
    return `${count} тендер(ов) будут привязаны сразу. Проверьте название договора и совпавшие слова.`;
  }
  if (key === "review") {
    return `${count} тендер(ов) автомат не будет привязывать: есть неоднозначные кандидаты или ошибка mapping.`;
  }
  return `${count} тендер(ов) будут созданы без договора. Для «В работе» и «Проиграли» это ожидаемое поведение.`;
}

function renderTenderSyncSection(titleText, key, items) {
  const section = document.createElement("section");
  section.className = `tender-sync-section tender-sync-section-${key}`;

  const header = document.createElement("div");
  header.className = "tender-sync-section-header";
  const titleWrap = document.createElement("div");
  titleWrap.className = "tender-sync-section-title-wrap";
  const marker = document.createElement("span");
  marker.className = "tender-sync-section-marker";
  marker.setAttribute("aria-hidden", "true");
  const title = document.createElement("div");
  title.className = "tender-sync-section-title";
  title.textContent = titleText;
  const count = document.createElement("span");
  count.className = "tender-sync-section-count";
  count.textContent = `${items.length}`;
  titleWrap.append(marker, title);
  header.append(titleWrap, count);

  const intro = document.createElement("div");
  intro.className = "tender-sync-section-intro";
  intro.textContent = tenderSyncSectionIntro(key, items.length);

  const list = document.createElement("div");
  list.className = "tender-sync-list";

  if (!items.length) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = "Нет строк в этой группе.";
    list.append(empty);
    section.append(header, intro, list);
    return section;
  }

  for (const item of items) {
    const status = tenderSyncItemStatus(item);
    const row = document.createElement("div");
    row.className = `tender-sync-row ${status.className}`;

    const main = document.createElement("div");
    main.className = "tender-sync-main";

    const name = document.createElement("div");
    name.className = "tender-sync-name";
    name.textContent = item.title || item.tenderId || "Тендер";

    const meta = document.createElement("div");
    meta.className = "tender-sync-meta";
    meta.textContent = [tenderSyncActionLabel(item.action), item.tenderCategory].filter(Boolean).join(" · ");

    const candidates = tenderSyncDisplayedCandidates(item);
    const detailText = status.detail || (!item.linkedContractId && candidates.length
      ? "Автомат не записывает привязку, потому что совпадение не уверенное."
      : "");
    const detail = document.createElement("div");
    detail.className = "tender-sync-detail";
    detail.hidden = !detailText;
    if (detailText) {
      const detailLabel = document.createElement("span");
      detailLabel.className = "tender-sync-detail-label";
      detailLabel.textContent = item.autoLinkExcluded
        ? "Снят договор: "
        : status.className === "is-linked"
        ? "Договор: "
        : status.className === "is-error"
        ? "Ошибка: "
        : "Причина: ";
      detail.append(detailLabel, document.createTextNode(detailText));
    }

    main.append(name, meta);
    if (!detail.hidden) main.append(detail);

    if (candidates.length) {
      const candidateList = document.createElement("div");
      candidateList.className = "tender-sync-candidates";
      const candidateTitle = document.createElement("div");
      candidateTitle.className = "tender-sync-candidates-title";
      candidateTitle.textContent = item.autoLinkExcluded
        ? "Совпавшие договоры"
        : item.linkedContractId
        ? "Совпавшие договоры"
        : "Кандидаты на договор";
      candidateList.append(candidateTitle);
      for (const candidate of candidates) {
        candidateList.append(renderTenderSyncCandidate(candidate, item));
      }
      main.append(candidateList);
    }

    const badge = document.createElement("span");
    badge.className = "tender-sync-status";
    badge.textContent = status.label;

    const rowActions = document.createElement("div");
    rowActions.className = "tender-sync-row-actions";
    rowActions.append(badge);
    const removeButton = renderTenderSyncAutoLinkRemoveButton(item);
    if (removeButton) rowActions.append(removeButton);

    row.append(main, rowActions);
    list.append(row);
  }

  section.append(header, intro, list);
  return section;
}

function createTenderSyncApplyButton(label, scope = "all", disabled = false) {
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = label;
  button.disabled = disabled;
  button.addEventListener("click", () => {
    const message = scope === "unlinked"
      ? "Создать тендеры без договора? Изменения будут записаны в источники RAG."
      : "Применить синхронизацию тендеров? Изменения будут записаны в источники RAG.";
    if (typeof window.confirm === "function" && !window.confirm(message)) return;
    syncTenders({ apply: true, scope });
  });
  return button;
}

function renderTenderSyncTabButton(key, label, count, active) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = `tender-sync-tab${active ? " active" : ""}`;
  button.dataset.tenderSyncTab = key;
  button.setAttribute("role", "tab");
  button.setAttribute("aria-selected", active ? "true" : "false");
  button.setAttribute("aria-controls", `tender-sync-panel-${key}`);
  button.textContent = label;

  const badge = document.createElement("span");
  badge.className = "tender-sync-tab-count";
  badge.textContent = `${count}`;
  button.append(badge);
  return button;
}

function activateTenderSyncTab(root, key) {
  root.querySelectorAll("[data-tender-sync-tab]").forEach((button) => {
    const active = button.dataset.tenderSyncTab === key;
    button.classList.toggle("active", active);
    button.setAttribute("aria-selected", active ? "true" : "false");
  });
  root.querySelectorAll("[data-tender-sync-panel]").forEach((panel) => {
    panel.hidden = panel.dataset.tenderSyncPanel !== key;
  });
}

function renderTenderSyncTabPanel(key, active) {
  const panel = document.createElement("div");
  panel.id = `tender-sync-panel-${key}`;
  panel.className = "tender-sync-tab-panel";
  panel.dataset.tenderSyncPanel = key;
  panel.setAttribute("role", "tabpanel");
  panel.hidden = !active;
  return panel;
}

function renderTenderSyncOverview(summary, groups) {
  const panel = renderTenderSyncTabPanel("overview", summary.applyScope !== "unlinked");
  if (!summary.apply) {
    const actions = document.createElement("div");
    actions.className = "tender-sync-actions";
    const label = summary.totals?.unlinked
      ? "Создать тендеры, спорные оставить без договора"
      : "Записать изменения";
    actions.append(createTenderSyncApplyButton(label, "all"));
    panel.append(actions);
  }
  panel.append(
    renderTenderSyncSection("Автоматически привяжется", "linked", groups.linked),
    renderTenderSyncSection("Нужно проверить вручную", "review", groups.review),
    renderTenderSyncSection("Создастся без договора", "unlinked", groups.unlinked)
  );
  return panel;
}

function renderTenderSyncUnlinkedTab(summary, groups) {
  const panel = renderTenderSyncTabPanel("unlinked", summary.applyScope === "unlinked");
  const actions = document.createElement("div");
  actions.className = "tender-sync-actions";

  if (!summary.apply) {
    actions.append(createTenderSyncApplyButton(
      "Создать найденные тендеры без договора",
      "unlinked",
      !groups.unlinked.length
    ));
  } else if (summary.applyScope === "unlinked") {
    const status = document.createElement("div");
    status.className = "tender-sync-tab-status";
    status.textContent = "Созданы только тендеры без договора.";
    actions.append(status);
  }

  if (actions.childElementCount) panel.append(actions);
  panel.append(renderTenderSyncSection("Найденные тендеры без договора", "unlinked", groups.unlinked));
  return panel;
}

function renderTenderSyncTabs(summary, groups) {
  const root = document.createElement("div");
  root.className = "tender-sync-tabs-layout";
  const activeTab = summary.applyScope === "unlinked" ? "unlinked" : "overview";

  const tabList = document.createElement("div");
  tabList.className = "tender-sync-tabs";
  tabList.setAttribute("role", "tablist");
  tabList.setAttribute("aria-label", "Результаты синхронизации тендеров");
  tabList.append(
    renderTenderSyncTabButton("overview", "Обзор", groups.linked.length + groups.review.length + groups.unlinked.length, activeTab === "overview"),
    renderTenderSyncTabButton("unlinked", "Без договора", groups.unlinked.length, activeTab === "unlinked")
  );

  const panels = document.createElement("div");
  panels.className = "tender-sync-tab-panels";
  panels.append(
    renderTenderSyncOverview(summary, groups),
    renderTenderSyncUnlinkedTab(summary, groups)
  );

  root.append(tabList, panels);
  tabList.querySelectorAll("[data-tender-sync-tab]").forEach((button) => {
    button.addEventListener("click", () => activateTenderSyncTab(root, button.dataset.tenderSyncTab));
  });
  return root;
}

function renderTenderSyncPlan(summary = {}, groups = null) {
  const planned = Array.isArray(summary.planned) ? summary.planned : [];
  const resolvedGroups = groups || tenderSyncReviewGroups(planned);
  const container = document.createElement("div");
  container.className = "tender-sync-review";

  if (!planned.length) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = "Новых или обновляемых тендеров нет.";
    container.append(empty);
    return container;
  }

  container.append(renderTenderSyncTabs(summary, resolvedGroups));
  return container;
}

function closeTenderSyncModal() {
  const modal = $("#tender-sync-modal");
  if (modal) modal.hidden = true;
}

function showTenderSyncReport(summary = {}) {
  const report = $("#tender-sync-report");
  const modal = $("#tender-sync-modal");
  if (!report) return;
  state.tenderSync.summary = summary;
  const displaySummary = tenderSyncWithExcludedAutoLinks(summary);

  if (modal) modal.hidden = false;
  setText("#tender-sync-modal-title", displaySummary.apply && displaySummary.applyScope === "unlinked"
    ? "Тендеры без договора созданы"
    : displaySummary.apply
    ? "Синхронизация применена"
    : "Синхронизация тендеров с Google Drive");
  setText("#tender-sync-modal-subtitle", displaySummary.apply && displaySummary.applyScope === "unlinked"
    ? "Записаны только источники без договора"
    : displaySummary.apply
    ? "Источники записаны"
    : "Предпросмотр: ничего не записано");
  report.innerHTML = "";
  const planned = Array.isArray(displaySummary.planned) ? displaySummary.planned : [];
  const groups = tenderSyncReviewGroups(planned);

  report.append(renderTenderSyncSummary(displaySummary, groups));
  report.append(renderTenderSyncPlan(displaySummary, groups));
  report.scrollTop = 0;
}

function tenderSyncErrorDetails(error) {
  const diagnostics = error?.payload?.tenderSync || null;
  const details = [];
  if (error?.status === 404 && String(error.message || "") === "HTTP 404") {
    details.push("Маршрут /api/tenders/sync не найден. Перезапустите backend, чтобы подхватить актуальный API.");
  }
  if (diagnostics?.tenderRoot) {
    details.push(`Корень тендеров: ${diagnostics.tenderRoot}`);
  }
  if (diagnostics && diagnostics.rootExists === false) {
    details.push("Google Drive Desktop не отдал эту папку или RAG_TENDER_ROOT указывает не туда.");
  }
  const missing = Number(diagnostics?.categoriesMissing || 0);
  const categoryErrors = Number(diagnostics?.categoryErrors || 0);
  if (missing || categoryErrors) {
    details.push(`Категории: доступно ${formatCount(diagnostics.categoriesReadable)}, недоступно ${formatCount(missing + categoryErrors)}.`);
  }
  return details;
}

async function syncTenders(options = {}) {
  const apply = typeof options === "boolean" ? options : Boolean(options.apply);
  const scope = typeof options === "object" && options.scope ? options.scope : "all";
  if (!apply) {
    state.tenderSync.summary = null;
    state.tenderSync.selectedTenderLinks.clear();
    state.tenderSync.excludedAutoLinks.clear();
  }
  const button = $("#tender-sync-button");
  if (button) {
    button.disabled = true;
    button.textContent = apply && scope === "unlinked"
      ? "Создаю без договора..."
      : apply
      ? "Записываю тендеры..."
      : "Проверяю тендеры...";
  }

  try {
    const params = new URLSearchParams();
    if (apply) params.set("apply", "true");
    if (scope !== "all") params.set("scope", scope);
    const query = params.toString();
    const selectedTenderLinks = tenderSyncSelectedLinksPayload();
    const excludedAutoLinks = tenderSyncExcludedAutoLinksPayload();
    const requestOptions = { method: "POST" };
    if (selectedTenderLinks.length || excludedAutoLinks.length) {
      requestOptions.body = JSON.stringify({ selectedTenderLinks, excludedAutoLinks });
    }
    const payload = await api(`/api/tenders/sync${query ? `?${query}` : ""}`, requestOptions);
    showTenderSyncReport(payload);
    if (apply) {
      state.sources = Array.isArray(payload.sources) ? payload.sources : await api("/api/sources");
      if (!state.sources.some((source) => source.id === state.settingsSourceId)) {
        state.settingsSourceId = contractSourcesForUi()[0]?.id || state.sources[0]?.id || "";
      }
      if (tenderSourcesForUi().length) {
        state.sourceListTab = "tender";
        ensureSettingsSourceVisibleInTab();
      }
      renderSources();
      refreshIndexOverviewStatus({ silent: true });
      setText("#job-status", scope === "unlinked"
        ? "Тендеры без договора созданы."
        : "Тендеры синхронизированы.");
    }
  } catch (error) {
    const report = $("#tender-sync-report");
    const modal = $("#tender-sync-modal");
    if (modal) modal.hidden = false;
    setText("#tender-sync-modal-title", "Синхронизация не выполнена");
    setText("#tender-sync-modal-subtitle", "Проверьте доступ к папке тендеров");
    if (report) {
      report.innerHTML = "";
      const empty = document.createElement("div");
      empty.className = "empty";
      empty.textContent = apiErrorMessage(error, "Не удалось синхронизировать тендеры");
      report.append(empty);
      const details = tenderSyncErrorDetails(error);
      if (details.length) {
        const detail = document.createElement("div");
        detail.className = "tender-sync-detail";
        detail.textContent = details.join(" ");
        report.append(detail);
      }
    }
  } finally {
    if (button) {
      button.disabled = false;
      button.textContent = "Синхронизировать с Google Drive";
    }
  }
}

async function addSource(event) {
  event.preventDefault();
  const sourcePath = $("#source-path").value.trim();
  const title = $("#source-title").value.trim() || folderName(sourcePath);
  const sourceType = sourceTypeFromTab();
  if (!sourcePath) {
    setText("#job-status", "Выберите папку для текущего RAG.");
    return;
  }

  try {
    const source = await api("/api/sources", {
      method: "POST",
      body: JSON.stringify({ path: sourcePath, title, sourceType })
    });
    state.selectedSourceId = source.id;
    state.settingsSourceId = source.id;
    state.sourceListTab = sourceListTabForSource(source);
    state.addingSource = false;
    clearSourceTitleEditing();
    state.selectedSourcePath = "";
    $("#source-title").value = "";
    $("#source-path").value = "";
    await loadSources();
    const addedAsRequested = sourceListTabForSource(source) === sourceType;
    setText(
      "#job-status",
      addedAsRequested
        ? (sourceType === "tender" ? "Тендер добавлен в RAG." : "Договор добавлен в RAG.")
        : `Папка уже была добавлена как ${sourceTypeLabel(source).toLowerCase()}; открыл её в соответствующей вкладке.`
    );
  } catch (error) {
    setText("#job-status", apiErrorMessage(error, "Не удалось добавить папку в RAG"));
  }
}

async function deleteSelectedSources() {
  const targets = selectedBulkSources();
  if (!targets.length || state.deletingSourceIds.size > 0) return;

  const confirmed = window.confirm(`Удалить выбранные папки из RAG: ${targets.length}?\n\nФайлы на диске не удаляются.`);
  if (!confirmed) return;

  const targetIds = new Set(targets.map((source) => source.id));
  const previousSources = state.sources;
  state.deletingSourceIds = targetIds;
  state.sources = state.sources.filter((source) => !targetIds.has(source.id));
  if (targetIds.has(state.selectedSourceId)) state.selectedSourceId = "";
  if (targetIds.has(state.settingsSourceId)) {
    state.settingsSourceId = sourceListTabSources()[0]?.id || state.sources[0]?.id || "";
  }
  if (targetIds.has(state.sourceTitleEditSourceId)) clearSourceTitleEditing();
  if (targetIds.has(state.skippedSourceId)) {
    state.skippedSourceId = "";
    state.skipped = null;
  }
  if (targetIds.has(state.indexedFiles.sourceId)) resetIndexedFilesState();
  state.expandedIndexedFolders = new Set([""]);
  state.chatSessions.forEach((session) => {
    if (targetIds.has(session.sourceId)) session.sourceId = "";
  });
  saveChatHistory();
  resetSourcePreview();
  state.selectedSourceIds.clear();
  state.sourceSelectionMode = false;
  state.addingSource = false;
  renderSources();
  setText("#job-status", `Выбранные папки удалены из списка: ${targets.length}. Очищаю индекс в фоне...`);

  try {
    const payload = await api("/api/sources", {
      method: "DELETE",
      body: JSON.stringify({ ids: [...targetIds] })
    });
    state.sources = Array.isArray(payload.sources) ? payload.sources : await api("/api/sources");
    state.addingSource = false;
    setText("#job-status", `Выбранные папки удалены из RAG: ${targets.length}. Файлы на диске не тронуты.`);
  } catch (error) {
    try {
      state.sources = await api("/api/sources");
    } catch {
      state.sources = previousSources;
    }
    setText("#job-status", apiErrorMessage(error, "Не удалось удалить выбранные папки из RAG"));
  } finally {
    state.deletingSourceIds.clear();
    renderSources();
  }
}

function replaceSource(nextSource) {
  const index = state.sources.findIndex((source) => source.id === nextSource.id);
  if (index >= 0) {
    state.sources[index] = nextSource;
  } else {
    state.sources.push(nextSource);
  }
}

async function saveSourceTitle(sourceId, title, statusNode) {
  const nextTitle = String(title || "").trim();
  if (!nextTitle) {
    if (statusNode) statusNode.textContent = "Введите наименование.";
    return;
  }

  if (statusNode) statusNode.textContent = "Сохраняю наименование...";
  try {
    const source = await api(`/api/sources/${encodeURIComponent(sourceId)}`, {
      method: "PUT",
      body: JSON.stringify({ title: nextTitle })
    });
    replaceSource(source);
    state.settingsSourceId = source.id;
    clearSourceTitleEditing();
    renderSources();
    setText("#job-status", "Наименование сохранено.");
  } catch (error) {
    if (statusNode) statusNode.textContent = apiErrorMessage(error, "Не удалось сохранить наименование");
  }
}

async function deleteSource(sourceId) {
  if (!sourceId || state.deletingSourceIds.size > 0) return;
  const source = sourceById(sourceId);
  if (!source) return;

  const confirmed = window.confirm(`Удалить ${sourceTypeLabel(source).toLowerCase()} из RAG: ${source.title}?\n\nФайлы на диске не удаляются.`);
  if (!confirmed) return;

  const previousSources = state.sources;
  state.deletingSourceIds = new Set([sourceId]);
  renderSources();
  setText("#job-status", `Удаляю ${sourceTypeLabel(source).toLowerCase()} из RAG...`);

  try {
    const payload = await api(`/api/sources/${encodeURIComponent(sourceId)}`, { method: "DELETE" });
    state.sources = Array.isArray(payload.sources) ? payload.sources : await api("/api/sources");
    syncSelectedSourceIdsWithSources();

    if (state.selectedSourceId === sourceId) state.selectedSourceId = "";
    if (state.skippedSourceId === sourceId) {
      state.skippedSourceId = "";
      state.skipped = null;
    }
    if (state.indexedFiles.sourceId === sourceId) resetIndexedFilesState();
    state.chatSessions.forEach((session) => {
      if (session.sourceId === sourceId) session.sourceId = "";
    });
    saveChatHistory();
    resetSourcePreview();
    state.sourceSelectionMode = false;
    state.selectedSourceIds.clear();
    state.expandedIndexedFolders = new Set([""]);
    state.addingSource = false;
    if (state.sourceTitleEditSourceId === sourceId) clearSourceTitleEditing();

    if (!state.addingSource) {
      const visibleSources = sourceListTabSources();
      const nextSource = visibleSources[0] || state.sources[0] || null;
      state.settingsSourceId = nextSource?.id || "";
      if (nextSource) state.sourceListTab = sourceListTabForSource(nextSource);
    } else {
      state.settingsSourceId = "";
    }

    setText("#job-status", `${sourceTypeLabel(source)} удалён из RAG. Файлы на диске не тронуты.`);
  } catch (error) {
    state.sources = previousSources;
    setText("#job-status", apiErrorMessage(error, "Не удалось удалить папку из RAG"));
  } finally {
    state.deletingSourceIds.clear();
    renderSources();
  }
}

async function moveTenderToContracts(sourceId) {
  const source = sourceById(sourceId);
  if (!source || isContractSource(source)) return;

  const confirmed = window.confirm(`\u041f\u0435\u0440\u0435\u043d\u0435\u0441\u0442\u0438 \u0442\u0435\u043d\u0434\u0435\u0440 \u0432 \u0434\u043e\u0433\u043e\u0432\u043e\u0440\u044b: ${source.title}?\n\n\u041f\u0430\u043f\u043a\u0430 \u043e\u0441\u0442\u0430\u043d\u0435\u0442\u0441\u044f \u043d\u0430 \u0434\u0438\u0441\u043a\u0435, \u0438\u0441\u0442\u043e\u0447\u043d\u0438\u043a \u0431\u0443\u0434\u0435\u0442 \u0434\u043e\u0441\u0442\u0443\u043f\u0435\u043d \u043a\u0430\u043a \u0434\u043e\u0433\u043e\u0432\u043e\u0440.`);
  if (!confirmed) return;

  setText("#job-status", "\u041f\u0435\u0440\u0435\u043d\u043e\u0448\u0443 \u0442\u0435\u043d\u0434\u0435\u0440 \u0432 \u0434\u043e\u0433\u043e\u0432\u043e\u0440\u044b...");
  try {
    const nextSource = await api(`/api/sources/${encodeURIComponent(sourceId)}`, {
      method: "PUT",
      body: JSON.stringify({ sourceType: "contract" })
    });
    replaceSource(nextSource);
    state.settingsSourceId = nextSource.id;
    state.selectedSourceId = nextSource.id;
    state.sourceListTab = "contract";
    state.addingSource = false;
    clearSourceTitleEditing();
    state.sourceSelectionMode = false;
    state.selectedSourceIds.clear();
    if (state.indexedFiles.sourceId === sourceId) loadIndexedFiles(sourceId, { force: true, silent: true });
    renderSources();
    setText("#job-status", "\u0422\u0435\u043d\u0434\u0435\u0440 \u043f\u0435\u0440\u0435\u043d\u0435\u0441\u0451\u043d \u0432 \u0434\u043e\u0433\u043e\u0432\u043e\u0440\u044b. \u0417\u0430\u043f\u0443\u0441\u0442\u0438\u0442\u0435 \u043f\u0435\u0440\u0435\u0438\u043d\u0434\u0435\u043a\u0441\u0430\u0446\u0438\u044e, \u0447\u0442\u043e\u0431\u044b \u043e\u0431\u043d\u043e\u0432\u0438\u0442\u044c \u043c\u0435\u0442\u0430\u0434\u0430\u043d\u043d\u044b\u0435 \u0438\u043d\u0434\u0435\u043a\u0441\u0430.");
  } catch (error) {
    setText("#job-status", apiErrorMessage(error, "\u041d\u0435 \u0443\u0434\u0430\u043b\u043e\u0441\u044c \u043f\u0435\u0440\u0435\u043d\u0435\u0441\u0442\u0438 \u0442\u0435\u043d\u0434\u0435\u0440 \u0432 \u0434\u043e\u0433\u043e\u0432\u043e\u0440\u044b"));
  }
}

async function saveTenderLink(sourceId, linkedContractId, statusNode) {
  if (statusNode) statusNode.textContent = "Сохраняю привязку...";
  try {
    await api(`/api/sources/${encodeURIComponent(sourceId)}`, {
      method: "PUT",
      body: JSON.stringify({ linkedContractId })
    });
    state.sources = await api("/api/sources");
    state.settingsSourceId = sourceId;
    if (state.indexedFiles.sourceId === sourceId) loadIndexedFiles(sourceId, { force: true, silent: true });
    renderSources();
    setText("#job-status", linkedContractId ? "Тендер привязан к договору." : "Привязка тендера очищена.");
  } catch (error) {
    if (statusNode) statusNode.textContent = apiErrorMessage(error, "Не удалось сохранить привязку");
  }
}

function latestAgentRun(runs = []) {
  return Array.isArray(runs) ? runs[0] || null : null;
}

function isAgentRunActive(run) {
  return run?.status === "running";
}

function sourceIndexingActive() {
  return Boolean(state.indexPollJobId)
    || state.sources.some((source) => source?.indexStatus?.status === "running");
}

function isIndexingActive(run = state.agentStatus.latestRun) {
  return isAgentRunActive(run) || isAgentStarting(run) || sourceIndexingActive();
}

function isAgentStarting(run) {
  const requestedAt = Number(state.agentStatus.requestedAt || 0);
  if (!requestedAt) return false;
  const latestStartedAt = run?.startedAt ? new Date(run.startedAt).getTime() : 0;
  return latestStartedAt < requestedAt && Date.now() - requestedAt < 15000;
}

function formatAgentTotals(run = {}) {
  const totals = run.totals || {};
  const parts = [];
  if (Number.isFinite(Number(totals.sources))) parts.push(`папок ${totals.sources}`);
  if (totals.files) parts.push(`файлов ${totals.files}`);
  if (totals.chunks) parts.push(`фрагментов ${totals.chunks}`);
  if (totals.vectorsEmbedded) parts.push(`векторов ${totals.vectorsEmbedded}`);
  if (totals.failedSources || totals.failedFiles) {
    parts.push(`ошибок ${(totals.failedSources || 0) + (totals.failedFiles || 0)}`);
  }
  return parts.join("; ");
}

function currentAgentSourceRun(run = {}) {
  const sources = Array.isArray(run.sources) ? run.sources : [];
  return sources.find((source) => source.status === "running") || null;
}

function agentSourcePosition(run = {}, sourceRun = null) {
  const sources = Array.isArray(run.sources) ? run.sources : [];
  const totalSources = Number(run.totals?.sources || 0);
  if (!totalSources && !sources.length) return "";

  const sourceIndex = sourceRun ? sources.indexOf(sourceRun) + 1 : Math.min(sources.length, totalSources || sources.length);
  if (!sourceIndex) return totalSources ? `папок ${totalSources}` : "";
  return `папка ${sourceIndex}${totalSources ? `/${totalSources}` : ""}`;
}

function formatAgentPhase(phase = "") {
  const labels = {
    cleanup: "подготовка",
    scan: "сканирование",
    read: "чтение файлов",
    chunk: "разбор фрагментов",
    embed: "векторизация",
    vector_store: "запись в Qdrant"
  };
  return labels[phase] || "индексация";
}

function formatAgentRunStatus(run = {}) {
  if (isAgentStarting(run) && !isAgentRunActive(run)) return "Индексация запускается...";

  const currentSource = currentAgentSourceRun(run);
  const sourceLabel = agentSourcePosition(run, currentSource);
  const prefix = sourceLabel ? `Идёт индексация: ${sourceLabel}` : "Идёт индексация";
  if (!currentSource) return prefix;

  if (currentSource.phase === "embed") {
    const vectorsProcessed = Number(currentSource.vectorsProcessed || 0);
    const vectorsTotal = Number(currentSource.vectorsTotal || 0);
    return vectorsTotal
      ? `${prefix}, векторы ${vectorsProcessed}/${vectorsTotal}`
      : `${prefix}, векторизация`;
  }

  if (currentSource.phase === "ocr") {
    const ocrPage = Number(currentSource.ocrPage || 0);
    const ocrPages = Number(currentSource.ocrPages || 0);
    const processed = Number(currentSource.processed || 0);
    const total = Number(currentSource.total || 0);
    const sourceProgress = total ? `, ${processed}/${total}` : "";
    return ocrPages
      ? `${prefix}, OCR ${ocrPage || 0}/${ocrPages}${sourceProgress}`
      : `${prefix}, OCR${sourceProgress}`;
  }

  const total = Number(currentSource.total || 0);
  const processed = Number(currentSource.processed || 0);
  const phase = formatAgentPhase(currentSource.phase);
  return total ? `${prefix}, ${phase} ${processed}/${total}` : `${prefix}, ${phase}`;
}

function showAgentRunProgress(run = {}) {
  const currentSource = currentAgentSourceRun(run);
  showIndexProgress({
    ...(currentSource || {}),
    status: "running",
    phase: currentSource?.phase || "scan",
    message: formatAgentRunStatus(run)
  });
}

function updateAgentButton(run = state.agentStatus.latestRun) {
  const button = $("#agent-run-button");
  const forceButton = $("#agent-force-run-button");
  const stopButton = $("#index-stop-button");
  if (!button && !forceButton && !stopButton) return;

  const starting = isAgentStarting(run);
  const running = isIndexingActive(run);
  const title = isAgentRunActive(run) || starting ? formatAgentRunStatus(run) : "Идёт индексация";
  if (button) {
    button.disabled = running;
    button.textContent = running ? "Идёт индексация" : "Обновить индекс";
    button.title = running ? title : "Проверить изменения во всех папках";
  }
  if (forceButton) {
    forceButton.disabled = running;
    forceButton.textContent = "Полная переиндексация";
    forceButton.title = running
      ? `${title}. Дождитесь завершения индексации, чтобы запустить полную переиндексацию.`
      : "Принудительно переиндексировать все папки";
  }
  if (stopButton) {
    stopButton.hidden = !running;
    stopButton.disabled = state.indexStopRequested || !running;
    stopButton.title = state.indexStopRequested ? "Остановка уже запрошена" : "Остановить текущую индексацию";
  }
}

function clearAgentPollTimer() {
  if (!state.agentStatus.pollTimer) return;
  clearInterval(state.agentStatus.pollTimer);
  state.agentStatus.pollTimer = null;
}

function ensureAgentPollTimer() {
  if (state.agentStatus.pollTimer) return;
  state.agentStatus.pollTimer = setInterval(() => {
    refreshAgentStatus({ silent: true }).catch(() => {});
  }, 3000);
}

async function refreshAgentStatus({ silent = false } = {}) {
  const runs = await api("/api/agent/runs");
  const run = latestAgentRun(runs);
  const previous = state.agentStatus.latestRun;
  state.agentStatus.latestRun = run;
  updateAgentButton(run);
  renderAuditPanel();

  const running = isAgentRunActive(run) || isAgentStarting(run);
  if (running) {
    ensureAgentPollTimer();
    const status = formatAgentRunStatus(run);
    if (!state.indexPollJobId) showAgentRunProgress(run);
    setText("#job-status", status);
    return run;
  }

  clearAgentPollTimer();
  if (previous?.status === "running" && run?.id === previous.id) {
    if (!state.indexPollJobId) hideIndexProgress(3000);
    const summary = formatAgentTotals(run);
    const stopped = run?.status === "cancelled";
    const interrupted = run?.status === "interrupted";
    state.indexStopRequested = false;
    setText(
      "#job-status",
      interrupted
        ? "Индексация прервана; запустите заново"
        : (stopped ? "Индексация остановлена" : `Индексация завершена${summary ? `: ${summary}` : ""}`)
    );
    await loadSources();
    refreshIndexOverviewStatus({ silent: true }).catch(() => {});
    if (state.selectedSourceId) loadIndexedFiles(state.selectedSourceId, { force: true });
  } else if (!silent && run) {
    const updated = shortDateTime(run.finishedAt || run.startedAt);
    const summary = formatAgentTotals(run);
    const statusLabel = run.message || run.status;
    setText("#job-status", `Последняя индексация: ${statusLabel}${updated ? `, ${updated}` : ""}${summary ? `; ${summary}` : ""}`);
  }

  return run;
}

async function runAgent(options = {}) {
  const force = Boolean(options.force);
  if (force && typeof window.confirm === "function" &&
    !window.confirm("Запустить полную переиндексацию всех папок? Индекс будет перестроен заново, это может занять много времени.")) {
    return;
  }
  const button = $("#agent-run-button");
  const forceButton = $("#agent-force-run-button");
  if (button) button.disabled = true;
  if (forceButton) forceButton.disabled = true;
  state.agentStatus.requestedAt = Date.now();
  setText("#job-status", force ? "Запускаю полную переиндексацию всех папок" : "Проверяю изменения во всех папках");
  updateAgentButton(state.agentStatus.latestRun);

  try {
    await api("/api/agent/run", {
      method: "POST",
      body: JSON.stringify({ force })
    });
    setText("#job-status", force ? "Полная переиндексация запущена" : "Обновление индекса запущено");
    ensureAgentPollTimer();
    await refreshAgentStatus({ silent: true });
  } catch (error) {
    state.agentStatus.requestedAt = 0;
    updateAgentButton(state.agentStatus.latestRun);
    setText("#job-status", `${force ? "Не удалось запустить полную переиндексацию" : "Не удалось запустить обновление индекса"}: ${error.message}`);
  }
}

async function stopIndexing() {
  if (!isIndexingActive()) {
    setText("#job-status", "Активной индексации нет.");
    updateAgentButton();
    return;
  }

  state.indexStopRequested = true;
  updateAgentButton();
  setText("#job-status", "Останавливаю индексацию...");

  try {
    const result = await api("/api/index/stop", { method: "POST" });
    if (!result.stopRequested) {
      state.indexStopRequested = false;
      setText("#job-status", "Активной индексации нет.");
      updateAgentButton();
      return;
    }
    ensureAgentPollTimer();
    await refreshAgentStatus({ silent: true }).catch(() => {});
  } catch (error) {
    state.indexStopRequested = false;
    updateAgentButton();
    setText("#job-status", apiErrorMessage(error, "Не удалось остановить индексацию"));
  }
}

function skippedStats(job) {
  const parts = [];
  const byExt = Object.entries(job.unsupportedByExt || {})
    .filter(([, count]) => count > 0)
    .sort((a, b) => b[1] - a[1])
    .map(([ext, count]) => `${ext} ${count}`);

  if (byExt.length) parts.push(byExt.join(", "));
  if (job.temporaryFiles) parts.push(`временные ${job.temporaryFiles}`);
  if (job.excludedFiles) parts.push(`исключенные ${job.excludedFiles}`);
  if (job.unreadableDirectories) parts.push(`недоступные папки ${job.unreadableDirectories}`);
  return parts.join(", ");
}

function fileNameFromPath(value = "") {
  return String(value || "").split(/[\\/]/).pop() || String(value || "");
}

// Without this the UI reports only a failure count and the actual reason stays in the job object.
function formatJobErrors(job, limit = 2) {
  const errors = Array.isArray(job.errors) ? job.errors : [];
  if (!errors.length) return "";

  const shown = errors.slice(0, limit)
    .map((error) => `${fileNameFromPath(error.path)}: ${error.message}`)
    .join("; ");
  const total = Number(job.errorsTotal) || errors.length;
  const rest = total - Math.min(limit, errors.length);
  return rest > 0 ? `${shown}; и еще ${rest}` : shown;
}

function formatJobStatus(job) {
  const total = job.total || 0;
  const processed = job.processed || 0;
  const totalFiles = job.totalFiles || 0;

  if (job.status === "completed") {
    if (!job.failed) return "";
    const details = formatJobErrors(job);
    return details
      ? `Готово, есть ошибки: ${job.failed}. ${details}`
      : `Готово, есть ошибки: ${job.failed}`;
  }

  if (job.status === "cancelled") {
    return "Индексация остановлена";
  }

  if (job.phase === "embed") {
    const vectorsProcessed = job.vectorsProcessed || 0;
    const vectorsTotal = job.vectorsTotal || 0;
    const cachedVectors = job.vectorsCached || 0;
    const model = job.embeddingModel ? `, ${job.embeddingModel}` : "";
    return `Векторизация: ${vectorsProcessed}/${vectorsTotal}, кеш ${cachedVectors}${model}`;
  }

  if (job.phase === "vector_store") {
    const collection = job.qdrantCollection ? `: ${job.qdrantCollection}` : "";
    return `Запись в Qdrant${collection}`;
  }

  if (job.phase === "scan") {
    return totalFiles
      ? `Сканирование: найдено файлов ${totalFiles}, к индексации ${total}`
      : (job.message || "Сканирование");
  }

  const progress = total ? ` ${processed}/${total}` : "";
  const suffix = totalFiles ? `, всего файлов ${totalFiles}` : "";
  return `${job.message || job.status}${progress}${suffix}`;
}

function clampPercent(value) {
  if (!Number.isFinite(value)) return null;
  return Math.max(0, Math.min(100, value));
}

function jobProgressPercent(job = {}) {
  if (job.status === "completed") return 100;
  if (job.status === "failed") return clampPercent(job.progressPercent || 100);
  if (job.status === "cancelled") return clampPercent(job.progressPercent || 100);
  if (job.phase === "queued") return 1;
  if (job.phase === "cleanup") return 2;
  if (job.phase === "scan") return null;

  if (job.phase === "embed") {
    const total = Number(job.vectorsTotal || 0);
    if (!total) return 82;
    return clampPercent(82 + (Number(job.vectorsProcessed || 0) / total) * 18);
  }

  if (job.phase === "vector_store") return 99;

  const total = Number(job.total || job.files || 0);
  if (!total) return null;

  let processed = Number(job.processed || 0);
  const ocrPages = Number(job.ocrPages || 0);
  const ocrPage = Number(job.ocrPage || 0);
  if (job.phase === "ocr" && processed > 0 && ocrPages > 0 && ocrPage > 0) {
    processed = Math.max(0, processed - 1) + Math.min(1, ocrPage / ocrPages);
  }

  return clampPercent(8 + (processed / total) * 72);
}

function jobStatusText(job = {}) {
  const health = indexHealthStatus(job);
  const formatted = formatJobStatus(job);
  if (health === "stale") {
    const age = formatDurationShort(job.health?.progressAgeMs);
    return `\u041d\u0435\u0442 \u043e\u0431\u043d\u043e\u0432\u043b\u0435\u043d\u0438\u0439 \u043f\u0440\u043e\u0433\u0440\u0435\u0441\u0441\u0430${age ? ` ${age}` : ""}${formatted ? `: ${formatted}` : ""}`;
  }
  if (health === "interrupted") return "\u0418\u043d\u0434\u0435\u043a\u0441\u0430\u0446\u0438\u044f \u043f\u0440\u0435\u0440\u0432\u0430\u043d\u0430; \u043f\u0440\u043e\u0446\u0435\u0441\u0441 \u043d\u0435 \u043d\u0430\u0439\u0434\u0435\u043d";
  if (formatted) return formatted;
  if (job.status === "completed") return "Готово";
  if (job.status === "failed") return "Ошибка индексации";
  if (job.status === "cancelled") return "Индексация остановлена";
  return job.message || auditPhaseLabel(job.phase || job.status);
}

function indexProgressTargets() {
  return [
    {
      progress: $("#index-progress"),
      fill: $("#index-progress-fill"),
      label: $("#index-progress-label")
    },
    {
      progress: $("#settings-index-progress"),
      fill: $("#settings-index-progress-fill"),
      label: $("#settings-index-progress-label")
    },
    {
      progress: $("#audit-index-progress"),
      fill: $("#audit-index-progress-fill"),
      label: $("#audit-index-progress-label")
    }
  ].filter((target) => target.progress && target.fill && target.label);
}

function renderIndexProgressTarget({ progress, fill, label }, job = {}) {
  const percent = jobProgressPercent(job);
  const health = indexHealthStatus(job);
  const bar = progress.closest(".index-status-bar");
  progress.hidden = false;
  if (bar) {
    bar.classList.add("has-progress");
    setIndexStatusBarTone(bar, indexStatusTone(job));
  }
  progress.classList.toggle("is-indeterminate", percent == null);
  progress.classList.toggle("is-failed", job.status === "failed");
  progress.classList.toggle("is-completed", job.status === "completed");
  progress.classList.toggle("is-stalled", health === "stale" || health === "interrupted");
  fill.style.width = percent == null ? "" : `${percent}%`;
  label.textContent = health === "stale"
    ? "\u0437\u0430\u0432\u0438\u0441\u043b\u043e"
    : (health === "interrupted" ? "\u0443\u043f\u0430\u043b\u043e" : (job.status === "failed"
      ? "ошибка"
      : (job.status === "cancelled" ? "стоп" : (percent == null ? "..." : `${Math.round(percent)}%`))));
  progress.title = jobStatusText(job);
}

function resetIndexProgressTarget({ progress, fill, label }) {
  progress.hidden = true;
  progress.closest(".index-status-bar")?.classList.remove("has-progress");
  progress.classList.remove("is-indeterminate", "is-failed", "is-completed", "is-stalled");
  fill.style.width = "0%";
  label.textContent = "";
}

function showIndexProgress(job = {}) {
  const targets = indexProgressTargets();
  if (!targets.length) return;

  if (state.indexProgressHideTimer) {
    clearTimeout(state.indexProgressHideTimer);
    state.indexProgressHideTimer = null;
  }

  for (const target of targets) renderIndexProgressTarget(target, job);
  const text = jobStatusText(job);
  if (text) {
    setText("#job-status", text);
    setText("#settings-index-overview-text", text);
    const settingsOverview = $("#settings-index-overview");
    if (settingsOverview) settingsOverview.title = text;
  }
  setText("#audit-job-status", jobStatusText(job));
}

function hideIndexProgress(delayMs = 0) {
  const targets = indexProgressTargets();
  if (!targets.length) return;
  const hide = () => {
    for (const target of targets) resetIndexProgressTarget(target);
  };
  if (state.indexProgressHideTimer) clearTimeout(state.indexProgressHideTimer);
  state.indexProgressHideTimer = delayMs ? setTimeout(hide, delayMs) : null;
  if (!delayMs) hide();
}

async function pollJob(jobId) {
  if (!jobId) return;
  if (state.indexPollJobId === jobId && state.indexPollTimer) return;
  if (state.indexPollTimer) clearInterval(state.indexPollTimer);

  const status = $("#job-status");
  state.indexPollJobId = jobId;
  const timer = setInterval(async () => {
    try {
      const job = await api(`/api/jobs/${jobId}`);
      status.textContent = jobStatusText(job);
      showIndexProgress(job);
      const source = state.sources.find((item) => item.id === job.sourceId);
      if (source) {
        source.indexStatus = {
          ...source.indexStatus,
          id: job.id,
          type: job.type || "",
          status: job.status,
          phase: job.phase,
          message: job.message,
          health: job.health || null,
          force: Boolean(job.force),
          processed: job.processed || 0,
          total: job.total || job.files || 0,
          totalFiles: job.totalFiles || 0,
          eligibleFiles: job.eligibleFiles || job.files || 0,
          indexedFiles: job.indexedFiles ?? Math.max(0, (job.files ?? job.total ?? 0) - (job.failed || 0)),
          chunks: job.chunks || 0,
          vectorsTotal: job.vectorsTotal || 0,
          vectorsProcessed: job.vectorsProcessed || 0,
          vectorsCached: job.vectorsCached || 0,
          vectorsEmbedded: job.vectorsEmbedded || 0,
          reindexQueued: job.reindexQueued || 0,
          reindexRetried: job.reindexRetried || 0,
          reindexResolved: job.reindexResolved || 0,
          reindexUnresolved: job.reindexUnresolved || 0,
          reindexFailed: job.reindexFailed || 0,
          reindexRecoveredErrors: job.reindexRecoveredErrors || 0,
          embeddingEnabled: job.embeddingEnabled,
          embeddingModel: job.embeddingModel,
          vectorStoreProvider: job.vectorStoreProvider || "",
          qdrantAvailable: job.qdrantAvailable,
          qdrantCollection: job.qdrantCollection || "",
          qdrantPoints: optionalNumber(job.qdrantPoints),
          vectorCount: optionalNumber(job.vectorCount),
          qdrantError: job.qdrantError || "",
          warning: job.warning || "",
          failed: job.failed || 0,
          skippedTotal: (job.unsupportedFiles || 0) + (job.temporaryFiles || 0) + (job.excludedFiles || 0),
          unsupportedFiles: job.unsupportedFiles || 0,
          temporaryFiles: job.temporaryFiles || 0,
          excludedFiles: job.excludedFiles || 0,
          unsupportedByExt: job.unsupportedByExt || {},
          googleContextLinks: job.googleContextLinks || 0,
          currentGoogleContextLinkId: job.currentGoogleContextLinkId || "",
          currentGoogleContextTitle: job.currentGoogleContextTitle || "",
          currentFileTitle: job.currentFileTitle || "",
          currentFileRelativePath: job.currentFileRelativePath || "",
          currentFileExtension: job.currentFileExtension || "",
          startedAt: job.startedAt,
          updatedAt: job.updatedAt,
          finishedAt: job.finishedAt
        };
        renderSources();
        updateAgentButton();
        if (
          job.status === "running"
          && state.indexedFiles.sourceId === job.sourceId
          && !state.indexedFiles.loading
          && Date.now() - Number(state.indexedFiles.refreshedAt || 0) > 5000
        ) {
          loadIndexedFiles(job.sourceId, { force: true, silent: true });
        }
      }
      if (["completed", "failed", "cancelled"].includes(job.status)) {
        clearInterval(timer);
        if (state.indexPollTimer === timer) {
          state.indexPollTimer = null;
          state.indexPollJobId = "";
        }
        state.indexStopRequested = false;
        showIndexProgress(job);
        hideIndexProgress(job.status === "completed" ? 1800 : 5000);
        loadSources();
        updateAgentButton();
        refreshIndexOverviewStatus({ silent: true });
        if (job.status === "completed") refreshIntegrationsStatus();
        if (job.status === "completed") loadIndexedFiles(job.sourceId, { force: true });
        if (!$("#skipped-modal").hidden) loadSkippedFiles();
      }
    } catch (error) {
      clearInterval(timer);
      if (state.indexPollTimer === timer) {
        state.indexPollTimer = null;
        state.indexPollJobId = "";
      }
      state.indexStopRequested = false;
      updateAgentButton();
      status.textContent = error.message;
      hideIndexProgress(3000);
    }
  }, 1200);
  state.indexPollTimer = timer;
}

async function indexSelected(force = false, sourceIdOverride = "") {
  const sourceId = sourceIdOverride || $("#source-select").value;
  if (!sourceId) return;
  const source = state.sources.find((item) => item.id === sourceId);
  const previousIndexStatus = source ? { ...(source.indexStatus || {}) } : null;
  if (source) {
    source.indexStatus = {
      ...(source.indexStatus || {}),
      status: "running",
      phase: "queued",
      message: force
        ? "\u041f\u043e\u043b\u043d\u0430\u044f \u043f\u0435\u0440\u0435\u0438\u043d\u0434\u0435\u043a\u0441\u0430\u0446\u0438\u044f \u0432 \u043e\u0447\u0435\u0440\u0435\u0434\u0438"
        : "\u0418\u043d\u0434\u0435\u043a\u0441\u0430\u0446\u0438\u044f \u0432 \u043e\u0447\u0435\u0440\u0435\u0434\u0438",
      force: Boolean(force),
      processed: 0,
      total: Number(source.indexStatus?.total || source.indexStatus?.eligibleFiles || 0),
      currentFileTitle: "",
      currentFileRelativePath: "",
      currentFileExtension: "",
      startedAt: new Date().toISOString()
    };
  }
  if (state.indexedFiles.sourceId === sourceId) {
    resetIndexedFilesState(sourceId);
    renderIndexedFilesPanel();
  }
  if (source) renderSources();
  updateAgentButton();
  $("#job-status").textContent = force ? "Запуск полной переиндексации" : "Запуск индексации";
  showIndexProgress({ status: "running", phase: "queued", message: force ? "Полная переиндексация в очереди" : "Индексация в очереди" });
  let job;
  try {
    job = await api(`/api/sources/${sourceId}/index`, {
      method: "POST",
      body: JSON.stringify({ force })
    });
  } catch (error) {
    const message = error?.message === "Failed to fetch"
      ? "Сервер Local RAG недоступен. Запустите npm run dev и попробуйте снова."
      : `Не удалось запустить индексацию: ${error.message}`;
    $("#job-status").textContent = apiErrorMessage(error, "Не удалось запустить индексацию");
    hideIndexProgress(5000);
    if (source) source.indexStatus = previousIndexStatus || source.indexStatus;
    renderSources();
    updateAgentButton();
    return;
  }
  showIndexProgress(job);
  if (source) {
    source.indexStatus = {
      ...source.indexStatus,
      id: job.id,
      type: job.type || "",
      status: job.status,
      phase: job.phase,
      message: job.message,
      health: job.health || null,
      force: Boolean(job.force),
      processed: job.processed || 0,
      total: job.total || 0,
      currentFileTitle: job.currentFileTitle || "",
      currentFileRelativePath: job.currentFileRelativePath || "",
      currentFileExtension: job.currentFileExtension || "",
      startedAt: job.startedAt
    };
    renderSources();
    updateAgentButton();
  }
  pollJob(job.id);
}

function forceReindexSelected() {
  const sourceId = state.skippedSourceId || state.selectedSourceId;
  const source = state.sources.find((item) => item.id === sourceId);
  const label = source ? source.title : "выбранной папки";
  if (typeof window.confirm === "function" &&
    !window.confirm(`Принудительно переиндексировать все файлы «${label}»? Существующий индекс будет перестроен.`)) {
    return;
  }
  closeSkippedModal();
  indexSelected(true, sourceId);
}

function scrollChatToBottom() {
  const thread = $("#chat-thread");
  thread.scrollTop = thread.scrollHeight;
}

function resizeQuestionField() {
  const input = $("#question");
  input.style.height = "auto";
  const minHeight = Number.parseFloat(getComputedStyle(input).minHeight) || 38;
  const targetHeight = input.value.trim() ? Math.min(input.scrollHeight, 168) : minHeight;
  input.style.height = `${targetHeight}px`;
}

function setChatBusy(isBusy) {
  $("#question").disabled = isBusy;
  $("#send-button").disabled = isBusy;
  $("#stop-button").hidden = !isBusy;
}

function thinkingStatusText() {
  const elapsed = Math.floor((Date.now() - state.chatRequest.startedAt) / 1000);
  const usage = state.llmUsage;
  const active = usage?.activeRequestsCount || 0;
  const request = usage?.activeRequests?.[0];

  if (active > 0) {
    const model = request?.model || state.llm.model || "LM Studio";
    const provider = request?.providerLabel || "LM Studio";
    const timeout = request?.timeoutSeconds ? `, жду до ${formatRouteWait(request.timeoutSeconds)}` : "";
    const seconds = elapsed ? ` · ${elapsed} сек.` : "";
    if (request?.phase === "checking_model") {
      return `${provider}: проверяю модель ${model}${seconds}`;
    }
    if (request?.phase === "loading_model") {
      return `${provider}: загружаю модель ${model}${seconds}`;
    }
    if (request?.phase === "reloading_model") {
      return `${provider}: перезагружаю модель ${model} с большим контекстом${seconds}`;
    }
    if (request?.phase === "compacting_context") {
      return `${provider}: сжимаю контекст для модели ${model}${seconds}`;
    }
    return `${provider} генерирует ответ (${model}${timeout})${seconds}`;
  }

  if (elapsed < 2) return "Ищу релевантные фрагменты в индексе...";
  if (elapsed < 5) return "Готовлю контекст и отправляю запрос в LM Studio...";
  if (elapsed < 15) return "Жду ответ LM Studio...";
  return `LM Studio еще считает ответ · ${elapsed} сек.`;
}

function updateThinkingStatus(message) {
  if (!state.chatRequest.controller) return;
  setMessageText(message, thinkingStatusText());
}

function startThinkingStatus(message) {
  stopThinkingStatus();
  state.chatRequest.startedAt = Date.now();
  updateThinkingStatus(message);
  refreshLmUsage().finally(() => updateThinkingStatus(message));
  state.chatRequest.statusTimer = setInterval(() => {
    if (!state.chatRequest.controller) return;
    refreshLmUsage().finally(() => updateThinkingStatus(message));
  }, 1100);
}

function stopThinkingStatus() {
  if (state.chatRequest.statusTimer) {
    clearInterval(state.chatRequest.statusTimer);
    state.chatRequest.statusTimer = null;
  }
}

function stopChat() {
  if (state.chatRequest.controller) {
    state.chatRequest.controller.abort();
  }
}

function clearChatRequest() {
  stopThinkingStatus();
  state.chatRequest.controller = null;
  state.chatRequest.pendingMessage = null;
  state.chatRequest.startedAt = 0;
  setChatBusy(false);
  refreshLmUsage();
}

function ragRetrievalMode(debug = {}) {
  if (debug.qdrantUsed) return debug.rerankerUsed ? "Qdrant + lexical RRF + reranker" : "Qdrant + lexical RRF";
  if (debug.vectorCandidateCount > 0) return debug.rerankerUsed ? "vectors.json + lexical + reranker" : "vectors.json + lexical";
  return debug.rerankerUsed ? "lexical + reranker" : "lexical";
}

function appendDebugRow(container, label, value) {
  if (value === undefined || value === null || value === "") return;
  const row = document.createElement("div");
  row.className = "rag-debug-row";
  const key = document.createElement("span");
  key.textContent = label;
  const text = document.createElement("strong");
  text.textContent = String(value);
  row.append(key, text);
  container.append(row);
}

function renderRagDebugPanel(message, debug = null, sources = []) {
  message.querySelector(".rag-debug")?.remove();
  if (!debug) return;

  const details = document.createElement("details");
  details.className = "rag-debug";
  const summary = document.createElement("summary");
  summary.textContent = "Диагностика RAG";
  details.append(summary);

  const grid = document.createElement("div");
  grid.className = "rag-debug-grid";
  appendDebugRow(grid, "Проект", debug.matchedSource?.title || "Авто");
  appendDebugRow(grid, "Provider", [debug.selectedBaseUrlKind || debug.selectedProvider, debug.model].filter(Boolean).join(" · "));
  appendDebugRow(grid, "Retrieval", ragRetrievalMode(debug));
  appendDebugRow(grid, "Candidates", `vector ${debug.vectorCandidateCount} · lexical ${debug.lexicalCandidateCount} · merged ${debug.mergedCandidateCount}`);
  appendDebugRow(grid, "Sources", debug.finalSourceCount);
  appendDebugRow(grid, "Chars", `prompt ${debug.promptChars} · answer ${debug.answerChars}`);
  appendDebugRow(grid, "Timings", `retrieval ${formatMs(debug.timings?.retrievalMs)} · rerank ${formatMs(debug.timings?.rerankMs)} · llm ${formatMs(debug.timings?.llmMs)} · total ${formatMs(debug.timings?.totalMs)}`);
  details.append(grid);

  const topSources = sources.slice(0, 5);
  if (topSources.length) {
    const list = document.createElement("ol");
    list.className = "rag-debug-sources";
    for (const source of topSources) {
      const item = document.createElement("li");
      const score = Number.isFinite(Number(source.score)) ? ` · score ${Number(source.score).toFixed(3)}` : "";
      item.textContent = `${source.citationLabel || source.title || fileName(source.path)}${score}`;
      list.append(item);
    }
    details.append(list);
  }

  message.append(details);
}

function setMessageRagDebug(message, payload = {}, sources = []) {
  const debug = compactRagDebug(payload);
  renderRagDebugPanel(message, debug, sources);
  const record = findMessageRecord(message);
  if (record) {
    record.ragDebug = debug;
    touchActiveChat();
  }
}

async function generateChatTitleForSession(sessionId, question, answer, matchedSource = null) {
  const session = state.chatSessions.find((item) => item.id === sessionId);
  if (!session || session.archivedAt || session.titleSource === "llm") return;

  try {
    const payload = await api("/api/chat/title", {
      method: "POST",
      body: JSON.stringify({
        question,
        answer,
        sourceTitle: matchedSource?.title || sourceTitle(session.sourceId)
      })
    });
    const title = cleanChatTitle(payload.title);
    if (!title) return;
    session.title = title;
    session.titleSource = payload.fallbackUsed ? "fallback" : "llm";
    saveChatHistory();
    renderChatHistory();
  } catch {
    // Title generation is a convenience; the chat answer should stay untouched.
  }
}

function applyMatchedSource(match) {
  if (!match?.id || !state.sources.some((source) => source.id === match.id)) return;
  state.selectedSourceId = match.id;
  const session = activeChat();
  if (session) {
    session.sourceId = match.id;
    touchActiveChat();
  }
  renderSources();
}

// Баннер авто-определения проекта в потоке чата: показывает определённый проект
// и даёт явное действие «Закрепить» (фиксирует выбор в селекторе).
function renderAutoProjectBanner(referenceMessage, match) {
  const thread = $("#chat-thread");
  if (!thread || !match?.id || !match?.title) return;
  if (!state.sources.some((source) => source.id === match.id)) return;
  thread.querySelectorAll(".auto-project-banner").forEach((el) => el.remove());

  const banner = document.createElement("div");
  banner.className = "auto-project-banner";

  const pill = document.createElement("span");
  pill.className = "auto-project-pill";
  pill.textContent = "Авто по вопросу";

  const text = document.createElement("span");
  text.className = "auto-project-text";
  text.append("Проект определён по вопросу: ");
  const strong = document.createElement("strong");
  strong.textContent = match.title;
  text.append(strong);

  const pin = document.createElement("button");
  pin.type = "button";
  pin.className = "auto-project-pin btn-small";
  pin.textContent = "Закрепить";
  pin.title = "Закрепить проект для последующих вопросов";
  pin.addEventListener("click", () => {
    applyMatchedSource(match);
    banner.classList.add("is-pinned");
    pin.replaceWith(Object.assign(document.createElement("span"), {
      className: "auto-project-pinned",
      textContent: "Закреплён"
    }));
  });

  banner.append(pill, text, pin);
  if (referenceMessage && referenceMessage.parentNode === thread) {
    thread.insertBefore(banner, referenceMessage);
  } else {
    thread.append(banner);
  }
}

function sourcesByCitationNumber(sources = []) {
  const byNumber = new Map();
  sources.forEach((source, index) => {
    const numbers = Array.isArray(source.citationNumbers) && source.citationNumbers.length
      ? source.citationNumbers
      : [source.sourceNumber || index + 1];

    for (const value of numbers) {
      const sourceNumber = Number(value);
      if (Number.isInteger(sourceNumber) && sourceNumber > 0) {
        byNumber.set(sourceNumber, { ...source, sourceNumber });
      }
    }
  });
  return byNumber;
}

function renderMessageTextContent(message, text, sources = []) {
  const textElement = message.querySelector(".message-text");
  if (!textElement) return;

  textElement.innerHTML = "";
  const value = String(text || "");
  const byNumber = sourcesByCitationNumber(sources);
  const citationPattern = /\[(\d+)\]/g;
  let cursor = 0;
  let match;

  while ((match = citationPattern.exec(value))) {
    if (match.index > cursor) {
      textElement.append(document.createTextNode(value.slice(cursor, match.index)));
    }

    const citationText = match[0];
    const sourceNumber = Number(match[1]);
    const source = byNumber.get(sourceNumber);
    if (source) {
      const citationEvidence = citationEvidenceForNumber(value, sourceNumber);
      const previewSource = citationEvidence ? { ...source, citationEvidence } : source;
      const button = document.createElement("button");
      button.type = "button";
      button.className = "source-citation";
      button.textContent = citationText;
      button.title = source.citationLabel || source.title || fileName(source.path);
      button.addEventListener("click", () => {
        document.querySelectorAll(".source-citation.active").forEach((citation) => citation.classList.remove("active"));
        button.classList.add("active");
        openSourcePreview(previewSource);
      });
      textElement.append(button);
    } else {
      const span = document.createElement("span");
      span.className = "source-citation missing";
      span.textContent = citationText;
      textElement.append(span);
    }

    cursor = match.index + citationText.length;
  }

  if (cursor < value.length) {
    textElement.append(document.createTextNode(value.slice(cursor)));
  }
}

function messageMetaPart(text) {
  const span = document.createElement("span");
  span.className = "message-meta-part";
  span.textContent = text;
  return span;
}

function messageMetaPill(label, tone, title = "") {
  const pill = document.createElement("span");
  pill.className = `message-meta-pill message-meta-pill--${tone}`;
  pill.textContent = label;
  if (title) pill.title = title;
  return pill;
}

function syncMessageMetaElement(message, text) {
  message.querySelector(".message-meta")?.remove();
  const value = String(text || "").trim();
  if (!value) return;

  const meta = document.createElement("div");
  meta.className = "message-meta";
  // Мета хранится строкой (переживает reload); провайдер отображаем пилюлей.
  for (const part of value.split(" · ")) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    if (/^Provider:\s*local/i.test(trimmed)) {
      meta.append(messageMetaPill("Локально", "ok", trimmed));
      if (/fallback/i.test(trimmed)) meta.append(messageMetaPart("fallback"));
    } else if (/^Provider:\s*remote/i.test(trimmed)) {
      meta.append(messageMetaPill("Удалённо", "warning", trimmed));
      if (/fallback/i.test(trimmed)) meta.append(messageMetaPart("fallback"));
    } else {
      meta.append(messageMetaPart(trimmed));
    }
  }
  message.append(meta);
}

function setMessageMeta(message, text, options = {}) {
  syncMessageMetaElement(message, text);
  if (options.persist === false) return;

  const record = findMessageRecord(message);
  if (record) {
    record.meta = String(text || "").trim();
    touchActiveChat();
  }
}

function createMessageElement(role, text, messageId = "", meta = "", sources = [], createdAt = "") {
  const message = document.createElement("article");
  message.className = `message ${role}`;
  if (messageId) message.dataset.messageId = messageId;
  const timestamp = formatFullDateTime(createdAt);
  if (timestamp) message.title = timestamp;
  message.innerHTML = `
    <div class="message-text"></div>
  `;
  renderMessageTextContent(message, text, sources);
  syncMessageMetaElement(message, meta);
  return message;
}

function renderActiveChat() {
  const thread = $("#chat-thread");
  const session = ensureActiveChat();
  thread.innerHTML = "";

  if (!session.messages?.length) {
    thread.innerHTML = '<div class="empty chat-empty">Задайте вопрос с названием или адресом проекта. Например: «Балчуг, Садовническая — какие основные условия договора?»</div>';
    return;
  }

  for (const item of session.messages) {
    const message = createMessageElement(item.role, item.text, item.id, item.meta || "", item.sources || [], item.createdAt || item.updatedAt || "");
    thread.append(message);
    if (item.sources?.length) {
      renderMessageSources(message, item.sources, item.text, { autoOpen: false, persist: false });
    }
    renderRagDebugPanel(message, item.ragDebug || null, item.sources || []);
  }

  scrollChatToBottom();
}

function appendMessage(role, text, options = {}) {
  const thread = $("#chat-thread");
  thread.querySelector(".chat-empty")?.remove();

  const shouldPersist = options.persist !== false;
  const record = shouldPersist ? addMessageRecord(role, text) : null;
  const message = createMessageElement(role, text, record?.id || "", "", [], record?.createdAt || "");
  thread.append(message);
  scrollChatToBottom();
  return message;
}

function setMessageText(message, text, options = {}) {
  renderMessageTextContent(message, text, options.sources || []);
  const record = findMessageRecord(message);
  if (record) {
    record.text = text;
    touchActiveChat();
  }
  scrollChatToBottom();
}

function renderMessageSources(message, sources = [], answerText = "", options = {}) {
  message.querySelector(".message-sources")?.remove();
  const cited = citedSourceNumbers(answerText);
  const enriched = sources.map((source, index) => {
    const sourceNumber = index + 1;
    const citedIndex = cited.indexOf(sourceNumber);
    return {
      ...source,
      sourceNumber,
      citationEvidence: citationEvidenceForNumber(answerText, sourceNumber) || source.citationEvidence || "",
      citedRank: citedIndex >= 0 ? citedIndex : undefined
    };
  });
  const unique = uniqueSources(enriched);
  const displaySources = displayedSourcesForAnswer(unique, answerText, { maxUncited: options.maxVisibleSources || 8 });
  if (!displaySources.length) return;

  const block = document.createElement("div");
  block.className = "message-sources";

  const title = document.createElement("div");
  title.className = "message-sources-title";
  title.textContent = cited.length ? "Использованные источники" : "Найденные файлы";
  block.append(title);

  displaySources.forEach((source, index) => {
    const link = document.createElement("a");
    link.href = "#source-preview";
    link.className = "source-link";
    const citationNumbers = Array.isArray(source.citationNumbers) && source.citationNumbers.length
      ? source.citationNumbers
      : (source.sourceNumber ? [source.sourceNumber] : []);
    const citation = citationNumbers.length ? ` ${citationNumbers.map((number) => `[${number}]`).join(", ")}` : "";
    const label = document.createElement("span");
    label.className = "source-link-label";
    label.textContent = `${index + 1}. ${source.citationLabel || source.title || fileName(source.path)}${citation}`;
    link.append(label);

    const project = source.sourceTitle || source.citationTarget?.sourceTitle || source.metadata?.sourceTitle || "";
    if (project) {
      const projectMeta = document.createElement("span");
      projectMeta.className = "source-link-project";
      projectMeta.textContent = `Проект: ${project}`;
      link.append(projectMeta);
    }
    link.addEventListener("click", (event) => {
      event.preventDefault();
      openSourcePreview(source);
    });
    block.append(link);
  });

  message.append(block);
  if (options.persist !== false) {
    const record = findMessageRecord(message);
    if (record) {
      record.sources = compactSources(displaySources);
      touchActiveChat();
    }
  }
  if (options.autoOpen === true) openSourcePreview(displaySources[0]);
  scrollChatToBottom();
}

function previewMetaChip(label, variant = "") {
  const chip = document.createElement("span");
  chip.className = `preview-chip${variant ? ` preview-chip--${variant}` : ""}`;
  chip.textContent = label;
  return chip;
}

async function openPreviewSystemFile(action, file) {
  try {
    await api("/api/files/system-open", {
      method: "POST",
      body: JSON.stringify({
        action,
        sourceId: file.sourceId || "",
        fileId: file.fileId || "",
        path: file.path || ""
      })
    });
  } catch (error) {
    const preview = $("#source-preview");
    if (!preview) return;
    const note = document.createElement("div");
    note.className = "hint preview-status";
    note.textContent = apiErrorMessage(error, action === "reveal"
      ? "Не удалось открыть файл в проводнике"
      : "Не удалось открыть оригинальный файл");
    preview.append(note);
  }
}

function renderPreviewShell(source, statusText = "") {
  setSourceViewerOpen(true);
  const displayTitle = source.fileLabel || source.pathLabel || source.title || source.citationTarget?.fileLabel || fileName(source.path);
  $("#preview-title").textContent = displayTitle;
  const preview = $("#source-preview");
  preview.innerHTML = "";

  const meta = document.createElement("div");
  meta.className = "preview-meta";
  const citationNumber = Number(source.sourceNumber);
  if (Number.isInteger(citationNumber) && citationNumber > 0) {
    meta.append(previewMetaChip(String(citationNumber), "num"));
  }
  if (source.sourceTitle) meta.append(previewMetaChip(source.sourceTitle, "source"));
  const fileLabel = source.citationLabel || source.citationTarget?.label || source.pathLabel || source.fileLabel || fileName(source.path);
  if (fileLabel && fileLabel !== source.sourceTitle) meta.append(previewMetaChip(fileLabel));
  if (source.sectionTitle) meta.append(previewMetaChip(`раздел "${source.sectionTitle}"`));
  if (source.pageStart) {
    meta.append(previewMetaChip(`стр. ${source.pageEnd && source.pageEnd > source.pageStart ? `${source.pageStart}-${source.pageEnd}` : source.pageStart}`));
  }
  if (source.sheetName) meta.append(previewMetaChip(`лист "${source.sheetName}"`));
  if (source.references > 1) meta.append(previewMetaChip(`фрагментов ${source.references}`));
  preview.append(meta);

  const systemPath = source.path || source.citationTarget?.path || "";
  const systemFileId = source.fileId || source.citationTarget?.fileId || "";
  const systemSourceId = source.sourceId || source.citationTarget?.sourceId || state.selectedSourceId || "";
  if (systemPath || systemFileId) {
    const actions = document.createElement("div");
    actions.className = "preview-actions";
    const fileRef = { path: systemPath, fileId: systemFileId, sourceId: systemSourceId };
    const openButton = document.createElement("button");
    openButton.type = "button";
    openButton.className = "secondary preview-action-button btn-small";
    openButton.textContent = "Открыть файл";
    openButton.addEventListener("click", () => openPreviewSystemFile("open", fileRef));
    const revealButton = document.createElement("button");
    revealButton.type = "button";
    revealButton.className = "secondary preview-action-button btn-small";
    revealButton.textContent = "Показать в Explorer";
    revealButton.addEventListener("click", () => openPreviewSystemFile("reveal", fileRef));
    actions.append(openButton, revealButton);
    preview.append(actions);
  }

  if (statusText) {
    const status = document.createElement("div");
    status.className = "hint preview-status";
    status.textContent = statusText;
    preview.append(status);
  }

  appendOcrQualitySection(preview, source);

  return preview;
}

function renderPreviewText(source, text, statusText = "") {
  const preview = renderPreviewShell(source, statusText);
  const body = document.createElement("pre");
  body.className = "preview-body";
  body.textContent = text || source.text || source.snippet || "Фрагмент пустой.";
  preview.append(body);
}

function appendPreviewNote(preview, text) {
  const note = document.createElement("div");
  note.className = "hint preview-status";
  note.textContent = text;
  preview.append(note);
}

function ocrPageVerdict(page) {
  if (page.failed) return { label: "ошибка", variant: "error" };
  if (page.usable === false) return { label: "отбракована", variant: "error" };
  if (page.usable === true) return { label: "принята", variant: "ok" };
  return { label: "-", variant: "" };
}

function ocrPageReasons(page) {
  const reasons = (page.warnings || []).map((warning) => INDEXED_QUALITY_REASON_LABELS[warning] || warning);
  if (page.error) reasons.push(page.error);
  return reasons.join("; ");
}

// The per-page OCR stats already travel with every indexed file; without this table the only
// way to see which pages failed was to read the manifest by hand.
function appendOcrQualitySection(preview, source) {
  const recognition = source.recognition || {};
  const pages = Array.isArray(recognition.ocrPageStats) ? recognition.ocrPageStats : [];
  if (!pages.length) return;

  const accepted = pages.filter((page) => page.usable === true).length;
  const rejected = pages.filter((page) => page.usable === false && !page.failed).length;
  const failed = pages.filter((page) => page.failed).length;

  const details = document.createElement("details");
  details.className = "ocr-quality";
  // Open by default when something is wrong: that is exactly when it needs looking at.
  details.open = rejected > 0 || failed > 0;

  const summary = document.createElement("summary");
  summary.className = "ocr-quality-summary";
  const summaryParts = [`страниц ${pages.length}`, `принято ${accepted}`];
  if (rejected) summaryParts.push(`отбраковано ${rejected}`);
  if (failed) summaryParts.push(`ошибок ${failed}`);
  if (Number.isFinite(Number(recognition.ocrConfidence))) {
    summaryParts.push(`сред. ${Math.round(Number(recognition.ocrConfidence))}%`);
  }
  if (Number.isFinite(Number(recognition.ocrScale))) {
    summaryParts.push(`scale ${recognition.ocrScale} (~${Math.round(Number(recognition.ocrScale) * 72)} DPI)`);
  }
  summary.textContent = `Качество OCR: ${summaryParts.join(", ")}`;
  details.append(summary);

  const table = document.createElement("table");
  table.className = "ocr-quality-table";
  table.innerHTML = `
    <thead>
      <tr>
        <th>Стр.</th>
        <th>Символов</th>
        <th>Слов</th>
        <th>Уверенность</th>
        <th>Вердикт</th>
        <th>Причина</th>
      </tr>
    </thead>
    <tbody></tbody>
  `;

  const body = table.querySelector("tbody");
  for (const page of pages) {
    const verdict = ocrPageVerdict(page);
    const row = document.createElement("tr");
    if (verdict.variant) row.className = `ocr-quality-row--${verdict.variant}`;

    const confidence = Number.isFinite(Number(page.confidence)) ? `${Math.round(Number(page.confidence))}%` : "-";
    for (const value of [page.page, page.chars ?? 0, page.words ?? 0, confidence, verdict.label, ocrPageReasons(page)]) {
      const cell = document.createElement("td");
      cell.textContent = String(value ?? "");
      row.append(cell);
    }
    body.append(row);
  }

  details.append(table);
  preview.append(details);
}

function simplePreviewFocus(markdown, focusText) {
  const source = String(markdown || "");
  const query = String(focusText || "").replace(/\[(\d+)\]/g, " ").replace(/\s+/g, " ").trim();
  if (!source || !query) return { found: false };

  let start = source.toLowerCase().indexOf(query.toLowerCase());
  let text = query;
  if (start < 0) {
    const tokens = Array.from(query.matchAll(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}|[\p{L}\p{N}_@.+%-]{4,}/giu), (match) => match[0]);
    const positions = tokens
      .map((token) => {
        const tokenStart = source.toLowerCase().indexOf(token.toLowerCase());
        return tokenStart >= 0 ? { start: tokenStart, end: tokenStart + token.length } : null;
      })
      .filter(Boolean);
    if (!positions.length) return { found: false };
    start = Math.min(...positions.map((item) => item.start));
    const end = Math.max(...positions.map((item) => item.end));
    text = source.slice(start, end);
    return { found: true, start, end, text };
  }

  return { found: true, start, end: start + query.length, text };
}

function previewLineWindow(markdown, focus, before = 520, after = 760) {
  const source = String(markdown || "");
  const start = Number(focus?.start);
  const end = Number(focus?.end);
  if (!focus?.found || !Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
    return {
      text: source,
      focus: { found: false },
      truncatedBefore: false,
      truncatedAfter: false,
      hiddenLinesBefore: 0,
      hiddenLinesAfter: 0
    };
  }

  const rawStart = Math.max(0, start - before);
  const rawEnd = Math.min(source.length, end + after);
  const previousBreak = source.lastIndexOf("\n", rawStart);
  const nextBreak = source.indexOf("\n", rawEnd);
  const windowStart = previousBreak >= 0 ? previousBreak + 1 : 0;
  const windowEnd = nextBreak >= 0 ? nextBreak : source.length;

  return {
    text: source.slice(windowStart, windowEnd),
    focus: {
      ...focus,
      start: start - windowStart,
      end: end - windowStart
    },
    truncatedBefore: windowStart > 0,
    truncatedAfter: windowEnd < source.length,
    hiddenLinesBefore: countLines(source.slice(0, windowStart)),
    hiddenLinesAfter: countLines(source.slice(windowEnd))
  };
}

// Страниц в превью нет (файл режется по символам), поэтому объём скрытого
// текста считаем в строках.
function countLines(text) {
  const value = String(text || "");
  if (!value.trim()) return 0;
  return value.split("\n").filter((line) => line.trim()).length;
}

function hiddenTextNote(direction, hiddenLines) {
  const count = Number(hiddenLines || 0);
  if (!Number.isFinite(count) || count <= 0) {
    return `${direction} есть скрытый текст файла; открыт участок вокруг цитаты.`;
  }
  const noun = pluralRu(count, "строка", "строки", "строк");
  return `${direction} скрыто ${count} ${noun} файла; открыт участок вокруг цитаты.`;
}

function renderPreviewMarkdown(source, payload) {
  const preview = renderPreviewShell(source);
  const exactText = payload.targetMatched ? (payload.excerpt || payload.text || "") : "";
  const markdown = exactText || payload.markdown || source.text || source.snippet || "Фрагмент пустой.";

  const body = document.createElement("pre");
  body.className = "preview-body";

  const rawFocus = payload.focus || {};
  const fallbackFocus = simplePreviewFocus(markdown, source.citationEvidence || source.citationTarget?.citationEvidence || "");
  const focus = rawFocus.found ? rawFocus : fallbackFocus;
  const focusedWindow = focus.found ? previewLineWindow(markdown, focus) : null;
  const displayMarkdown = focusedWindow?.text || markdown;
  const displayFocus = focusedWindow?.focus || focus;
  const start = Number(displayFocus.start);
  const end = Number(displayFocus.end);
  const hasFocus = focus.found
    && Number.isFinite(start)
    && Number.isFinite(end)
    && start >= 0
    && end > start
    && end <= displayMarkdown.length;

  if (payload.targetMatched && hasFocus) {
    preview.querySelector(".preview-meta")?.append(previewMetaChip("Точное совпадение", "exact"));
  }

  if (payload.targetMatched) {
    appendPreviewNote(
      preview,
      hasFocus
        ? "Показан фрагмент по выбранной цитате."
        : "Показан найденный chunk; точная строка не выделена."
    );
  } else if (payload.fallbackReason) {
    appendPreviewNote(preview, `Точный chunk не передан; открыт fallback: ${payload.fallbackReason}.`);
  }

  if (payload.truncatedBefore || focusedWindow?.truncatedBefore) {
    appendPreviewNote(preview, hiddenTextNote("Выше", focusedWindow?.hiddenLinesBefore));
  }

  if (hasFocus) {
    body.append(document.createTextNode(displayMarkdown.slice(0, start)));
    const highlight = document.createElement("mark");
    highlight.className = "preview-highlight";
    highlight.textContent = displayMarkdown.slice(start, end);
    body.append(highlight);
    body.append(document.createTextNode(displayMarkdown.slice(end)));
  } else {
    body.textContent = displayMarkdown;
  }

  preview.append(body);

  if ((!exactText && payload.truncatedAfter) || focusedWindow?.truncatedAfter) {
    appendPreviewNote(preview, hiddenTextNote("Ниже", focusedWindow?.hiddenLinesAfter));
  }

  if (hasFocus) {
    requestAnimationFrame(() => {
      body.querySelector(".preview-highlight")?.scrollIntoView({ block: "center", inline: "nearest" });
    });
  }
}

async function openSourcePreview(source) {
  const requestId = ++state.previewRequestId;
  setSourceViewerOpen(true);
  renderPreviewText(source, source.text || source.snippet, "Загружаю Markdown из локального кэша...");

  try {
    const target = source.citationTarget || {};
    const sourceId = source.sourceId || target.sourceId || "";
    const chunkId = source.chunkId || target.chunkId || source.id || "";
    const fileId = source.fileId || target.fileId || "";
    const params = new URLSearchParams({ sourceId });
    if (chunkId) params.set("chunkId", chunkId);
    else if (fileId) params.set("fileId", fileId);
    else if (source.path) params.set("path", source.path);
    const focusText = String(source.citationEvidence || source.citationTarget?.citationEvidence || "").trim();
    if (focusText) params.set("focusText", focusText.slice(0, 900));

    const payload = await api(`/api/files/preview?${params}`);
    if (requestId !== state.previewRequestId) return;
    renderPreviewMarkdown(source, payload);
  } catch (error) {
    if (requestId !== state.previewRequestId) return;
    renderPreviewText(source, source.text || source.snippet, `Не удалось открыть Markdown-кэш: ${error.message}. Показываю найденный фрагмент.`);
  }
}

async function chat(event) {
  event.preventDefault();
  if (state.chatRequest.controller) return;

  const question = $("#question").value.trim();
  if (!question) return;

  const sourceId = $("#source-select").value;
  const wasAutoMode = !sourceId;
  const session = ensureActiveChat();
  const sessionId = session.id;
  const contextSourceId = !sourceId && contractSourceById(session.sourceId) ? session.sourceId : "";
  if (sourceId) {
    session.sourceId = sourceId;
    touchActiveChat();
  }

  appendMessage("user", question);
  $("#question").value = "";
  resizeQuestionField();
  const pending = appendMessage("assistant", "Думаю по индексу...");
  const controller = new AbortController();
  state.chatRequest.controller = controller;
  state.chatRequest.pendingMessage = pending;
  setChatBusy(true);
  startThinkingStatus(pending);

  try {
    let streamedAnswer = "";
    let streamedSources = [];
    let streamMeta = {};
    let finalPayload = null;

    await apiStream("/api/chat/stream", {
      method: "POST",
      signal: controller.signal,
      body: JSON.stringify({ question, sourceId, contextSourceId })
    }, ({ event: streamEvent, payload }) => {
      if (streamEvent === "status") {
        if (streamedAnswer) return;
        if (payload?.status === "retrieval_started") {
          setMessageText(pending, "Ищу релевантные фрагменты в индексе...");
        } else if (payload?.status === "retrieval_done") {
          setMessageText(pending, "Готовлю контекст для модели...");
        } else if (payload?.status === "llm_started") {
          const provider = payload.providerLabel || payload.provider || "LM Studio";
          const model = payload.model ? ` (${payload.model})` : "";
          setMessageText(pending, `${provider} генерирует ответ${model}...`);
        }
        return;
      }

      if (streamEvent === "token") {
        const token = typeof payload === "string" ? payload : String(payload?.text || "");
        if (!token) return;
        if (!streamedAnswer) stopThinkingStatus();
        streamedAnswer += token;
        setMessageText(pending, streamedAnswer);
        return;
      }

      if (streamEvent === "sources") {
        streamedSources = Array.isArray(payload) ? payload : (payload?.sources || []);
        return;
      }

      if (streamEvent === "meta") {
        streamMeta = payload || {};
        return;
      }

      if (streamEvent === "done") {
        finalPayload = payload || {};
        return;
      }

      if (streamEvent === "error") {
        throw new Error(payload?.error || String(payload || "Streaming error"));
      }
    });

    const payload = {
      ...streamMeta,
      ...(finalPayload || {})
    };
    const finalSources = payload.sources || streamedSources;
    const finalAnswer = payload.answer || streamedAnswer;

    stopThinkingStatus();
    applyMatchedSource(payload.matchedSource);
    if (wasAutoMode) renderAutoProjectBanner(pending, payload.matchedSource);
    setMessageText(pending, finalAnswer, { sources: finalSources });
    setMessageMeta(pending, formatResponseMeta(payload, { linkedTenderCount: linkedTenderCountForResponse(payload) }));
    renderMessageSources(pending, finalSources, finalAnswer);
    setMessageRagDebug(pending, { ...payload, answer: finalAnswer, sources: finalSources }, finalSources);
    generateChatTitleForSession(sessionId, question, finalAnswer, payload.matchedSource).catch(() => {});
    refreshRemoteDiagnostics();
  } catch (error) {
    stopThinkingStatus();
    if (error.name === "AbortError") {
      pending.classList.add("message-cancelled");
      setMessageText(pending, "Остановлено.");
    } else {
      pending.classList.add("message-error");
      setMessageText(pending, `Ошибка: ${error.message}`);
    }
  } finally {
    clearChatRequest();
    $("#question").focus();
  }
}

$("#source-form").addEventListener("submit", addSource);
$("#source-add-shortcut")?.addEventListener("click", focusNewSourceForm);
$("#index-refresh-all")?.addEventListener("click", refreshAllIndexState);
$("#settings-audit-shortcut")?.addEventListener("click", () => setSettingsTab("audit"));
$("#tender-sync-button")?.addEventListener("click", () => syncTenders({ apply: false }));
document.querySelectorAll("[data-source-list-tab]").forEach((button) => {
  button.addEventListener("click", () => setSourceListTab(button.dataset.sourceListTab));
});
$("#source-select-mode")?.addEventListener("click", () => setSourceSelectionMode(true));
$("#source-selection-done")?.addEventListener("click", () => setSourceSelectionMode(false));
$("#source-bulk-delete")?.addEventListener("click", deleteSelectedSources);
$("#indexed-files-refresh")?.addEventListener("click", () => {
  const source = selectedSettingsSource();
  if (source) loadIndexedFiles(source.id, { force: true });
});
document.addEventListener("click", hideIndexedFileMenu);
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") hideIndexedFileMenu();
});
window.addEventListener("resize", hideIndexedFileMenu);
window.addEventListener("scroll", hideIndexedFileMenu, true);
$("#source-path").addEventListener("input", syncSourcePathInput);
$("#choose-source-folder").addEventListener("click", pickSourceFolder);
$("#settings-form").addEventListener("submit", saveSettings);
$("#storage-path").addEventListener("input", syncStoragePathInput);
$("#choose-storage-folder").addEventListener("click", pickStorageFolder);
$("#llm-form").addEventListener("submit", saveLlmSettings);
$("#vector-store-form").addEventListener("submit", saveVectorStoreSettings);
$("#reranker-form").addEventListener("submit", saveRerankerSettings);
$("#load-llm-models").addEventListener("click", loadLlmModels);
$("#load-remote-llm-models").addEventListener("click", loadRemoteLlmModels);
$("#edit-llm-settings")?.addEventListener("click", () => setLlmEditing(true));
$("#edit-vector-store-settings")?.addEventListener("click", () => setVectorStoreEditing(true));
$("#edit-reranker-settings")?.addEventListener("click", () => setRerankerEditing(true));
$("#refresh-remote-diagnostics").addEventListener("click", refreshRemoteDiagnostics);
$("#refresh-integrations-status").addEventListener("click", refreshIntegrationsStatus);
$("#audit-refresh")?.addEventListener("click", () => refreshAuditStatus());
$("#qdrant-url").addEventListener("input", () => {
  updateQdrantApiKeyHint();
  syncIndexFormLocks();
});
$("#reranker-url").addEventListener("input", () => {
  updateRerankerApiKeyHint();
  syncIndexFormLocks();
});
[
  "#vector-store-enabled",
  "#vector-store-provider",
  "#qdrant-distance",
  "#qdrant-collection",
  "#qdrant-batch-size",
  "#qdrant-api-key",
  "#reranker-enabled",
  "#reranker-model",
  "#reranker-candidates",
  "#reranker-max-chars",
  "#reranker-timeout",
  "#reranker-api-key"
].forEach((selector) => {
  $(selector)?.addEventListener("input", syncIndexFormLocks);
  $(selector)?.addEventListener("change", syncIndexFormLocks);
});
["#llm-enabled", "#llm-provider", "#llm-model", "#remote-context-enabled", "#remote-fallback-local", "#remote-llm-runtime", "#remote-llm-model"].forEach((selector) => {
  $(selector)?.addEventListener("change", () => {
    syncLlmRouteCards();
    syncRemoteContextWarning();
    renderAutoRoute();
    syncLlmFormLock();
  });
});
$("#remote-context-enabled")?.addEventListener("change", (event) => {
  if (!event.target.checked) return;
  const confirmed = typeof window.confirm !== "function" || window.confirm(
    "Включить передачу найденных фрагментов документов на удалённый LLM-эндпойнт? Содержимое ваших документов будет отправлено за пределы локальной машины."
  );
  if (confirmed) return;
  event.target.checked = false;
  syncLlmRouteCards();
  syncRemoteContextWarning();
  renderAutoRoute();
  syncLlmFormLock();
});
document.querySelectorAll("[data-llm-route]").forEach((button) => {
  button.addEventListener("click", () => {
    const select = $("#llm-provider");
    if (!select || button.disabled) return;
    select.value = button.dataset.llmRoute;
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
});
["#llm-base-url", "#remote-llm-base-url", "#remote-llm-token"].forEach((selector) => {
  $(selector)?.addEventListener("input", () => {
    renderAutoRoute();
    syncLlmFormLock();
  });
});
$("#new-chat-button").addEventListener("click", startNewChat);
$("#source-viewer-close")?.addEventListener("click", resetSourcePreview);
// Панель превью ведёт себя как диалог: Tab не уходит за её пределы, возврат
// фокуса на цитату делает setSourceViewerOpen.
$("#source-viewer")?.addEventListener("keydown", trapModalTab);
$("#settings-open").addEventListener("click", openSettings);
$("#audit-open-link")?.addEventListener("click", (event) => {
  event.preventDefault();
  navigateToPath("/settings/audit");
});
$("#history-filter-active")?.addEventListener("click", () => setChatHistoryMode("active"));
$("#history-filter-archived")?.addEventListener("click", () => setChatHistoryMode("archived"));
$("#history-search")?.addEventListener("input", (event) => setChatHistoryQuery(event.target.value));
$("#sidebar-collapse")?.addEventListener("click", () => setSidebarCollapsed(!state.sidebarCollapsed));
$("#portal-stop-button")?.addEventListener("click", openPortalStopConfirmation);
$("#portal-stop-close")?.addEventListener("click", () => closePortalStopConfirmation());
$("#portal-stop-cancel")?.addEventListener("click", () => closePortalStopConfirmation());
$("#portal-stop-confirm-input")?.addEventListener("input", syncPortalStopConfirmation);
$("#portal-stop-confirm-input")?.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !$("#portal-stop-confirm")?.disabled) stopPortal();
});
$("#portal-stop-confirm")?.addEventListener("click", stopPortal);
$("#portal-stop-modal")?.addEventListener("click", (event) => {
  if (event.target.id === "portal-stop-modal") closePortalStopConfirmation();
});
$("#portal-stop-modal")?.addEventListener("keydown", trapModalTab);
["folder-modal", "tender-sync-modal", "skipped-modal"].forEach(setupModalA11y);
$("#settings-back").addEventListener("click", closeSettings);
document.querySelectorAll(".service-control-button").forEach((button) => {
  button.addEventListener("click", (event) => {
    event.stopPropagation();
    openServiceActionMenu(button.dataset.service);
  });
});
$("#service-action-menu")?.addEventListener("click", (event) => {
  const actionButton = event.target.closest("[data-service-action]");
  if (!actionButton || actionButton.disabled || !state.activeServiceMenu) return;
  event.stopPropagation();
  runServiceAction(state.activeServiceMenu, actionButton.dataset.serviceAction);
});
document.addEventListener("click", closeServiceActionMenu);
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") closeServiceActionMenu();
});
document.querySelectorAll("[data-settings-tab]").forEach((button) => {
  button.addEventListener("click", () => setSettingsTab(button.dataset.settingsTab));
  button.addEventListener("keydown", (event) => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    const tabs = [...document.querySelectorAll(".settings-tab[data-settings-tab]")];
    const currentIndex = tabs.indexOf(button);
    if (currentIndex < 0) return;
    event.preventDefault();
    const nextIndex = event.key === "Home"
      ? 0
      : event.key === "End"
        ? tabs.length - 1
        : (currentIndex + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length;
    tabs[nextIndex].focus();
    setSettingsTab(tabs[nextIndex].dataset.settingsTab);
  });
});
window.addEventListener("popstate", applyRoute);
$("#folder-close").addEventListener("click", () => closeFolderModal(""));
$("#folder-roots").addEventListener("click", loadRoots);
$("#folder-up").addEventListener("click", () => {
  if (state.folderPicker.parentPath) loadFolder(state.folderPicker.parentPath);
});
$("#folder-select-current").addEventListener("click", () => {
  if (state.folderPicker.currentPath) closeFolderModal(state.folderPicker.currentPath);
});
$("#folder-modal").addEventListener("click", (event) => {
  if (event.target.id === "folder-modal") closeFolderModal("");
});
$("#agent-run-button")?.addEventListener("click", () => runAgent({ force: false }));
$("#agent-force-run-button")?.addEventListener("click", () => runAgent({ force: true }));
$("#index-stop-button")?.addEventListener("click", stopIndexing);
$("#index-actions-menu")?.addEventListener("click", (event) => {
  if (event.target.closest("button")) event.currentTarget.removeAttribute("open");
});
document.addEventListener("click", (event) => {
  const menu = $("#index-actions-menu");
  if (menu?.hasAttribute("open") && !event.target.closest("#index-actions-menu")) menu.removeAttribute("open");
});
$("#tender-sync-close")?.addEventListener("click", closeTenderSyncModal);
$("#tender-sync-modal")?.addEventListener("click", (event) => {
  if (event.target.id === "tender-sync-modal") closeTenderSyncModal();
});
$("#skipped-close")?.addEventListener("click", closeSkippedModal);
$("#skipped-modal")?.addEventListener("click", (event) => {
  if (event.target.id === "skipped-modal") closeSkippedModal();
});
$("#force-reindex-button")?.addEventListener("click", forceReindexSelected);
$("#source-select").addEventListener("change", (event) => {
  state.selectedSourceId = event.target.value;
  resetSourcePreview();
  const session = activeChat();
  if (session && !(session.messages || []).length) {
    session.sourceId = state.selectedSourceId;
    touchActiveChat();
  }
  renderSources();
  if ($("#skipped-modal") && !$("#skipped-modal").hidden) loadSkippedFiles();
});
$("#question").addEventListener("input", resizeQuestionField);
$("#question").addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    $("#chat-form").requestSubmit();
  }
});
$("#stop-button").addEventListener("click", stopChat);
$("#chat-form").addEventListener("submit", chat);
document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  const indexMenu = $("#index-actions-menu");
  if (indexMenu?.hasAttribute("open")) {
    indexMenu.removeAttribute("open");
    indexMenu.querySelector("summary")?.focus();
    return;
  }
  if ($("#portal-stop-modal") && !$("#portal-stop-modal").hidden) {
    closePortalStopConfirmation();
    return;
  }
  if ($("#tender-sync-modal") && !$("#tender-sync-modal").hidden) {
    closeTenderSyncModal();
    return;
  }
  if (!$("#folder-modal").hidden) {
    closeFolderModal("");
    return;
  }
  if (!$("#skipped-modal").hidden) {
    closeSkippedModal();
    return;
  }
  if (!$("#settings-page").hidden) closeSettings();
});

async function init() {
  loadSidebarCollapsed();
  await Promise.all([loadSettings(), loadSources()]);
  await refreshDifyStatus();
  await refreshAgentStatus({ silent: true });
  loadChatHistory();
  applyRoute();
}

init().catch((error) => {
  setText("#job-status", error.message);
});
resizeQuestionField();
setInterval(refreshLmStudioStatus, 20000);
setInterval(refreshLmUsage, 3000);
setInterval(refreshRemoteDiagnostics, 7000);
setInterval(refreshIntegrationsStatus, 10000);
setInterval(() => refreshDifyStatus({ silent: true }), 10000);
setInterval(() => {
  if (auditPanelVisible()) refreshAuditStatus({ silent: true });
}, 4000);
setInterval(() => {
  if (!$("#settings-page")?.hidden) refreshIndexOverviewStatus({ silent: true });
}, 10000);

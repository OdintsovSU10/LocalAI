import { api, apiErrorMessage, apiStream } from "./modules/api-client.js";
import { citedSourceNumbers, citationEvidenceForNumber, compactSources, fileName, uniqueSources } from "./modules/citation-helpers.js";
import {
  compactRagDebug,
  folderName,
  formatFileSize,
  formatGenerationStats,
  formatHistoryTime,
  formatLatency,
  formatMs,
  formatResponseMeta,
  formatRouteWait
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
  addingSource: false,
  skippedSourceId: "",
  selectedSourcePath: "",
  sourceListTab: "contract",
  sourceSelectionMode: false,
  selectedSourceIds: new Set(),
  deletingSourceIds: new Set(),
  storagePath: "",
  llm: {},
  embeddings: {},
  vectorStore: {},
  backendProcessStatus: { running: true, manageable: true, state: "running" },
  reranker: {},
  rerankerProcessStatus: null,
  qdrantProcessStatus: null,
  integrationsStatus: null,
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
  previewRequestId: 0,
  folderPicker: {
    currentPath: "",
    parentPath: "",
    resolve: null
  }
};

const $ = (selector) => document.querySelector(selector);
let indexedFileContextMenu = null;
const CHAT_HISTORY_KEY = "local-rag-chat-history-v1";
const ACTIVE_CHAT_KEY = "local-rag-active-chat-v1";
const REMOTE_LM_DEFAULT_BASE_URL = "https://example-lm-studio/v1";
const REMOTE_LM_DEFAULT_MODEL = "qwen3.6-27b-mtp";
const REMOTE_AUTO_TIMEOUT_SECONDS = 300;
const SETTINGS_TABS = new Set(["sources", "llm", "indexes"]);
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

function setSourceViewerOpen(isOpen) {
  $(".app").classList.toggle("has-source-viewer", isOpen);
  $("#source-viewer").hidden = !isOpen;
}

function resetSourcePreview() {
  state.previewRequestId += 1;
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
  state.expandedIndexedFolders = new Set([""]);
}

function setSourceListTab(tab) {
  const nextTab = tab === "tender" ? "tender" : "contract";
  if (state.sourceListTab === nextTab) return;
  state.sourceListTab = nextTab;
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

function contextLinksFor(source) {
  return Array.isArray(source?.contextLinks) ? source.contextLinks : [];
}

function contextKindLabel(kind) {
  return {
    doc: "Документ",
    sheet: "Таблица",
    kp: "КП",
    link: "Ссылка"
  }[kind] || "Ссылка";
}

function inferContextKind(link = {}) {
  const kind = String(link.kind || "").toLowerCase();
  if (kind && kind !== "auto") return kind;

  const haystack = `${link.url || ""} ${link.title || ""}`.toLowerCase();
  if (haystack.includes("spreadsheets")) return "sheet";
  if (haystack.includes("document")) return "doc";
  if (/(^|[\s_-])kp([\s_.-]|$)|кп/i.test(`${link.title || ""} ${link.url || ""}`)) return "kp";
  return "link";
}

function contextLinkIndexStatus(link = {}) {
  const status = link.indexStatus || {};
  const value = String(status.status || "not_indexed");
  const label = status.label || {
    indexed: "в индексе",
    warning: "проверить",
    failed: "ошибка",
    indexing: "индексируется",
    queued: "в очереди",
    not_indexed: "не индексировалось"
  }[value] || "не индексировалось";
  return {
    status: value,
    label,
    title: status.message || label
  };
}

function googlePreviewUrl(rawUrl) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    return "";
  }

  const host = url.hostname.toLowerCase();
  const docsMatch = url.pathname.match(/^\/(document|spreadsheets|presentation)\/d\/([^/]+)/);
  if (host === "docs.google.com" && docsMatch) {
    const [, app, id] = docsMatch;
    if (app === "presentation") {
      return `https://docs.google.com/presentation/d/${encodeURIComponent(id)}/embed?start=false&loop=false&delayms=3000`;
    }

    const preview = new URL(`https://docs.google.com/${app}/d/${encodeURIComponent(id)}/preview`);
    const gid = url.searchParams.get("gid");
    if (gid && app === "spreadsheets") preview.searchParams.set("gid", gid);
    return preview.toString();
  }

  const driveFileMatch = url.pathname.match(/^\/file\/d\/([^/]+)/);
  if (host === "drive.google.com" && driveFileMatch) {
    return `https://drive.google.com/file/d/${encodeURIComponent(driveFileMatch[1])}/preview`;
  }

  const driveId = host === "drive.google.com" ? url.searchParams.get("id") : "";
  return driveId ? `https://drive.google.com/file/d/${encodeURIComponent(driveId)}/preview` : "";
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

function createChatSession(sourceId = "") {
  const now = new Date().toISOString();
  return {
    id: makeId("chat"),
    title: "Новый чат",
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

function loadChatHistory() {
  try {
    const parsed = JSON.parse(localStorage.getItem(CHAT_HISTORY_KEY) || "[]");
    state.chatSessions = Array.isArray(parsed) ? parsed.filter((session) => session?.id) : [];
  } catch {
    state.chatSessions = [];
  }

  const activeId = localStorage.getItem(ACTIVE_CHAT_KEY) || "";
  state.activeChatId = state.chatSessions.some((session) => session.id === activeId)
    ? activeId
    : (state.chatSessions[0]?.id || "");

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

function renderChatHistory() {
  const list = $("#chat-history");
  if (!list) return;
  list.innerHTML = "";

  const sessions = [...state.chatSessions].sort((a, b) => new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0));
  if (!sessions.length) {
    list.innerHTML = '<div class="empty">Истории пока нет.</div>';
    return;
  }

  for (const session of sessions) {
    const item = document.createElement("div");
    item.className = `chat-history-item ${session.id === state.activeChatId ? "active" : ""}`;
    item.innerHTML = `
      <button type="button" class="chat-history-select">
        <span class="chat-history-title"></span>
        <span class="chat-history-meta"></span>
      </button>
      <button type="button" class="chat-history-delete" title="Удалить чат" aria-label="Удалить чат">
        <span aria-hidden="true">×</span>
      </button>
    `;
    item.querySelector(".chat-history-title").textContent = session.title || "Новый чат";
    item.querySelector(".chat-history-meta").textContent = `${sourceTitle(session.sourceId)} · ${formatHistoryTime(session.updatedAt)}`;
    item.querySelector(".chat-history-select").addEventListener("click", () => setActiveChat(session.id));
    item.querySelector(".chat-history-delete").addEventListener("click", () => deleteChat(session.id));
    list.append(item);
  }
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

  if (wasActive) {
    const nextSession = [...state.chatSessions]
      .sort((a, b) => new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0))[0];

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

  if (nextTabName === "indexes") {
    refreshIntegrationsStatus();
  }
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

  const className = {
    running: "is-online",
    online: "is-online",
    starting: "is-restarting",
    stopping: "is-restarting",
    restarting: "is-restarting",
    stopped: "is-offline",
    offline: "is-offline",
    error: "is-offline",
    unmanaged: "is-offline"
  }[status] || "is-offline";

  const title = details.title || details.error || serviceLabel(service);
  indicator.classList.remove("is-online", "is-restarting", "is-offline");
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
      refreshIntegrationsStatus()
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
  } catch (error) {
    setBackendStatus("online");
    console.warn(apiErrorMessage(error, "Бэкэнд не остановлен"));
  }
}

async function runBackendAction(action) {
  if (action === "start") return startBackend();
  if (action === "stop") return stopBackend();
  return restartBackend();
}

function setRerankerProcessStatus(status = "stopped", details = {}) {
  const modelSuffix = details.model ? ` · ${details.model}` : "";
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
    error: {
      title: details.error || "Reranker недоступен"
    },
    unmanaged: {
      title: "Управление доступно только для локального Windows reranker"
    }
  };

  const next = states[status] || states.stopped;
  setServiceButtonStatus("reranker", status, { ...details, title: next.title });
}

async function refreshRerankerProcessStatus(options = {}) {
  if (!options.silent) setRerankerProcessStatus("starting", { model: state.reranker?.model || "" });
  try {
    const payload = await api("/api/system/reranker/status");
    state.rerankerProcessStatus = payload;
    if (!payload.manageable) {
      setRerankerProcessStatus("unmanaged", payload);
    } else {
      setRerankerProcessStatus(payload.running ? "running" : "stopped", payload);
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
  if (sourceNeedsQdrantReindex(status)) return "Qdrant ожидает переиндексации";
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

function formatIndexSummary(status = {}) {
  if (status.status === "running") {
    const total = status.total || 0;
    const progress = total ? `${status.processed || 0}/${total}` : "";
    return `Индексируется${progress ? ` ${progress}` : ""}`;
  }

  if (status.status === "failed") {
    return `Ошибка индексации${status.message ? `: ${status.message}` : ""}`;
  }

  if (status.status === "completed") {
    const parts = [`индексировано ${status.indexedFiles || 0}`];
    if (status.chunks) parts.push(`фрагментов ${status.chunks}`);
    if (status.vectorsTotal) parts.push(`векторов ${status.vectorsTotal}`);
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
    const total = status.total || 0;
    const progress = total ? `${status.processed || 0}/${total}` : "";
    return `Индексируется${progress ? ` ${progress}` : ""}`;
  }

  if (status.status === "failed") {
    return `Ошибка индексации${status.message ? `: ${status.message}` : ""}`;
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

function indexActionLabel(status = {}) {
  if (status.status === "running") return "Индексируется";
  if (sourceNeedsQdrantReindex(status)) return "Переиндексировать в Qdrant";
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

function sourceIndexDotClass(status = {}) {
  if (status.status === "running") return "is-indexing";
  if (status.status === "failed") return "is-error";
  if (sourceHasReadyIndex(status)) return "is-indexed";
  return "is-empty";
}

function sourceIndexDotTitle(status = {}) {
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

  if (!source) {
    badge.classList.add("ready");
    badge.textContent = "Авто по вопросу";
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

function renderSelectedSourceSettings() {
  const container = $("#selected-source-settings");
  if (!container) return;

  const source = selectedSettingsSource();
  container.innerHTML = "";

  if (!source) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = "Выберите папку слева или добавьте дополнительную папку в текущий RAG.";
    container.append(empty);
    return;
  }

  const status = source.indexStatus || { status: "not_indexed", message: "Не индексировалось" };
  const title = document.createElement("div");
  title.className = "selected-source-title";
  title.textContent = source.title;

  const path = document.createElement("div");
  path.className = "selected-source-path";
  path.textContent = source.path;

  const pipeline = document.createElement("div");
  pipeline.className = "selected-source-pipeline";
  pipeline.textContent = indexPipelineText(status);

  const stepLine = renderIndexPipeline(status);

  const actions = document.createElement("div");
  actions.className = "selected-source-actions";
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
  const blocks = [title, path, stepLine, renderSourceSummaryCard(source), pipeline];
  if (!isContractSource(source)) blocks.push(renderTenderLinkForm(source));
  blocks.push(actions);
  container.append(...blocks);
}

function renderContextLinks() {
  const list = $("#context-link-list");
  const form = $("#context-link-form");
  if (!list || !form) return;

  const source = selectedSettingsSource();
  list.innerHTML = "";
  form.querySelectorAll("input, select, button").forEach((element) => {
    element.disabled = !source;
  });

  if (!source) {
    list.innerHTML = '<div class="empty">Выберите папку, чтобы добавить Google документы, таблицы или КП.</div>';
    setText("#context-link-status", "");
    return;
  }

  const links = contextLinksFor(source);
  if (!links.length) {
    list.innerHTML = '<div class="empty">Добавьте ссылку на Google Doc, Google Sheet или КП для быстрого просмотра рядом с контекстом.</div>';
    return;
  }

  for (const link of links) {
    const item = document.createElement("article");
    item.className = "context-link-item";
    item.innerHTML = `
      <button type="button" class="context-link-main">
        <span class="context-link-head">
          <span class="context-link-title"></span>
          <span class="context-link-kind-chip"></span>
        </span>
        <span class="context-link-index-status"></span>
        <span class="context-link-url"></span>
      </button>
      <button type="button" class="secondary context-link-remove" title="Удалить" aria-label="Удалить">×</button>
    `;

    const kind = inferContextKind(link);
    const indexStatus = contextLinkIndexStatus(link);
    item.querySelector(".context-link-title").textContent = link.title || contextKindLabel(kind);
    item.querySelector(".context-link-kind-chip").textContent = contextKindLabel(kind);
    const indexStatusChip = item.querySelector(".context-link-index-status");
    indexStatusChip.classList.add(`is-${indexStatus.status}`);
    indexStatusChip.textContent = indexStatus.label;
    indexStatusChip.title = indexStatus.title;
    indexStatusChip.setAttribute("aria-label", indexStatus.title);
    item.querySelector(".context-link-url").textContent = link.url;
    item.querySelector(".context-link-main").addEventListener("click", () => openContextLinkPreview(link, source));
    item.querySelector(".context-link-remove").addEventListener("click", () => removeContextLink(link.id));
    list.append(item);
  }
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
  low_ocr_page_confidence: "low OCR confidence on one or more pages",
  empty_ocr_pages: "OCR produced empty or near-empty pages",
  pdf_text_layer_noise: "PDF text layer looks noisy",
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
  return [...new Set(reasons)];
}

function indexedQualityTooltip(file) {
  const reasons = indexedQualityReasons(file);
  const stats = [];
  if (Number.isFinite(Number(file.quality?.chars))) stats.push(`символов: ${file.quality.chars}`);
  if (Number.isFinite(Number(file.quality?.words))) stats.push(`слов: ${file.quality.words}`);
  if (Number.isFinite(Number(file.chunks))) stats.push(`фрагментов: ${file.chunks}`);
  return [
    file.relativePath || file.path,
    indexedQualityLabel(file),
    reasons.length ? `Причина: ${reasons.join("; ")}` : "",
    stats.length ? stats.join(", ") : ""
  ].filter(Boolean).join("\n");
}

function indexedFileSourceLabel(file) {
  if (!file?.sourceType && !file?.sourceTitle) return "";
  const label = sourceTypeLabel(file);
  return file.sourceTitle ? `${label}: ${file.sourceTitle}` : label;
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

function indexedRecognitionLabel(file) {
  const recognition = file.recognition || {};
  if (["ocr", "ocr-cache", "ocrmypdf"].includes(recognition.method)) {
    const pages = recognition.ocrTotalPages
      ? `${recognition.ocrPages || recognition.ocrRecognizedPages || 0}/${recognition.ocrTotalPages}`
      : `${recognition.ocrPages || recognition.ocrRecognizedPages || 0}`;
    const confidence = Number.isFinite(Number(recognition.ocrConfidence)) ? `, ${Math.round(Number(recognition.ocrConfidence))}%` : "";
    const p10 = Number.isFinite(Number(recognition.ocrConfidenceP10)) ? `, p10 ${Math.round(Number(recognition.ocrConfidenceP10))}%` : "";
    const mode = recognition.pdfOcrMode && recognition.pdfOcrMode !== "auto" ? `, ${recognition.pdfOcrMode}` : "";
    const cachedPages = Number(recognition.ocrCachedPages);
    const cache = Number.isFinite(cachedPages) && cachedPages > 0 ? `, cache ${cachedPages}` : "";
    const limited = recognition.ocrLimited ? ", limited" : "";
    return `${recognition.method === "ocrmypdf" ? "OCRmyPDF" : "OCR"} ${pages}${confidence}${p10}${mode}${cache}${limited}`;
  }
  if (recognition.method === "pdf-text") return "PDF текст";
  if (recognition.method === "docling") return "Docling";
  if (recognition.method === "docx") return "DOCX";
  if (recognition.method === "xlsx") return "XLSX";
  if (recognition.method === "xlsm") return "XLSM";
  if (recognition.method === "xls") return "XLS";
  if (recognition.method === "text") return "текст";
  if (recognition.method === "pdf-empty") return "PDF пустой";
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
      <span class="indexed-tree-file-main">
        <span class="indexed-tree-name-line">
          <span class="indexed-tree-name"></span>
          <span class="indexed-tree-source-chip"></span>
        </span>
        <span class="indexed-tree-meta"></span>
      </span>
      <span class="indexed-tree-quality"></span>
    `;
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
    tree.innerHTML = '<div class="empty">Выберите папку слева, чтобы увидеть файлы индекса.</div>';
    return;
  }

  const current = state.indexedFiles;
  if (current.sourceId !== source.id) {
    summary.textContent = "Загружаю список файлов...";
    tree.innerHTML = '<div class="empty">Читаю текущий индекс папки.</div>';
    return;
  }

  if (current.loading) {
    const files = current.files || [];
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
  const status = source.indexStatus || {};
  const indexing = status.status === "running";
  const progress = indexProgressText(status);

  if (!files.length) {
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
  const addingSource = settingsOpen && (state.addingSource || state.sources.length === 0);
  const activeListSourceId = settingsOpen ? (addingSource ? "" : state.settingsSourceId) : state.selectedSourceId;

  $("#settings-project-detail")?.classList.toggle("adding-source", addingSource);
  const selectedSourcePanel = $("#selected-source-panel");
  const contextLinksPanel = $("#context-links-panel");
  const indexedFilesPanel = $("#indexed-files-panel");
  const newSourcePanel = $("#new-source-panel");
  if (selectedSourcePanel) selectedSourcePanel.hidden = addingSource;
  if (contextLinksPanel) contextLinksPanel.hidden = addingSource;
  if (indexedFilesPanel) indexedFilesPanel.hidden = addingSource;
  newSourcePanel?.classList.toggle("add-source-mode", addingSource);
  $("#source-add-shortcut")?.classList.toggle("active", addingSource);
  $("#source-add-shortcut")?.setAttribute("aria-pressed", String(addingSource));
  if (addingSource && state.sourceSelectionMode) {
    state.sourceSelectionMode = false;
    state.selectedSourceIds.clear();
  }
  syncSelectedSourceIdsWithSources();
  renderSourceSelectionControls();
  if (settingsOpen && !addingSource) ensureSettingsSourceVisibleInTab();
  syncSourceListTabs();

  const emptyOption = document.createElement("option");
  emptyOption.value = "";
  emptyOption.textContent = "Авто: определить по вопросу";
  select.append(emptyOption);

  const visibleSources = settingsOpen ? sourceListTabSources() : state.sources;

  for (const source of visibleSources) {
    const item = document.createElement("div");
    item.className = `source ${source.id === activeListSourceId ? "active" : ""} ${state.sourceSelectionMode ? "selection-mode" : ""}`;
    item.dataset.sourceId = source.id;
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
    if (!isContractSource(source)) {
      const chip = document.createElement("span");
      chip.className = "source-kind-chip";
      chip.textContent = sourceTypeLabel(source);
      titleNode.append(" ", chip);
    }
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
        state.settingsSourceId = source.id;
        if (state.indexedFiles.sourceId !== source.id) state.expandedIndexedFolders = new Set([""]);
      } else {
        state.selectedSourceId = source.id;
      }
      renderSources();
    });
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
  renderIndexedFilesPanel();
  renderContextLinks();
  const settingsSource = selectedSettingsSource();
  if (settingsOpen && !addingSource && settingsSource) ensureIndexedFilesLoaded(settingsSource.id);
  renderChatHistory();
}

async function loadSources() {
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
  if (state.sources.length === 0) {
    state.addingSource = true;
  }
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
  setText("#settings-status", settings.envLocked ? "Путь задан переменной RAG_DATA_DIR" : "");
  syncRemoteContextWarning();
  renderAutoRoute();
  syncLlmFormLock();
  syncIndexFormLocks();
  refreshLmStudioStatus();
  refreshRemoteDiagnostics();
  refreshIntegrationsStatus();
  refreshLmUsage();
}

async function pickSourceFolder() {
  if (!$("#settings-page")?.hidden && !state.addingSource) {
    state.addingSource = true;
    state.settingsSourceId = "";
    renderSources();
  }
  setText("#settings-status", "");
  setText("#job-status", "Открываю проводник для выбора дополнительной папки RAG...");
  const selected = await chooseFolder({
    title: "Выберите дополнительную папку для текущего RAG",
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
    renderSources();
  }
  const sourcePath = $("#source-path").value.trim();
  state.selectedSourcePath = sourcePath;
}

function syncStoragePathInput() {
  state.storagePath = $("#storage-path").value.trim();
  setText("#settings-status", "Нажмите «Сохранить», чтобы применить путь.");
}

async function saveSettings(event) {
  event.preventDefault();
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

function setGoogleAuthConnectionStatus(status, text) {
  const box = $("#google-auth-status");
  if (!box) return;
  box.classList.remove("online", "offline", "checking", "disabled");
  box.classList.add(status);
  setText("#google-auth-status-text", text);
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

function renderGoogleAuthStatus(googleAuth = {}) {
  const loginButton = $("#google-auth-login");
  const logoutButton = $("#google-auth-logout");
  const refreshButton = $("#google-auth-refresh");
  if (!loginButton || !logoutButton) return;

  const configured = Boolean(googleAuth.configured);
  const authorized = Boolean(googleAuth.authorized);
  loginButton.disabled = !configured || authorized;
  logoutButton.disabled = !authorized;
  if (refreshButton) refreshButton.disabled = false;

  if (!configured) {
    setGoogleAuthConnectionStatus("disabled", "Google OAuth env is not configured");
  } else if (authorized) {
    const account = googleAuth.email ? ` as ${googleAuth.email}` : "";
    setGoogleAuthConnectionStatus("online", `Google login active${account}`);
  } else {
    setGoogleAuthConnectionStatus("offline", "Google login is not active");
  }

  const detail = [];
  if (configured) detail.push(`Redirect: ${googleAuth.redirectUri || "default"}`);
  else detail.push("Set RAG_GOOGLE_OAUTH_CLIENT_ID and optional RAG_GOOGLE_OAUTH_CLIENT_SECRET in env, then restart backend.");
  if (authorized && googleAuth.source === "env") detail.push("Token source: env");
  if (authorized && googleAuth.expiresAt) detail.push(`Access token expires: ${shortDateTime(googleAuth.expiresAt)}`);
  setText("#google-auth-detail", detail.join(" · "));
}

function renderIntegrationsStatus(payload = state.integrationsStatus) {
  if (!$("#qdrant-diag-state")) return;
  const vectorStore = payload?.vectorStore || {};
  const reranker = payload?.reranker || {};
  const pdf = payload?.pdf || {};
  const googleAuth = payload?.googleAuth || {};
  renderGoogleAuthStatus(googleAuth);

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
  }
}

async function startGoogleAuth() {
  const button = $("#google-auth-login");
  const previousText = button?.textContent || "";
  if (button) {
    button.disabled = true;
    button.textContent = "Opening...";
  }
  try {
    const payload = await api("/api/google/auth/start", { method: "POST" });
    if (payload.authUrl) window.open(payload.authUrl, "_blank", "noopener,noreferrer");
    setText("#google-auth-detail", "Complete Google login in the opened tab, then refresh status.");
    setTimeout(refreshIntegrationsStatus, 2500);
  } catch (error) {
    setText("#google-auth-detail", apiErrorMessage(error, "Google login failed"));
  } finally {
    if (button) button.textContent = previousText || "Login with Google";
    await refreshIntegrationsStatus();
  }
}

async function logoutGoogleAuth() {
  const button = $("#google-auth-logout");
  const previousText = button?.textContent || "";
  if (button) {
    button.disabled = true;
    button.textContent = "Forgetting...";
  }
  try {
    const status = await api("/api/google/auth/logout", { method: "POST" });
    renderGoogleAuthStatus(status);
  } catch (error) {
    setText("#google-auth-detail", apiErrorMessage(error, "Google logout failed"));
  } finally {
    if (button) button.textContent = previousText || "Forget login";
    await refreshIntegrationsStatus();
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
  mini.classList.remove("online", "offline", "busy", "checking");
  mini.classList.add(stateName);
  $("#lm-mini-title").textContent = title;
  $("#lm-mini-detail").textContent = detail;
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
      setLmMiniState("checking", "LM Studio", `процесс не найден · ${formatLmUsageDetail(payload)}`);
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

function tenderSyncActionLabel(action) {
  return {
    create: "Создать",
    update: "Обновить"
  }[action] || action || "Проверить";
}

function tenderSyncItemStatus(item = {}) {
  if (item.mappingError) return { className: "is-error", label: "Ошибка mapping", detail: item.mappingError };
  if (item.manualLinked) {
    return { className: "is-linked", label: "Привязано вручную", detail: item.matchCandidates?.[0]?.title || item.linkedContractId || "" };
  }
  if (item.autoLinked) {
    return { className: "is-linked", label: "Авто-привязка", detail: item.matchCandidates?.[0]?.title || item.linkedContractId || "" };
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
    if (item.mappingError || (!item.linkedContractId && Array.isArray(item.matchCandidates) && item.matchCandidates.length)) {
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
  const title = document.createElement("span");
  title.className = "tender-sync-candidate-title";
  title.textContent = candidate.title || candidate.id || "Кандидат";
  const evidence = document.createElement("span");
  evidence.className = "tender-sync-candidate-evidence";
  evidence.textContent = candidateEvidenceText(candidate, item);
  line.append(title);
  if (evidence.textContent) line.append(evidence);
  return line;
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
  const title = document.createElement("div");
  title.className = "tender-sync-section-title";
  title.textContent = titleText;
  const count = document.createElement("span");
  count.className = "tender-sync-section-count";
  count.textContent = `${items.length}`;
  header.append(title, count);

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

    const candidates = (item.matchCandidates || []).slice(0, 3);
    const detailText = status.detail || (!item.linkedContractId && candidates.length
      ? "Автомат не записывает привязку, потому что совпадение не уверенное."
      : "");
    const detail = document.createElement("div");
    detail.className = "tender-sync-detail";
    detail.textContent = detailText;
    detail.hidden = !detailText;

    main.append(name, meta);
    if (!detail.hidden) main.append(detail);

    if (candidates.length) {
      const candidateList = document.createElement("div");
      candidateList.className = "tender-sync-candidates";
      for (const candidate of candidates) {
        candidateList.append(renderTenderSyncCandidate(candidate, item));
      }
      main.append(candidateList);
    }

    const badge = document.createElement("span");
    badge.className = "tender-sync-status";
    badge.textContent = status.label;

    row.append(main, badge);
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
  button.addEventListener("click", () => syncTenders({ apply: true, scope }));
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

function renderTenderSyncPlan(summary = {}) {
  const planned = Array.isArray(summary.planned) ? summary.planned : [];
  const groups = tenderSyncReviewGroups(planned);
  const container = document.createElement("div");
  container.className = "tender-sync-review";

  if (!planned.length) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = "Новых или обновляемых тендеров нет.";
    container.append(empty);
    return container;
  }

  container.append(renderTenderSyncTabs(summary, groups));
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

  if (modal) modal.hidden = false;
  setText("#tender-sync-modal-title", summary.apply && summary.applyScope === "unlinked"
    ? "Тендеры без договора созданы"
    : summary.apply
    ? "Синхронизация применена"
    : "Проверка синхронизации тендеров");
  setText("#tender-sync-modal-subtitle", summary.apply && summary.applyScope === "unlinked"
    ? "Записаны только источники без договора"
    : summary.apply
    ? "Источники записаны"
    : "Dry-run: ничего не записано");
  report.innerHTML = "";

  const hint = document.createElement("div");
  hint.className = "tender-sync-lead";
  hint.textContent = summary.apply && summary.applyScope === "unlinked"
    ? "Созданы только тендеры без договора. Привязанные и спорные строки не записывались."
    : summary.apply
    ? "Источники обновлены. Оставшиеся тендеры без договора можно привязать вручную в группе «Тендеры»."
    : "Это только предварительный просмотр. Автоматически запишутся только зеленые привязки; спорные строки останутся без договора.";

  const totals = document.createElement("div");
  totals.className = "tender-sync-totals";
  const totalKeys = summary.apply && summary.applyScope === "unlinked"
    ? ["foldersOnDisk", "applied", "scopeCreated", "scopeUpdated", "unlinkedReady", "review", "stale"]
    : ["foldersOnDisk", "created", "updated", "linked", "manualLinked", "autoLinked", "unlinkedReady", "review", "stale"];
  for (const key of totalKeys) {
    if (!Number.isFinite(Number(summary.totals?.[key]))) continue;
    const pill = document.createElement("span");
    pill.className = "tender-sync-pill";
    pill.textContent = `${tenderSyncTotalLabel(key)}: ${summary.totals[key]}`;
    totals.append(pill);
  }

  report.append(hint, totals);
  report.append(renderTenderSyncPlan(summary));
  report.scrollTop = 0;
}

async function syncTenders(options = {}) {
  const apply = typeof options === "boolean" ? options : Boolean(options.apply);
  const scope = typeof options === "object" && options.scope ? options.scope : "all";
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
    const payload = await api(`/api/tenders/sync${query ? `?${query}` : ""}`, { method: "POST" });
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
  if (!sourcePath) {
    setText("#job-status", "Выберите дополнительную папку для текущего RAG.");
    return;
  }

  const source = await api("/api/sources", {
    method: "POST",
    body: JSON.stringify({ path: sourcePath, title })
  });
  state.selectedSourceId = source.id;
  state.settingsSourceId = source.id;
  state.sourceListTab = sourceListTabForSource(source);
  state.addingSource = false;
  state.selectedSourcePath = "";
  $("#source-title").value = "";
  $("#source-path").value = "";
  await loadSources();
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
  state.addingSource = state.sources.length === 0;
  renderSources();
  setText("#job-status", `Выбранные папки удалены из списка: ${targets.length}. Очищаю индекс в фоне...`);

  try {
    const payload = await api("/api/sources", {
      method: "DELETE",
      body: JSON.stringify({ ids: [...targetIds] })
    });
    state.sources = Array.isArray(payload.sources) ? payload.sources : await api("/api/sources");
    state.addingSource = state.sources.length === 0;
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

async function addContextLink(event) {
  event.preventDefault();
  const source = selectedSettingsSource();
  if (!source) return;

  const url = $("#context-link-url").value.trim();
  const title = $("#context-link-title").value.trim();
  const kind = $("#context-link-kind").value;
  if (!url) {
    setText("#context-link-status", "Вставьте ссылку на Google документ, таблицу или КП.");
    return;
  }

  setText("#context-link-status", "Сохраняю ссылку...");
  try {
    const nextSource = await api(`/api/sources/${encodeURIComponent(source.id)}/context-links`, {
      method: "POST",
      body: JSON.stringify({ url, title, kind })
    });
    replaceSource(nextSource);
    $("#context-link-url").value = "";
    $("#context-link-title").value = "";
    $("#context-link-kind").value = "auto";
    renderSources();
    setText("#context-link-status", "Ссылка добавлена.");
  } catch (error) {
    setText("#context-link-status", error.message);
  }
}

async function removeContextLink(linkId) {
  const source = selectedSettingsSource();
  if (!source || !linkId) return;

  setText("#context-link-status", "Удаляю ссылку...");
  try {
    const nextSource = await api(`/api/sources/${encodeURIComponent(source.id)}/context-links/${encodeURIComponent(linkId)}`, {
      method: "DELETE"
    });
    replaceSource(nextSource);
    renderSources();
    setText("#context-link-status", "Ссылка удалена.");
  } catch (error) {
    setText("#context-link-status", error.message);
  }
}

function latestAgentRun(runs = []) {
  return Array.isArray(runs) ? runs[0] || null : null;
}

function isAgentRunActive(run) {
  return run?.status === "running";
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

function updateAgentButton(run = state.agentStatus.latestRun) {
  const button = $("#agent-run-button");
  if (!button) return;

  const starting = isAgentStarting(run);
  const running = isAgentRunActive(run) || starting;
  button.disabled = running;
  button.textContent = running ? "Агент работает" : "Запустить агента";
  button.title = running ? "Проверка папок уже выполняется" : "Проверить все выбранные папки";
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

  const running = isAgentRunActive(run) || isAgentStarting(run);
  if (running) {
    ensureAgentPollTimer();
    if (!silent) setText("#job-status", "Агент запущен: проверяю выбранные папки");
    return run;
  }

  clearAgentPollTimer();
  if (previous?.status === "running" && run?.id === previous.id) {
    const summary = formatAgentTotals(run);
    setText("#job-status", `Агент завершил проверку${summary ? `: ${summary}` : ""}`);
    await loadSources();
    if (state.selectedSourceId) loadIndexedFiles(state.selectedSourceId, { force: true });
  } else if (!silent && run) {
    const updated = shortDateTime(run.finishedAt || run.startedAt);
    const summary = formatAgentTotals(run);
    setText("#job-status", `Последний запуск агента: ${run.status}${updated ? `, ${updated}` : ""}${summary ? `; ${summary}` : ""}`);
  }

  return run;
}

async function runAgent() {
  const button = $("#agent-run-button");
  if (button) button.disabled = true;
  state.agentStatus.requestedAt = Date.now();
  setText("#job-status", "Запускаю агента для всех выбранных папок");
  updateAgentButton(state.agentStatus.latestRun);

  try {
    await api("/api/agent/run", {
      method: "POST",
      body: JSON.stringify({ force: false })
    });
    setText("#job-status", "Агент запущен: проверяю выбранные папки");
    ensureAgentPollTimer();
    await refreshAgentStatus({ silent: true });
  } catch (error) {
    state.agentStatus.requestedAt = 0;
    updateAgentButton(state.agentStatus.latestRun);
    setText("#job-status", `Не удалось запустить агента: ${error.message}`);
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

function formatJobStatus(job) {
  const total = job.total || 0;
  const processed = job.processed || 0;
  const totalFiles = job.totalFiles || 0;

  if (job.status === "completed") {
    return job.failed ? `Готово, есть ошибки: ${job.failed}` : "";
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

function showIndexProgress(job = {}) {
  const progress = $("#index-progress");
  const fill = $("#index-progress-fill");
  const label = $("#index-progress-label");
  if (!progress || !fill || !label) return;

  if (state.indexProgressHideTimer) {
    clearTimeout(state.indexProgressHideTimer);
    state.indexProgressHideTimer = null;
  }

  const percent = jobProgressPercent(job);
  progress.hidden = false;
  progress.classList.toggle("is-indeterminate", percent == null);
  progress.classList.toggle("is-failed", job.status === "failed");
  progress.classList.toggle("is-completed", job.status === "completed");
  fill.style.width = percent == null ? "" : `${percent}%`;
  label.textContent = job.status === "failed" ? "ошибка" : (percent == null ? "..." : `${Math.round(percent)}%`);
  progress.title = formatJobStatus(job);
}

function hideIndexProgress(delayMs = 0) {
  const progress = $("#index-progress");
  if (!progress) return;
  const hide = () => {
    progress.hidden = true;
    progress.classList.remove("is-indeterminate", "is-failed", "is-completed");
    const fill = $("#index-progress-fill");
    const label = $("#index-progress-label");
    if (fill) fill.style.width = "0%";
    if (label) label.textContent = "";
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
      status.textContent = formatJobStatus(job);
      showIndexProgress(job);
      const source = state.sources.find((item) => item.id === job.sourceId);
      if (source) {
        source.indexStatus = {
          ...source.indexStatus,
          id: job.id,
          status: job.status,
          phase: job.phase,
          message: job.message,
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
          embeddingEnabled: job.embeddingEnabled,
          embeddingModel: job.embeddingModel,
          vectorStoreProvider: job.vectorStoreProvider || "",
          qdrantAvailable: job.qdrantAvailable,
          qdrantCollection: job.qdrantCollection || "",
          qdrantPoints: optionalNumber(job.qdrantPoints),
          vectorCount: optionalNumber(job.vectorCount),
          qdrantError: job.qdrantError || "",
          failed: job.failed || 0,
          skippedTotal: (job.unsupportedFiles || 0) + (job.temporaryFiles || 0) + (job.excludedFiles || 0),
          unsupportedFiles: job.unsupportedFiles || 0,
          temporaryFiles: job.temporaryFiles || 0,
          excludedFiles: job.excludedFiles || 0,
          unsupportedByExt: job.unsupportedByExt || {},
          startedAt: job.startedAt,
          updatedAt: job.updatedAt,
          finishedAt: job.finishedAt
        };
        renderSources();
        if (
          job.status === "running"
          && state.indexedFiles.sourceId === job.sourceId
          && !state.indexedFiles.loading
          && Date.now() - Number(state.indexedFiles.refreshedAt || 0) > 5000
        ) {
          loadIndexedFiles(job.sourceId, { force: true, silent: true });
        }
      }
      if (job.status === "completed" || job.status === "failed") {
        clearInterval(timer);
        if (state.indexPollTimer === timer) {
          state.indexPollTimer = null;
          state.indexPollJobId = "";
        }
        showIndexProgress(job);
        hideIndexProgress(job.status === "completed" ? 1800 : 5000);
        loadSources();
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
      status.textContent = error.message;
      hideIndexProgress(3000);
    }
  }, 1200);
  state.indexPollTimer = timer;
}

async function indexSelected(force = false, sourceIdOverride = "") {
  const sourceId = sourceIdOverride || $("#source-select").value;
  if (!sourceId) return;
  if (state.indexedFiles.sourceId === sourceId) {
    resetIndexedFilesState(sourceId);
    renderIndexedFilesPanel();
  }
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
    renderSources();
    return;
  }
  showIndexProgress(job);
  const source = state.sources.find((item) => item.id === sourceId);
  if (source) {
    source.indexStatus = {
      ...source.indexStatus,
      id: job.id,
      status: job.status,
      phase: job.phase,
      message: job.message,
      force: Boolean(job.force),
      processed: job.processed || 0,
      total: job.total || 0,
      startedAt: job.startedAt
    };
    renderSources();
  }
  pollJob(job.id);
}

function forceReindexSelected() {
  const sourceId = state.skippedSourceId || state.selectedSourceId;
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
      button.addEventListener("click", () => openSourcePreview(previewSource));
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

function syncMessageMetaElement(message, text) {
  message.querySelector(".message-meta")?.remove();
  const value = String(text || "").trim();
  if (!value) return;

  const meta = document.createElement("div");
  meta.className = "message-meta";
  meta.textContent = value;
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

function createMessageElement(role, text, messageId = "", meta = "", sources = []) {
  const message = document.createElement("article");
  message.className = `message ${role}`;
  if (messageId) message.dataset.messageId = messageId;
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
    const message = createMessageElement(item.role, item.text, item.id, item.meta || "", item.sources || []);
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
  const message = createMessageElement(role, text, record?.id || "");
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
  if (!unique.length) return;

  const block = document.createElement("div");
  block.className = "message-sources";

  const title = document.createElement("div");
  title.className = "message-sources-title";
  title.textContent = "Найденные файлы";
  block.append(title);

  unique.forEach((source, index) => {
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
      record.sources = compactSources(unique);
      touchActiveChat();
    }
  }
  if (options.autoOpen === true) openSourcePreview(unique[0]);
  scrollChatToBottom();
}

function openContextLinkPreview(link, source = selectedSettingsSource()) {
  state.previewRequestId += 1;
  const kind = inferContextKind(link);
  const previewSource = {
    title: link.title || contextKindLabel(kind),
    sourceTitle: source?.title || "Google контекст",
    path: link.url
  };
  const preview = renderPreviewShell(previewSource);

  const actions = document.createElement("div");
  actions.className = "preview-actions";

  const openLink = document.createElement("a");
  openLink.className = "preview-action-link";
  openLink.href = link.url;
  openLink.target = "_blank";
  openLink.rel = "noreferrer";
  openLink.textContent = "Открыть в Google";
  actions.append(openLink);
  preview.append(actions);

  const embedUrl = googlePreviewUrl(link.url);
  if (!embedUrl) {
    appendPreviewNote(preview, "Для этой ссылки нет встроенного предпросмотра. Откройте ее в Google.");
    return;
  }

  const frame = document.createElement("iframe");
  frame.className = "google-preview-frame";
  frame.src = embedUrl;
  frame.title = previewSource.title;
  frame.loading = "lazy";
  frame.referrerPolicy = "no-referrer-when-downgrade";
  preview.append(frame);

  appendPreviewNote(preview, "Если документ приватный или Google заблокирует iframe, откройте его кнопкой выше.");
}

function renderPreviewShell(source, statusText = "") {
  setSourceViewerOpen(true);
  const displayTitle = source.fileLabel || source.pathLabel || source.title || source.citationTarget?.fileLabel || fileName(source.path);
  $("#preview-title").textContent = displayTitle;
  const preview = $("#source-preview");
  preview.innerHTML = "";

  const meta = document.createElement("div");
  meta.className = "preview-meta";
  meta.textContent = [
    source.sourceTitle,
    source.citationLabel || source.citationTarget?.label || source.pathLabel || source.fileLabel || fileName(source.path),
    source.sectionTitle ? `раздел "${source.sectionTitle}"` : "",
    source.pageStart ? `стр. ${source.pageEnd && source.pageEnd > source.pageStart ? `${source.pageStart}-${source.pageEnd}` : source.pageStart}` : "",
    source.sheetName ? `лист "${source.sheetName}"` : "",
    source.score ? `score ${source.score}` : "",
    source.references > 1 ? `фрагментов ${source.references}` : ""
  ].filter(Boolean).join(" · ");
  preview.append(meta);

  if (statusText) {
    const status = document.createElement("div");
    status.className = "hint preview-status";
    status.textContent = statusText;
    preview.append(status);
  }

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
    return { text: source, focus: { found: false }, truncatedBefore: false, truncatedAfter: false };
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
    truncatedAfter: windowEnd < source.length
  };
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
    appendPreviewNote(preview, "Выше есть скрытый текст файла; открыт участок вокруг цитаты.");
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
    appendPreviewNote(preview, "Ниже есть продолжение файла, оно скрыто для быстрого открытия.");
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
  const session = ensureActiveChat();
  session.sourceId = sourceId;
  touchActiveChat();

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
      body: JSON.stringify({ question, sourceId })
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
    setMessageText(pending, finalAnswer, { sources: finalSources });
    setMessageMeta(pending, formatResponseMeta(payload));
    renderMessageSources(pending, finalSources, finalAnswer);
    setMessageRagDebug(pending, { ...payload, answer: finalAnswer, sources: finalSources }, finalSources);
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
$("#context-link-form")?.addEventListener("submit", addContextLink);
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
$("#google-auth-login")?.addEventListener("click", startGoogleAuth);
$("#google-auth-logout")?.addEventListener("click", logoutGoogleAuth);
$("#google-auth-refresh")?.addEventListener("click", refreshIntegrationsStatus);
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
    syncRemoteContextWarning();
    renderAutoRoute();
    syncLlmFormLock();
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
$("#settings-open").addEventListener("click", openSettings);
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
$("#agent-run-button")?.addEventListener("click", runAgent);
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
  await Promise.all([loadSettings(), loadSources()]);
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

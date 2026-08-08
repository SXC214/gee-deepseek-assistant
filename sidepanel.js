import { isOfficialDeepSeekV4 } from "./lib/api.js";
import {
  createCodeCandidate,
  markCodeCandidateApplied
} from "./lib/candidate.js";
import { appendChatEntry, createChatEntry, sanitizeChatHistory, sanitizeChatText } from "./lib/chat.js";
import { createConsoleContextSection, getConsoleUiState, normalizeConsoleRead } from "./lib/console.js";
import { alignConversationToUser } from "./lib/conversation.js";
import { createLineDiff } from "./lib/diff.js";
import { createOrchestrator } from "./lib/orchestrator.js";
import { CUSTOM_PROVIDER_ID, findProviderPreset, matchProviderPreset } from "./lib/provider-presets.js";
import {
  ACTIVE_PLAN_KEY,
  CHAT_HISTORY_KEY,
  CODE_CANDIDATE_KEY,
  MESSAGE_QUEUE_KEY,
  readActivePlan,
  readChatHistory,
  readCodeCandidate,
  readMessageQueue,
  serializeActivePlan,
  serializeCodeCandidate,
  setWithQuotaEviction,
  writeMessageQueueSnapshot
} from "./lib/storage.js";
import {
  prioritizeQueuedMessage,
  removeQueuedMessage
} from "./lib/queue.js";
import {
  collectPlanAnswerMarkerIds,
  countPlanAnswerBlocks,
  createReasoningView,
  getPlanActionState,
  isNearScrollEnd,
  planAnswerMarkerId,
  setComposerModeView,
  setStatusView,
  setPlanToolControls,
  setScrollToLatestVisibility,
  setSettingsPanelOpen,
  setThinkingControlEnabled,
  upsertPlanAnswerText
} from "./lib/ui.js";

const elements = Object.fromEntries(
  [...document.querySelectorAll("[id]")].map((element) => [element.id, element])
);

let editorState = null;
let candidate = null;
let chatHistory = [];
let chatHistoryWrite = Promise.resolve();
let candidateWrite = Promise.resolve();
let queueWrite = Promise.resolve();
let currentSettings = null;
let busy = false;
let initialized = false;
let initializing = false;
let initRetryButton = null;
let followConversation = true;
let consoleReadAttempted = false;
let eventsBound = false;
// ISS-009: plan-question option state lives here so re-rendered plan cards
// keep their checked option, and answers that already left the input can
// never be injected (and re-sent) a second time.
let planOptionSelections = new Map();
let submittedPlanAnswerIds = new Set();

const orchestrator = createOrchestrator({
  runtime: chrome.runtime,
  appendMessage,
  showCandidate,
  setBusy,
  setStatus,
  showError,
  scrollConversationToEnd,
  updateScrollFollower,
  syncConversationEmptyState,
  readEditor,
  openSettings,
  selectComposerMode,
  renderMessageQueue,
  renderPlan,
  persistMessageQueue,
  persistActivePlan,
  onSettingsLoaded: (settings) => { currentSettings = settings; },
  renderToolSources,
  setToolActivityState,
  completeToolActivity,
  hideToolResults: () => elements.toolResults.classList.add("hidden"),
  createConsoleContextSection: (state) => createConsoleContextSection(state, elements.includeConsole.checked),
  createReasoningView: () => createReasoningView(document, elements.conversation),
  contextOptions: () => ({
    includeSelection: elements.includeSelection.checked,
    includeCode: elements.includeCode.checked,
    includeConsole: elements.includeConsole.checked,
    datasetSearch: elements.datasetSearch.checked,
    docsSearch: elements.docsSearch.checked
  }),
  requiresEditorContext,
  isNearScrollEnd: () => isNearScrollEnd(elements.conversation, 64),
  isInitialized: () => initialized,
  isBusy: () => busy
});

initialize().catch(handleInitializeFailure);

async function initialize() {
  initializing = true;
  try {
    bindEvents();
    await loadSettings();
    await restoreChatHistory();
    await restoreMessageQueue();
    await restoreActivePlan();
    await readEditor({ quiet: true });
    await restoreCandidate();
    initialized = true;
    if (!busy) {
      setBusy(false);
      if (!orchestrator.isQueuePaused() && orchestrator.getQueue().length) {
        queueMicrotask(() => orchestrator.drainMessageQueue());
      }
    }
  } finally {
    initializing = false;
  }
}

function handleInitializeFailure(error) {
  showError(error);
  renderInitializeRetry(error);
}

function renderInitializeRetry(error) {
  const container = elements.conversation;
  if (!container) return;
  if (initRetryButton) initRetryButton.closest(".init-retry-notice")?.remove();
  const notice = document.createElement("div");
  notice.className = "chat-entry init-retry-notice";
  const text = document.createElement("p");
  text.textContent = `初始化失败：${safeError(error)}`;
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = "重试初始化";
  button.addEventListener("click", () => {
    retryInitialize().catch(handleInitializeFailure);
  });
  notice.append(text, button);
  container.appendChild(notice);
  initRetryButton = button;
}

async function retryInitialize() {
  if (initialized || initializing) return;
  if (initRetryButton) {
    initRetryButton.disabled = true;
    initRetryButton.textContent = "正在初始化…";
  }
  setStatus("正在重试初始化…");
  try {
    await initialize();
    initRetryButton?.closest(".init-retry-notice")?.remove();
    initRetryButton = null;
    setStatus("初始化完成");
  } catch (error) {
    showError(error);
    if (initRetryButton) {
      initRetryButton.disabled = false;
      initRetryButton.textContent = "重试初始化";
    } else {
      renderInitializeRetry(error);
    }
  }
}

function bindEvents() {
  if (eventsBound) return;
  eventsBound = true;
  elements.settingsButton.addEventListener("click", () => toggleSettings());
  elements.closeSettingsButton.addEventListener("click", () => closeSettings());
  elements.settingsBackdrop.addEventListener("click", () => closeSettings());
  elements.settingsForm.addEventListener("submit", saveSettings);
  elements.clearKeyButton.addEventListener("click", clearKey);
  elements.clearChatButton.addEventListener("click", startNewConversation);
  elements.thinkingEnabled.addEventListener("change", syncThinkingControls);
  elements.baseUrl.addEventListener("input", updateProviderCapabilityHint);
  elements.model.addEventListener("input", updateProviderCapabilityHint);
  elements.providerPreset.addEventListener("change", applyProviderPreset);
  elements.readButton.addEventListener("click", async () => {
    await readEditor();
  });
  elements.runButton.addEventListener("click", runScript);
  elements.geeRestButton.addEventListener("click", () => toggleGeeRestPanel());
  elements.geeRestCloseButton.addEventListener("click", () => toggleGeeRestPanel(false));
  elements.geeRestRefreshButton.addEventListener("click", () => refreshGeeRest().catch(showError));
  elements.geeAssetMoreButton.addEventListener("click", () => loadGeeAssets(geeAssetNextToken).catch(showError));
  elements.geeTaskMoreButton.addEventListener("click", () => loadGeeTasks(geeTaskNextToken).catch(showError));
  elements.copyRedirectUriButton.addEventListener("click", copyGeeRedirectUri);
  elements.promptForm.addEventListener("submit", sendPrompt);
  elements.stopButton.addEventListener("click", stopRequest);
  elements.applyButton.addEventListener("click", () => applyCandidate("replace_all"));
  elements.insertButton.addEventListener("click", () => applyCandidate("insert"));
  elements.copyButton.addEventListener("click", copyCandidate);
  elements.dismissButton.addEventListener("click", () => dismissCandidate().catch(showError));
  elements.datasetSearch.addEventListener("change", saveToolPreferences);
  elements.docsSearch.addEventListener("change", saveToolPreferences);
  elements.includeConsole.addEventListener("change", () => renderConsoleReadStatus());
  elements.directModeButton.addEventListener("click", () => selectComposerMode(false));
  elements.planModeButton.addEventListener("click", () => selectComposerMode(true));
  elements.confirmPlanButton.addEventListener("click", generateFromConfirmedPlan);
  elements.continuePlanButton.addEventListener("click", continuePlanClarification);
  elements.cancelPlanButton.addEventListener("click", cancelPlan);
  elements.scrollToLatestButton.addEventListener("click", () => scrollConversationToEnd({ force: true, smooth: true }));
  elements.conversation.addEventListener("scroll", handleConversationScroll, { passive: true });
  elements.queueList.addEventListener("click", handleQueueAction);
  elements.resumeQueueButton.addEventListener("click", resumeMessageQueue);
  elements.clearQueueButton.addEventListener("click", clearMessageQueue);
  for (const button of document.querySelectorAll(".starter-prompt")) {
    button.addEventListener("click", () => useStarterPrompt(button));
  }
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !elements.settingsPanel.classList.contains("hidden")) closeSettings();
    if (event.key === "Enter" && event.ctrlKey && document.activeElement === elements.prompt) {
      elements.promptForm.requestSubmit();
    }
  });
}

function toggleSettings(forceOpen = null) {
  const shouldOpen = forceOpen ?? elements.settingsPanel.classList.contains("hidden");
  setSettingsPanelOpen({
    panel: elements.settingsPanel,
    button: elements.settingsButton,
    keyInput: elements.apiKey,
    backdrop: elements.settingsBackdrop
  }, shouldOpen);
}

function openSettings({ focusKey = false } = {}) {
  setSettingsPanelOpen({
    panel: elements.settingsPanel,
    button: elements.settingsButton,
    keyInput: elements.apiKey,
    backdrop: elements.settingsBackdrop
  }, true, { focusKey });
}

function closeSettings() {
  toggleSettings(false);
}

async function loadSettings() {
  const response = await chrome.runtime.sendMessage({ type: "SETTINGS_GET" });
  if (!response?.ok) throw new Error(response?.error || "无法读取设置");
  currentSettings = response.settings;
  elements.baseUrl.value = currentSettings.baseUrl;
  elements.model.value = currentSettings.model;
  elements.projectId.value = currentSettings.projectId || "";
  elements.geeClientId.value = currentSettings.geeClientId || "";
  elements.rememberApiKey.checked = currentSettings.rememberApiKey;
  elements.datasetSearch.checked = currentSettings.datasetSearch !== false;
  elements.docsSearch.checked = currentSettings.docsSearch !== false;
  elements.thinkingEnabled.checked = currentSettings.thinkingEnabled !== false;
  elements.reasoningEffort.value = currentSettings.reasoningEffort === "max" ? "max" : "high";
  elements.compatibleStreaming.checked = currentSettings.compatibleStreaming === true;
  elements.keyStatus.textContent = currentSettings.hasApiKey
    ? "已配置 API Key（不会在界面中回显）"
    : "尚未配置 API Key";
  syncThinkingControls();
  updateProviderCapabilityHint();
  renderGeeRedirectUri();
  if (!currentSettings.hasApiKey) openSettings({ focusKey: true });
}

function syncThinkingControls() {
  setThinkingControlEnabled(elements.reasoningEffort, elements.thinkingEnabled.checked);
}

function updateProviderCapabilityHint() {
  // 预设下拉框始终是 baseUrl / model 两个字段的镜像：手动改成与预设
  // 不一致的值时自动回落到「自定义」，避免下拉状态和字段脱节。
  const matched = matchProviderPreset(elements.baseUrl.value, elements.model.value);
  elements.providerPreset.value = matched || CUSTOM_PROVIDER_ID;
  const supported = isOfficialDeepSeekV4(elements.baseUrl.value, elements.model.value);
  elements.providerCapabilityHint.textContent = supported
    ? "当前接口支持 DeepSeek V4 实时思考和 High / Max 强度。"
    : "兼容模式不支持实时思考；将使用普通非流式调用，不发送 DeepSeek 专用参数。";
}

// 服务商预设只填充 API 地址与默认模型名；字段保持可编辑，
// 「自定义」（无命中预设）不改动任何现有内容。
function applyProviderPreset() {
  const preset = findProviderPreset(elements.providerPreset.value);
  if (!preset) return;
  elements.baseUrl.value = preset.baseUrl;
  elements.model.value = preset.defaultModel;
  updateProviderCapabilityHint();
}

async function saveToolPreferences() {
  if (elements.planMode.checked) return;
  const response = await chrome.runtime.sendMessage({
    type: "TOOLS_PREFS_SAVE",
    payload: {
      datasetSearch: elements.datasetSearch.checked,
      docsSearch: elements.docsSearch.checked
    }
  });
  if (response?.ok && currentSettings) {
    currentSettings.datasetSearch = elements.datasetSearch.checked;
    currentSettings.docsSearch = elements.docsSearch.checked;
  }
}

async function saveSettings(event) {
  event.preventDefault();
  setStatus("正在保存设置…");
  try {
    const baseUrl = elements.baseUrl.value.trim();
    await ensureHostPermission(baseUrl);
    const response = await chrome.runtime.sendMessage({
      type: "SETTINGS_SAVE",
      payload: {
        baseUrl,
        model: elements.model.value,
        projectId: elements.projectId.value,
        geeClientId: elements.geeClientId.value,
        apiKey: elements.apiKey.value,
        rememberApiKey: elements.rememberApiKey.checked,
        thinkingEnabled: elements.thinkingEnabled.checked,
        reasoningEffort: elements.reasoningEffort.value,
        compatibleStreaming: elements.compatibleStreaming.checked
      }
    });
    if (!response?.ok) throw new Error(response?.error || "保存设置失败");
    currentSettings = response.settings;
    elements.apiKey.value = "";
    elements.keyStatus.textContent = currentSettings.hasApiKey
      ? "已配置 API Key（不会在界面中回显）"
      : "尚未配置 API Key";
    updateProviderCapabilityHint();
    setStatus("设置已保存");
    closeSettings();
  } catch (error) {
    showError(error);
  }
}

async function clearKey() {
  const response = await chrome.runtime.sendMessage({ type: "SETTINGS_CLEAR_KEY" });
  if (!response?.ok) return showError(response?.error || "清除密钥失败");
  elements.apiKey.value = "";
  elements.keyStatus.textContent = "尚未配置 API Key";
  if (currentSettings) currentSettings.hasApiKey = false;
  setStatus("API Key 已清除");
}

// ---- Earth Engine REST 直连面板（资产 / 任务）。令牌与授权完全由
// service worker 中的独立 OAuth 客户端编排，这里只负责展示与触发。
let geeAssetItems = [];
let geeTaskItems = [];
let geeAssetNextToken = "";
let geeTaskNextToken = "";
let geeAssetLoading = false;
let geeTaskLoading = false;

function renderGeeRedirectUri() {
  try {
    elements.geeRedirectUri.textContent = chrome.identity.getRedirectURL();
  } catch {
    elements.geeRedirectUri.textContent = "当前环境无法获取重定向 URI";
  }
}

async function copyGeeRedirectUri() {
  try {
    await navigator.clipboard.writeText(elements.geeRedirectUri.textContent);
    setStatus("已复制重定向 URI，请填入 Google Cloud Console 的 OAuth 客户端");
  } catch (error) {
    showError(error);
  }
}

function toggleGeeRestPanel(forceOpen = null) {
  const panel = elements.geeRestPanel;
  const shouldOpen = forceOpen ?? panel.classList.contains("hidden");
  panel.classList.toggle("hidden", !shouldOpen);
  panel.setAttribute("aria-hidden", shouldOpen ? "false" : "true");
  elements.geeRestButton.setAttribute("aria-expanded", shouldOpen ? "true" : "false");
  if (shouldOpen && !geeAssetItems.length && !geeTaskItems.length) {
    refreshGeeRest().catch(showError);
  }
}

function geeRestConfigured() {
  return Boolean(currentSettings?.geeClientId && currentSettings?.projectId);
}

const GEE_REST_GUIDE = "请先在设置中填写“Google OAuth 客户端 ID”和“Earth Engine Project ID”，即可通过 REST 直连浏览项目资产与任务。";

function setGeeRestGuide(message) {
  elements.geeRestGuide.textContent = message;
  elements.geeRestGuide.classList.toggle("hidden", !message);
}

function setGeeRestStatus(message) {
  elements.geeRestStatus.textContent = message;
  elements.geeRestStatus.classList.toggle("hidden", !message);
}

// Assets and tasks keep independent loading/error state: a task success must
// never blank an asset error and an asset failure must never hide task rows.
function geeRestBusy() {
  return geeAssetLoading || geeTaskLoading;
}

function syncGeeRestRefreshButton() {
  elements.geeRestRefreshButton.disabled = geeRestBusy();
}

function setGeeColumnError(kind, message) {
  const element = kind === "tasks" ? elements.geeTaskError : elements.geeAssetError;
  element.textContent = message;
  element.classList.toggle("hidden", !message);
}

// Sequential on purpose: the first call may open the interactive auth flow,
// and the second one reuses the session-cached token. Refresh first clears
// both lists and both column errors so stale rows never survive a reload.
async function refreshGeeRest() {
  geeAssetItems = [];
  geeAssetNextToken = "";
  geeTaskItems = [];
  geeTaskNextToken = "";
  setGeeColumnError("assets", "");
  setGeeColumnError("tasks", "");
  renderGeeAssets();
  renderGeeTasks();
  await loadGeeAssets("");
  await loadGeeTasks();
}

async function loadGeeAssets(pageToken = "") {
  if (geeAssetLoading) return;
  if (!geeRestConfigured()) {
    setGeeRestGuide(GEE_REST_GUIDE);
    setGeeRestStatus("");
    renderGeeAssets();
    return;
  }
  setGeeRestGuide("");
  geeAssetLoading = true;
  syncGeeRestRefreshButton();
  setGeeRestStatus(pageToken ? "正在加载下一页资产…" : "正在授权并加载资产…");
  try {
    const response = await chrome.runtime.sendMessage({
      type: "GEE_REST_LIST_ASSETS",
      payload: { requestId: crypto.randomUUID(), pageToken }
    });
    if (!response?.ok) throw new Error(response?.error || "加载资产失败");
    geeAssetItems = pageToken ? [...geeAssetItems, ...response.items] : response.items;
    geeAssetNextToken = response.nextPageToken || "";
    setGeeColumnError("assets", "");
    renderGeeAssets();
    setGeeRestStatus("");
  } catch (error) {
    if (/请先在设置中填写/.test(safeError(error))) {
      setGeeRestGuide(GEE_REST_GUIDE);
    } else {
      setGeeColumnError("assets", `资产加载失败：${safeError(error)}`);
    }
    setGeeRestStatus("");
  } finally {
    geeAssetLoading = false;
    syncGeeRestRefreshButton();
  }
}

async function loadGeeTasks(pageToken = "") {
  if (geeTaskLoading) return;
  if (!geeRestConfigured()) {
    renderGeeTasks();
    return;
  }
  geeTaskLoading = true;
  syncGeeRestRefreshButton();
  setGeeRestStatus(geeAssetLoading ? "正在加载资产 / 任务…" : (pageToken ? "正在加载更多任务…" : "正在加载任务…"));
  try {
    const response = await chrome.runtime.sendMessage({
      type: "GEE_REST_LIST_TASKS",
      payload: { requestId: crypto.randomUUID(), pageToken }
    });
    if (!response?.ok) throw new Error(response?.error || "加载任务失败");
    geeTaskItems = pageToken ? [...geeTaskItems, ...response.items] : response.items;
    geeTaskNextToken = response.nextPageToken || "";
    setGeeColumnError("tasks", "");
    renderGeeTasks();
    setGeeRestStatus("");
  } catch (error) {
    if (/请先在设置中填写/.test(safeError(error))) {
      setGeeRestGuide(GEE_REST_GUIDE);
    } else {
      setGeeColumnError("tasks", `任务加载失败：${safeError(error)}`);
    }
    setGeeRestStatus("");
  } finally {
    geeTaskLoading = false;
    syncGeeRestRefreshButton();
  }
}

function renderGeeAssets() {
  const list = elements.geeAssetList;
  list.replaceChildren();
  if (!geeAssetItems.length) {
    if (geeRestConfigured()) {
      const empty = document.createElement("p");
      empty.className = "hint";
      empty.textContent = "暂无资产";
      list.appendChild(empty);
    }
  }
  for (const item of geeAssetItems) {
    const row = document.createElement("div");
    row.className = "gee-rest-item";
    const main = document.createElement("div");
    main.className = "gee-rest-item-main";
    const name = document.createElement("span");
    name.className = "gee-rest-item-name";
    name.textContent = item.name;
    name.title = item.id;
    const type = document.createElement("span");
    type.className = "gee-rest-item-type";
    type.textContent = item.type;
    main.append(name, type);
    const actions = document.createElement("div");
    actions.className = "gee-rest-item-actions";
    const copyButton = document.createElement("button");
    copyButton.type = "button";
    copyButton.textContent = "复制 ID";
    copyButton.addEventListener("click", () => {
      navigator.clipboard.writeText(item.id)
        .then(() => setStatus("已复制资产 ID"))
        .catch(showError);
    });
    const injectButton = document.createElement("button");
    injectButton.type = "button";
    injectButton.textContent = "注入对话";
    injectButton.addEventListener("click", () => injectAssetIntoPrompt(item.id));
    actions.append(copyButton, injectButton);
    row.append(main, actions);
    list.appendChild(row);
  }
  elements.geeAssetMoreButton.classList.toggle("hidden", !geeAssetNextToken);
}

function injectAssetIntoPrompt(assetId) {
  const marker = `资产: ${assetId}`;
  const current = elements.prompt.value;
  elements.prompt.value = current ? `${current}\n${marker}` : marker;
  elements.prompt.focus();
  setStatus("已把资产 ID 注入输入框");
}

function renderGeeTasks() {
  const list = elements.geeTaskList;
  list.replaceChildren();
  if (!geeTaskItems.length) {
    if (geeRestConfigured()) {
      const empty = document.createElement("p");
      empty.className = "hint";
      empty.textContent = "暂无任务";
      list.appendChild(empty);
    }
  } else {
    for (const item of geeTaskItems) {
      const row = document.createElement("div");
      row.className = "gee-rest-item";
      const main = document.createElement("div");
      main.className = "gee-rest-item-main";
      const name = document.createElement("span");
      name.className = "gee-rest-item-name";
      name.textContent = item.name || "（未命名任务）";
      const state = document.createElement("span");
      state.className = "gee-rest-item-type";
      state.textContent = item.state;
      main.append(name, state);
      row.appendChild(main);
      if (item.summary) {
        const summary = document.createElement("p");
        summary.className = "hint";
        summary.textContent = item.summary;
        row.appendChild(summary);
      }
      list.appendChild(row);
    }
  }
  elements.geeTaskMoreButton.classList.toggle("hidden", !geeTaskNextToken);
}

async function restoreChatHistory() {
  chatHistory = await readChatHistory(chrome.storage.local);
  orchestrator.setDirectConversation(alignConversationToUser(
    chatHistory
      .filter((entry) => entry.purpose === "direct" && ["user", "assistant"].includes(entry.role))
      .map((entry) => ({ role: entry.role, content: entry.text }))
      .slice(-12)
  ));
  elements.conversation.replaceChildren();
  for (const entry of chatHistory) elements.conversation.appendChild(renderChatEntry(entry));
  syncConversationEmptyState();
  scrollConversationToEnd({ force: true });
}

function persistChatHistory() {
  const snapshot = sanitizeChatHistory(chatHistory);
  chatHistoryWrite = chatHistoryWrite
    .catch(() => undefined)
    .then(() => setWithQuotaEviction(chrome.storage.local, {
      targetKey: CHAT_HISTORY_KEY,
      targetValue: snapshot,
      chatKey: CHAT_HISTORY_KEY,
      candidateKey: CODE_CANDIDATE_KEY
    }))
    .then((outcome) => {
      applyStorageEvictionOutcome(outcome);
      if (!outcome.persisted) {
        const error = new Error("本地存储空间不足，对话记录未能保存");
        error.persistNotified = true;
        throw error;
      }
    });
  return chatHistoryWrite;
}

async function startNewConversation() {
  if (!initialized) return showError("助手仍在初始化，请稍候");
  if (busy) return showError("当前任务仍在运行，请先停止后再开始新对话");
  const hasCurrentWork = chatHistory.length || orchestrator.getActivePlan() || candidate || orchestrator.getQueue().length;
  if (hasCurrentWork && !confirm("开始新对话会清除当前聊天、计划、代码卡和后续消息队列。确定继续吗？")) return;
  chatHistory = [];
  orchestrator.resetForNewConversation();
  candidate = null;
  resetPlanOptionSelections();
  elements.conversation.replaceChildren(
    elements.conversationEmpty,
    elements.toolResults,
    elements.planPanel,
    elements.candidatePanel
  );
  renderToolSources([], []);
  await Promise.all([
    chatHistoryWrite.catch((error) => console.error("等待对话写入完成时出错：", error)),
    candidateWrite.catch((error) => console.error("等待代码候选写入完成时出错：", error)),
    queueWrite.catch((error) => console.error("等待消息队列写入完成时出错：", error))
  ]);
  await Promise.all([
    chrome.storage.local.remove(CHAT_HISTORY_KEY),
    chrome.storage.local.remove(ACTIVE_PLAN_KEY),
    chrome.storage.local.remove(CODE_CANDIDATE_KEY),
    chrome.storage.local.remove(MESSAGE_QUEUE_KEY)
  ]);
  selectComposerMode(false, { quiet: true });
  renderPlan();
  elements.candidatePanel.classList.add("hidden");
  elements.candidatePanel.classList.remove("candidate-applied");
  renderMessageQueue();
  syncConversationEmptyState();
  scrollConversationToEnd({ force: true });
  elements.prompt.value = "";
  setStatus("新对话已就绪", "success");
}

async function restoreMessageQueue() {
  const restored = await readMessageQueue(chrome.storage.local);
  orchestrator.setQueue(restored.items);
  orchestrator.setQueuePaused(restored.paused);
  renderMessageQueue();
}

function persistMessageQueue() {
  queueWrite = queueWrite
    .catch(() => undefined)
    .then(() => writeMessageQueueSnapshot(chrome.storage.local, {
      items: orchestrator.getQueue(),
      paused: orchestrator.isQueuePaused()
    }));
  return queueWrite;
}

function updateQueueState(items, { paused = orchestrator.isQueuePaused() } = {}) {
  orchestrator.setQueue(items);
  orchestrator.setQueuePaused(items.length ? paused : false);
  renderMessageQueue();
  return persistMessageQueue();
}

function enqueuePrompt(prompt, planRequest) {
  orchestrator.enqueuePrompt(prompt, planRequest);
  persistMessageQueue().catch((error) => reportPersistFailure("queue", error));
}

function renderMessageQueue() {
  const queuedMessages = orchestrator.getQueue();
  const queuePaused = orchestrator.isQueuePaused();
  elements.queueList.replaceChildren();
  elements.queuePanel.classList.toggle("hidden", queuedMessages.length === 0);
  elements.queueCount.textContent = queuedMessages.length ? `(${queuedMessages.length})` : "";
  elements.resumeQueueButton.classList.toggle("hidden", !queuePaused || queuedMessages.length === 0);
  // ISS-010: every queue change (remove/edit/priority/clear/restore/drain)
  // flows through this render, so the badge must follow it too instead of
  // waiting for the next busy toggle.
  refreshTurnStateBadge();

  queuedMessages.forEach((item, index) => {
    const card = document.createElement("article");
    card.className = "queue-item";
    card.dataset.queueId = item.id;
    const main = document.createElement("div");
    main.className = "queue-item-main";
    const order = document.createElement("span");
    order.className = "queue-index";
    order.textContent = `${index + 1}.`;
    const text = document.createElement("span");
    text.className = "queue-text";
    text.textContent = item.text;
    text.title = item.text;
    const mode = document.createElement("span");
    mode.className = "queue-mode";
    mode.textContent = item.planMode ? "计划" : "问答";
    main.append(order, text, mode);

    const actions = document.createElement("div");
    actions.className = "queue-actions";
    for (const [action, label] of [["priority", "下一条"], ["edit", "编辑"], ["delete", "删除"]]) {
      const button = document.createElement("button");
      button.type = "button";
      button.dataset.queueAction = action;
      button.dataset.queueId = item.id;
      button.textContent = label;
      actions.append(button);
    }
    card.append(main, actions);
    elements.queueList.append(card);
  });
}

function handleQueueAction(event) {
  const button = event.target.closest?.("[data-queue-action]");
  if (!button) return;
  const id = button.dataset.queueId;
  const item = orchestrator.getQueue().find((entry) => entry.id === id);
  if (!item) return;
  let items = orchestrator.getQueue();
  if (button.dataset.queueAction === "edit") {
    items = removeQueuedMessage(items, id);
    selectComposerMode(item.planMode, { quiet: true });
    elements.prompt.value = item.text;
    elements.prompt.focus();
    setStatus("已移回输入框，可修改后重新发送");
  } else if (button.dataset.queueAction === "priority") {
    items = prioritizeQueuedMessage(items, id);
    setStatus("已设为下一条消息");
  } else if (button.dataset.queueAction === "delete") {
    items = removeQueuedMessage(items, id);
    setStatus("已删除后续消息");
  }
  updateQueueState(items).catch(() => setStatus("队列更新保存失败", "error"));
}

function clearMessageQueue() {
  if (!orchestrator.getQueue().length) return;
  if (!confirm("确定清空所有后续消息吗？")) return;
  updateQueueState([], { paused: false }).catch((error) => reportPersistFailure("queue", error));
  setStatus("后续消息队列已清空");
}

function resumeMessageQueue() {
  orchestrator.setQueuePaused(false);
  renderMessageQueue();
  persistMessageQueue().catch((error) => reportPersistFailure("queue", error));
  setStatus("后续消息队列已继续");
  queueMicrotask(() => orchestrator.drainMessageQueue());
}

async function restoreCandidate() {
  candidate = await readCodeCandidate(chrome.storage.local);
  if (!candidate) {
    await chrome.storage.local.remove(CODE_CANDIDATE_KEY);
    return;
  }
  renderCandidateCard({ scroll: false });
}

function persistCandidate() {
  const snapshot = serializeCodeCandidate(candidate);
  if (!snapshot) return Promise.reject(new Error("代码候选状态无效，无法保存"));
  candidateWrite = candidateWrite
    .catch(() => undefined)
    .then(() => setWithQuotaEviction(chrome.storage.local, {
      targetKey: CODE_CANDIDATE_KEY,
      targetValue: snapshot,
      chatKey: CHAT_HISTORY_KEY,
      candidateKey: CODE_CANDIDATE_KEY
    }))
    .then((outcome) => {
      applyStorageEvictionOutcome(outcome);
      if (!outcome.persisted) {
        const error = new Error(outcome.degraded
          ? "本地存储空间不足，代码候选仅保留了元信息，完整代码卡未保存"
          : "本地存储空间不足，代码候选未能保存");
        error.persistNotified = true;
        throw error;
      }
    });
  return candidateWrite;
}

// Applies one eviction outcome to all affected in-memory state and shows a
// single visible notice: finalValues is the source of truth for what actually
// landed on disk, so the chat transcript and its DOM are resynced whenever
// eviction trimmed them (M5), and a degraded candidate is never reported as
// saved.
function applyStorageEvictionOutcome(outcome) {
  if (!outcome) return;
  const finalValues = outcome.finalValues || {};
  if (outcome.evictions.includes("chat-history-halved")
    && Object.prototype.hasOwnProperty.call(finalValues, CHAT_HISTORY_KEY)) {
    resyncEvictedChatHistory(finalValues[CHAT_HISTORY_KEY]);
  }
  if (!outcome.evictions.length && !outcome.degraded) return;
  console.warn("为腾出本地存储空间已裁剪数据：", outcome.evictions.join(", "));
  if (outcome.degraded && finalValues[CODE_CANDIDATE_KEY] && !String(finalValues[CODE_CANDIDATE_KEY].code || "")) {
    setStatus("本地存储空间不足，代码卡已降级为仅元信息，未完整保存", "error");
    return;
  }
  if (outcome.evictions.includes("candidate-meta-only")) {
    setStatus("本地存储空间紧张，代码卡已降级为仅元信息以保全对话记录", "error");
    return;
  }
  setStatus("本地存储空间紧张，已自动裁剪较早的数据", "error");
}

// Eviction trimmed persisted chat entries: keep the in-memory history, the
// rendered conversation and the orchestrator's send window aligned with what
// survived on disk.
function resyncEvictedChatHistory(entries) {
  chatHistory = sanitizeChatHistory(entries);
  const retained = new Set(chatHistory.map((entry) => entry.id));
  for (const node of elements.conversation.querySelectorAll("[data-chat-id]")) {
    if (!retained.has(node.dataset.chatId)) node.remove();
  }
  orchestrator.setDirectConversation(alignConversationToUser(
    chatHistory
      .filter((entry) => entry.purpose === "direct" && ["user", "assistant"].includes(entry.role))
      .map((entry) => ({ role: entry.role, content: entry.text }))
      .slice(-12)
  ));
  syncConversationEmptyState();
}

// Throttled, visible degradation for failed local persistence: log the cause,
// but show at most one status notice per kind within the cooldown window so
// repeated quota failures never flood the status bar.
const persistFailureNotifiedAt = new Map();
const PERSIST_FAILURE_NOTIFY_COOLDOWN_MS = 10000;

function reportPersistFailure(kind, error) {
  console.error(`本地保存失败（${kind}），仅保留在当前会话：`, error);
  if (error?.persistNotified) return;
  const now = Date.now();
  const last = persistFailureNotifiedAt.get(kind);
  if (typeof last === "number" && now - last < PERSIST_FAILURE_NOTIFY_COOLDOWN_MS) return;
  persistFailureNotifiedAt.set(kind, now);
  setStatus("本地保存失败，仅保留在当前会话", "error");
}

async function restoreActivePlan() {
  const restored = await readActivePlan(chrome.storage.local);
  if (restored) {
    elements.planMode.checked = true;
    orchestrator.updateActivePlan(restored);
    await persistActivePlan();
  }
  syncPlanModeUi();
  renderPlan();
}

async function persistActivePlan(plan = orchestrator.getActivePlan()) {
  const storedPlan = await serializeActivePlan(chrome.storage.local, plan);
  if (plan && !storedPlan) throw new Error("分析计划状态无效，无法保存");
  if (storedPlan) await chrome.storage.local.set({ [ACTIVE_PLAN_KEY]: storedPlan });
  return storedPlan;
}

async function clearActivePlan() {
  orchestrator.updateActivePlan(null);
  resetPlanOptionSelections();
  await chrome.storage.local.remove(ACTIVE_PLAN_KEY);
  renderPlan();
}

function resetPlanOptionSelections() {
  planOptionSelections = new Map();
  submittedPlanAnswerIds = new Set();
}

function selectComposerMode(planMode, { quiet = false } = {}) {
  if (!initialized) {
    setComposerModeView(elements, false);
    return showError("助手仍在初始化，请稍候");
  }
  setComposerModeView(elements, planMode);
  syncPlanModeUi();
  renderPlan();
  if (!quiet) {
    setStatus(elements.planMode.checked
      ? (orchestrator.getActivePlan() ? "计划模式已选择；可继续当前方案" : "计划模式已选择，请输入计算需求")
      : (orchestrator.getActivePlan() ? "已切到问答；当前计划仍保留在对话中" : "问答模式已选择"));
  }
}

function useStarterPrompt(button) {
  selectComposerMode(button.dataset.plan === "true", { quiet: true });
  elements.prompt.value = button.dataset.prompt || "";
  elements.prompt.focus();
  setStatus("示例已填入，确认或修改后发送");
}

function syncPlanModeUi() {
  const enabled = elements.planMode.checked;
  setComposerModeView(elements, enabled);
  setPlanToolControls({
    hint: elements.planModeHint,
    panel: elements.planPanel,
    datasetSearch: elements.datasetSearch,
    docsSearch: elements.docsSearch
  }, {
    enabled,
    busy,
    panelVisible: enabled || Boolean(orchestrator.getActivePlan()),
    savedDatasetSearch: currentSettings?.datasetSearch !== false,
    savedDocsSearch: currentSettings?.docsSearch !== false
  });
}

async function readEditor({ quiet = false } = {}) {
  if (!quiet) setStatus("正在读取 Earth Engine 编辑器…");
  try {
    const { response, tab } = await sendToEditor({ type: "EDITOR_GET_STATE" });
    if (!response?.ok) throw new Error(response?.error || "读取编辑器失败");
    const consoleText = typeof response.consoleText === "string" ? response.consoleText : "";
    const consoleRead = normalizeConsoleRead(consoleText, response.consoleRead);
    consoleReadAttempted = true;
    editorState = { ...response.state, consoleText, consoleRead, tabId: tab.id };
    renderConsoleReadStatus(consoleRead);
    elements.scriptTitle.textContent = editorState.title.replace(/\s+-\s+Earth Engine Code Editor$/, "");
    elements.scriptMeta.textContent = `${editorState.code.length.toLocaleString()} 字符 · ${editorState.selection.length.toLocaleString()} 字符已选中`;
    elements.connectionBadge.textContent = "已连接";
    elements.connectionBadge.classList.remove("muted");
    elements.editorConnectionDot.classList.add("connected");
    if (!quiet) setStatus("代码已读取");
    return editorState;
  } catch (error) {
    consoleReadAttempted = true;
    editorState = null;
    renderConsoleReadStatus({ status: "unavailable", source: null, reason: "read_failed" });
    elements.connectionBadge.textContent = "未连接";
    elements.connectionBadge.classList.add("muted");
    elements.editorConnectionDot.classList.remove("connected");
    if (!quiet) showError(error);
    return null;
  }
}

function renderConsoleReadStatus(consoleRead = editorState?.consoleRead) {
  const view = getConsoleUiState(elements.includeConsole.checked, consoleRead, consoleReadAttempted);
  for (const state of ["captured", "empty", "unavailable"]) {
    elements.consoleContextChip.classList.toggle(`console-status-${state}`, view.state === state);
  }
  elements.includeConsoleLabel.textContent = view.label;
  elements.consoleContextChip.title = view.title;
  elements.includeConsole.setAttribute("aria-label", `${view.label}。${view.title}`);
}

async function sendPrompt(event) {
  event.preventDefault();
  const prompt = sanitizeChatText(elements.prompt.value);
  if (!initialized) return showError("助手仍在初始化，请稍候");
  if (!prompt) return;
  const planRequest = elements.planMode.checked;
  // ISS-009: lock every plan answer block contained in the outgoing text so a
  // re-rendered question card can never inject the same answer twice.
  if (planRequest) {
    for (const markerId of collectPlanAnswerMarkerIds(prompt)) {
      submittedPlanAnswerIds.add(markerId);
    }
  }
  elements.prompt.value = "";
  if (busy) {
    enqueuePrompt(prompt, planRequest);
    return;
  }
  await orchestrator.executePrompt(prompt, planRequest);
}

async function generateFromConfirmedPlan() {
  await orchestrator.generateFromConfirmedPlan();
}

function continuePlanClarification() {
  selectComposerMode(true, { quiet: true });
  elements.prompt.placeholder = `说明你希望如何修改方案 r${orchestrator.getActivePlan()?.planRevision || 1}；提交后会生成新版本`;
  elements.prompt.focus();
  setStatus(`请补充或修改方案 r${orchestrator.getActivePlan()?.planRevision || 1}；提交后旧版本确认会失效`);
}

async function cancelPlan() {
  if (!initialized) return showError("助手仍在初始化，请稍候");
  const activePlan = orchestrator.getActivePlan();
  if (!activePlan) return;
  if (!confirm("确定取消并删除当前长期保存的分析计划吗？")) return;
  appendMessage("assistant", `已取消分析计划 r${activePlan.planRevision || 1}。`, { purpose: "plan_action" });
  await clearActivePlan();
  elements.planMode.checked = false;
  syncPlanModeUi();
  setStatus("分析计划已取消并清除");
}

function renderToolSources(sources, warnings) {
  const follow = isNearScrollEnd(elements.conversation, 64);
  elements.toolSourceList.replaceChildren();
  elements.toolWarnings.textContent = warnings.join("；");
  elements.toolResultCount.textContent = `${sources.length} 条`;
  elements.toolResults.classList.toggle("hidden", sources.length === 0 && warnings.length === 0);
  if (sources.length === 0 && warnings.length === 0) {
    elements.toolActivityTitle.textContent = "检索官方资料";
    elements.toolResults.open = false;
    for (const name of ["processing", "success", "error"]) {
      elements.toolResults.classList.remove(`activity-${name}`);
    }
  }

  for (const source of sources) {
    const card = document.createElement("div");
    card.className = "tool-source";
    const kind = document.createElement("span");
    kind.className = "source-kind";
    kind.textContent = source.type === "dataset" ? "Dataset" : "Docs";
    const link = document.createElement("a");
    link.href = source.url;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.textContent = source.title;
    card.append(kind, link);
    if (source.snippet || source.datasetId) {
      const code = document.createElement("code");
      code.textContent = source.snippet || source.datasetId;
      card.append(code);
    }
    elements.toolSourceList.append(card);
  }
  if (!elements.toolResults.classList.contains("hidden")) {
    elements.conversation.appendChild(elements.toolResults);
  }
  syncConversationEmptyState();
  if (follow) scrollConversationToEnd();
}

function setToolActivityState(state, title, { collapse = false } = {}) {
  for (const name of ["processing", "success", "error"]) {
    elements.toolResults.classList.toggle(`activity-${name}`, name === state);
  }
  elements.toolActivityTitle.textContent = title;
  if (state === "processing") {
    elements.toolResults.classList.remove("hidden");
    elements.toolResults.open = true;
    elements.conversation.appendChild(elements.toolResults);
  }
  if (collapse) elements.toolResults.open = false;
}

function completeToolActivity() {
  if (elements.toolResults.classList.contains("hidden")) return;
  if (!elements.toolResults.classList.contains("activity-error")) {
    setToolActivityState("success", "官方资料 · 已完成", { collapse: true });
  }
}

function renderPlan() {
  const activePlan = orchestrator.getActivePlan();
  const follow = isNearScrollEnd(elements.conversation, 64);
  elements.planContent.replaceChildren();
  if (!elements.planMode.checked && !activePlan) {
    elements.planPanel.classList.add("hidden");
    elements.planPanel.classList.remove("activity-processing", "activity-success", "activity-error");
    syncConversationEmptyState();
    return;
  }
  elements.planPanel.classList.remove("hidden");
  const latestChatEntry = [...elements.conversation.querySelectorAll(".chat-entry")].at(-1);
  if (latestChatEntry?.classList.contains("error")) {
    elements.conversation.insertBefore(elements.planPanel, latestChatEntry);
  } else if (candidate?.planRevision != null && elements.candidatePanel.parentElement === elements.conversation) {
    elements.conversation.insertBefore(elements.planPanel, elements.candidatePanel);
  } else {
    elements.conversation.appendChild(elements.planPanel);
  }
  if (!activePlan) {
    elements.planPanel.classList.remove("activity-processing", "activity-success", "activity-error");
    elements.planTitle.textContent = "计划模式";
    elements.planStatusBadge.textContent = "等待需求";
    elements.planRevisionBadge.textContent = "尚无草案";
    elements.planStatusBadge.classList.add("muted");
    appendPlanParagraph("输入一个计算或分析需求后，我会先调研官方资料并提出关键问题。完成讨论后会给出可审阅计划；在你确认前不会生成代码。", "hint");
    elements.planActions.classList.add("hidden");
    syncConversationEmptyState();
    if (follow) scrollConversationToEnd();
    return;
  }

  const plan = activePlan.plan;
  const labels = {
    idle: "等待调研",
    researching: "正在调研",
    clarifying: "讨论需求",
    ready: "审阅方案",
    generating: "正在生成"
  };
  const titles = {
    idle: "计划调研",
    researching: "计划调研",
    clarifying: "需求澄清",
    ready: "可审阅分析计划",
    generating: "正在生成代码"
  };
  const phaseTitles = {
    decomposing: "需求拆解",
    researching: "逐步调研",
    clarifying: "需求澄清",
    reviewing: "可审阅分析计划"
  };
  const phaseLabels = {
    decomposing: "拆解中",
    researching: "调研中",
    clarifying: "等待确认",
    reviewing: "审阅方案"
  };
  elements.planTitle.textContent = phaseTitles[plan?.phase] || titles[activePlan.state] || "分析计划";
  elements.planStatusBadge.textContent = phaseLabels[plan?.phase] || labels[activePlan.state] || activePlan.state;
  elements.planRevisionBadge.textContent = activePlan.planRevision
    ? `方案 r${activePlan.planRevision}`
    : "调研中";
  elements.planStatusBadge.classList.toggle("muted", activePlan.state !== "ready");
  elements.planPanel.classList.toggle("activity-processing", ["researching", "generating"].includes(activePlan.state));
  elements.planPanel.classList.toggle("activity-success", activePlan.state === "ready");
  if (!plan) {
    elements.planTitle.textContent = "计划调研";
    elements.planStatusBadge.textContent = activePlan.state === "researching" ? "正在调研" : "等待调研";
    elements.planRevisionBadge.textContent = activePlan.state === "researching" ? "调研中" : "尚无草案";
    appendPlanParagraph(`原始需求：${activePlan.originalRequest}`);
    elements.planActions.classList.remove("hidden");
    elements.confirmPlanButton.classList.add("hidden");
    elements.continuePlanButton.classList.add("hidden");
    elements.cancelPlanButton.disabled = busy;
    syncConversationEmptyState();
    if (follow) scrollConversationToEnd();
    return;
  }
  if (plan.todoList?.length) {
    appendPlanHeading("TODO List");
    renderPlanTodoList(plan);
  }
  if (plan.researchSummary) {
    appendPlanHeading("调研结论");
    appendPlanParagraph(plan.researchSummary);
  }
  appendPlanHeading("目标");
  appendPlanParagraph(plan.goal || "尚未明确");
  appendPlanHeading("候选数据集");
  if (!plan.datasets.length) appendPlanParagraph("尚未确认候选数据集", "hint");
  for (const dataset of plan.datasets) renderPlanDataset(dataset);
  appendPlanHeading("已明确需求");
  renderPlanRequirements(plan.requirements);
  appendPlanHeading("方法");
  appendPlanValue(plan.method);
  appendPlanHeading("输出");
  appendPlanValue(plan.outputs);
  if (plan.assumptions?.length) {
    appendPlanHeading("当前假设");
    appendPlanValue(plan.assumptions);
  }
  if (plan.risks?.length) {
    appendPlanHeading("风险与限制");
    appendPlanValue(plan.risks);
  }
  if (plan.revisionSummary && activePlan.planRevision > 1) {
    appendPlanHeading("本轮修订");
    appendPlanValue(plan.revisionSummary);
  }
  if (plan.questions.length) {
    appendPlanHeading("待确认问题");
    for (const question of plan.questions) {
      renderPlanQuestion(question);
    }
  }

  const actions = getPlanActionState({
    hasPlan: true,
    state: activePlan.state,
    planStale: activePlan.planStale,
    busy
  });
  elements.planActions.classList.toggle("hidden", !actions.showActions);
  elements.confirmPlanButton.classList.toggle("hidden", !actions.showConfirm);
  elements.continuePlanButton.classList.toggle("hidden", !actions.showContinue);
  elements.confirmPlanButton.disabled = actions.disabled;
  elements.confirmPlanButton.textContent = `采用方案 r${activePlan.planRevision || 1} 并生成代码`;
  elements.continuePlanButton.disabled = actions.disabled;
  elements.cancelPlanButton.disabled = actions.disabled;
  syncConversationEmptyState();
  if (follow) scrollConversationToEnd();
}

function renderPlanTodoList(plan) {
  const list = document.createElement("div");
  list.className = "plan-todo-list";
  for (const todo of plan.todoList || []) {
    const card = document.createElement("article");
    card.className = `plan-todo plan-todo-${todo.status || "pending"}`;

    const header = document.createElement("div");
    header.className = "plan-todo-header";
    const title = document.createElement("strong");
    title.textContent = `${todo.id} · ${todo.title}`;
    const badge = document.createElement("span");
    badge.className = "plan-todo-status";
    badge.textContent = todo.status === "completed"
      ? "已完成"
      : todo.status === "in_progress"
        ? "进行中"
        : "待处理";
    header.append(title, badge);
    card.append(header);

    if (todo.objective) {
      const objective = document.createElement("p");
      objective.textContent = `目标：${todo.objective}`;
      card.append(objective);
    }
    if (todo.evidenceNeeded?.length) {
      const evidence = document.createElement("p");
      evidence.className = "plan-todo-evidence";
      evidence.textContent = `所需证据：${todo.evidenceNeeded.join("；")}`;
      card.append(evidence);
    }
    if (todo.result) {
      const result = document.createElement("p");
      result.className = "plan-todo-result";
      result.textContent = `结果：${todo.result}`;
      card.append(result);
    }
    if (plan.completedThisTurn?.includes(todo.id)) {
      const completed = document.createElement("span");
      completed.className = "plan-todo-turn-mark";
      completed.textContent = "本轮完成";
      card.append(completed);
    }
    list.append(card);
  }
  elements.planContent.append(list);
}

function appendPlanHeading(text) {
  const heading = document.createElement("h3");
  heading.textContent = text;
  elements.planContent.append(heading);
}

function appendPlanParagraph(text, className = "") {
  const paragraph = document.createElement("p");
  paragraph.textContent = String(text || "");
  if (className) paragraph.className = className;
  elements.planContent.append(paragraph);
}

function appendPlanValue(value) {
  if (Array.isArray(value)) {
    const list = document.createElement("ul");
    for (const entry of value) {
      const item = document.createElement("li");
      item.textContent = typeof entry === "string" ? entry : JSON.stringify(entry);
      list.append(item);
    }
    elements.planContent.append(list);
  } else {
    appendPlanParagraph(typeof value === "string" ? value : JSON.stringify(value || "尚未明确"));
  }
}

function renderPlanQuestion(question) {
  const prompt = question?.prompt || String(question || "");
  const markerId = planAnswerMarkerId({ questionId: question?.id, prompt });
  const answered = Boolean(markerId) && submittedPlanAnswerIds.has(markerId);
  const selection = markerId ? planOptionSelections.get(markerId) : null;
  const card = document.createElement("article");
  card.className = "plan-question-card";
  if (answered) card.classList.add("plan-question-answered");
  const questionText = document.createElement("p");
  questionText.textContent = prompt;
  card.append(questionText);

  if (question?.options?.length) {
    const options = document.createElement("div");
    options.className = "plan-options";
    for (const option of question.options) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "plan-option";
      const title = document.createElement("strong");
      title.textContent = option.label;
      if (option.recommended) {
        const mark = document.createElement("span");
        mark.className = "recommended-mark";
        mark.textContent = "推荐";
        title.append(mark);
      }
      button.append(title);
      if (option.description) {
        const description = document.createElement("span");
        description.textContent = option.description;
        button.append(description);
      }
      // ISS-009: restore the persisted selection on every re-render so the
      // checked state stays visible on the card.
      const selected = Boolean(selection && (selection.optionId === option.id || selection.label === option.label));
      button.classList.toggle("selected", selected);
      button.setAttribute("aria-pressed", String(selected));
      button.disabled = answered;
      button.addEventListener("click", () => selectPlanOption(question, option, button));
      options.append(button);
    }
    card.append(options);
  }

  if (answered) {
    const answeredHint = document.createElement("span");
    answeredHint.className = "hint plan-answered-hint";
    answeredHint.textContent = selection?.label
      ? `已选择「${selection.label}」，答案已提交；如需修改请在输入框补充说明。`
      : "该问题的答案已提交；如需修改请在输入框补充说明。";
    card.append(answeredHint);
  } else if (question?.allowFreeText !== false) {
    const hint = document.createElement("span");
    hint.className = "hint";
    hint.textContent = question?.options?.length
      ? "不同问题的选项会自动叠加；同一问题重新选择会替换原答案，勾选状态会保留在卡片上。"
      : "请在下方输入框中回答；可以补充自己的条件。";
    card.append(hint);
  }
  elements.planContent.append(card);
}

function selectPlanOption(question, option, selectedButton) {
  const prompt = question?.prompt || String(question || "");
  const markerId = planAnswerMarkerId({ questionId: question?.id, prompt });
  // ISS-009: an answer that already left the input must never be injected a
  // second time; the card keeps its checked state instead.
  if (markerId && submittedPlanAnswerIds.has(markerId)) {
    setStatus("该问题的答案已提交过，未重复注入输入框；如需修改请在输入框中补充说明");
    return;
  }
  elements.prompt.value = upsertPlanAnswerText(elements.prompt.value, {
    questionId: question?.id,
    prompt,
    option
  });
  if (markerId) {
    planOptionSelections.set(markerId, { optionId: option?.id || "", label: option?.label || "" });
  }
  for (const button of selectedButton?.parentElement?.querySelectorAll?.(".plan-option") || []) {
    const selected = button === selectedButton;
    button.classList.toggle("selected", selected);
    button.setAttribute("aria-pressed", String(selected));
  }
  elements.prompt.focus();
  const answerCount = countPlanAnswerBlocks(elements.prompt.value);
  setStatus(`已叠加 ${answerCount} 个问题的答案；可继续选择、修改后发送`);
}

function renderPlanDataset(dataset) {
  const card = document.createElement("div");
  card.className = "plan-dataset";
  const officialUrl = matchingOfficialSourceUrl(dataset);
  const title = document.createElement(officialUrl ? "a" : "strong");
  title.textContent = dataset.name || dataset.datasetId || "未命名数据集";
  if (officialUrl) {
    title.href = officialUrl;
    title.target = "_blank";
    title.rel = "noopener noreferrer";
  }
  card.append(title);
  for (const [label, value] of [
    ["ID", dataset.datasetId],
    ["覆盖", dataset.coverage],
    ["分辨率", dataset.spatialResolution],
    ["优势", dataset.advantages],
    ["限制", dataset.limitations],
    ["建议", dataset.recommendation]
  ]) {
    if (!value || (Array.isArray(value) && !value.length)) continue;
    const line = document.createElement("span");
    line.textContent = `${label}：${Array.isArray(value) ? value.join("；") : value}`;
    card.append(line);
  }
  elements.planContent.append(card);
}

function matchingOfficialSourceUrl(dataset) {
  const activePlan = orchestrator.getActivePlan();
  const datasetId = String(dataset.datasetId || "").toLowerCase();
  const datasetUrl = String(dataset.url || "");
  const source = activePlan?.sources?.find((item) => (
    (datasetId && String(item.datasetId || "").toLowerCase() === datasetId)
    || (datasetUrl && item.url === datasetUrl)
  ));
  return source?.url || "";
}

function renderPlanRequirements(requirements) {
  const list = document.createElement("ul");
  for (const [label, key] of [
    ["研究区", "area"],
    ["时间范围", "timeRange"],
    ["时间聚合", "temporalAggregation"],
    ["空间统计", "spatialStatistic"],
    ["质量控制", "qualityControl"]
  ]) {
    const item = document.createElement("li");
    const value = requirements?.[key];
    item.textContent = `${label}：${Array.isArray(value) ? value.join("；") : value || "尚未明确"}`;
    list.append(item);
  }
  elements.planContent.append(list);
}

function showCandidate(code, baseState = editorState, planRevision = null) {
  candidate = createCodeCandidate({
    code,
    baseCode: baseState?.code || "",
    baseRevision: baseState?.revision || "",
    tabId: baseState?.tabId || null,
    planRevision,
    status: "ready",
    createdAt: Date.now()
  });
  renderCandidateCard({ scroll: true });
  persistCandidate().catch((error) => reportPersistFailure("candidate", error));
}

function renderCandidateCard({ scroll = false } = {}) {
  if (!candidate) {
    elements.candidatePanel.classList.add("hidden");
    return;
  }
  const editorBound = Boolean(candidate.tabId && candidate.baseRevision);
  const applied = candidate.status === "applied";
  const follow = isNearScrollEnd(elements.conversation, 64);
  const diff = createLineDiff(candidate.baseCode, candidate.code);
  elements.candidateTitle.textContent = applied
    ? "已应用的完整脚本"
    : editorBound
      ? "建议修改"
      : "生成的完整脚本";
  elements.diffStats.textContent = editorBound
    ? `+${diff.additions} / -${diff.removals}`
    : `${candidate.code.split("\n").length} 行`;
  elements.diffView.replaceChildren(...renderDiff(diff.entries));
  elements.candidateCodeView.textContent = candidate.code;
  elements.candidateStatusBadge.textContent = applied ? "已应用" : "待应用";
  elements.candidateStatusBadge.classList.toggle("muted", !applied);
  elements.candidatePanel.classList.toggle("candidate-applied", applied);
  elements.candidatePanel.classList.toggle("activity-success", applied);
  elements.applyButton.classList.toggle("hidden", !editorBound || applied);
  elements.insertButton.classList.toggle("hidden", !editorBound || candidate.planRevision != null || applied);
  elements.copyButton.classList.toggle("primary", !editorBound || applied);
  if (applied) {
    const action = candidate.applicationMode === "insert" ? "插入到光标" : "替换完整脚本";
    elements.candidateHint.textContent = `代码已通过“${action}”写入编辑器；此卡片会保留，关闭前仍可查看或复制。`;
  } else {
    elements.candidateHint.textContent = editorBound
      ? "写入前会检查脚本是否被修改；可在 Ace 编辑器中使用 Ctrl+Z 撤销。"
      : "当前脚本未绑定 GEE 标签页。请复制代码并粘贴到 Earth Engine Code Editor；扩展不会自动运行。";
  }
  placeCandidateCard();
  elements.candidatePanel.classList.remove("hidden");
  syncConversationEmptyState();
  if (scroll && follow) {
    requestAnimationFrame(() => {
      elements.candidatePanel.scrollIntoView({ behavior: "smooth", block: "nearest" });
    });
  } else if (scroll) {
    updateScrollFollower();
  }
}

function placeCandidateCard() {
  elements.candidatePanel.dataset.candidateCreatedAt = String(candidate.createdAt);
  const laterMessage = [...elements.conversation.querySelectorAll("[data-chat-created-at]")]
    .find((message) => Number(message.dataset.chatCreatedAt) > candidate.createdAt);
  if (laterMessage) elements.conversation.insertBefore(elements.candidatePanel, laterMessage);
  else elements.conversation.appendChild(elements.candidatePanel);
}

function renderDiff(entries) {
  const fragment = document.createDocumentFragment();
  const visible = compactContext(entries, 4);
  for (const entry of visible) {
    const line = document.createElement("span");
    if (entry.type === "skip") {
      line.className = "diff-context";
      line.textContent = `  … 省略 ${entry.count} 行 …\n`;
    } else {
      line.className = `diff-${entry.type}`;
      const prefix = entry.type === "add" ? "+ " : entry.type === "remove" ? "- " : "  ";
      line.textContent = `${prefix}${entry.text}\n`;
    }
    fragment.appendChild(line);
  }
  return [fragment];
}

function compactContext(entries, radius) {
  const keep = new Set();
  entries.forEach((entry, index) => {
    if (entry.type !== "context") {
      for (let i = Math.max(0, index - radius); i <= Math.min(entries.length - 1, index + radius); i += 1) keep.add(i);
    }
  });
  const output = [];
  let skipped = 0;
  entries.forEach((entry, index) => {
    if (!keep.has(index) && entry.type === "context") {
      skipped += 1;
      return;
    }
    if (skipped) {
      output.push({ type: "skip", count: skipped });
      skipped = 0;
    }
    output.push(entry);
  });
  if (skipped) output.push({ type: "skip", count: skipped });
  return output;
}

async function applyCandidate(mode) {
  if (!candidate?.code || !candidate.tabId || !candidate.baseRevision) {
    return showError("没有与当前编辑器绑定的代码建议");
  }
  if (candidate.planRevision != null && orchestrator.getActivePlan()?.revision !== candidate.planRevision) {
    return showError("分析计划已经变化，请重新确认并生成代码");
  }
  if (candidate.planRevision != null && mode !== "replace_all") {
    return showError("计划模式生成的是完整脚本，只能替换完整脚本");
  }
  setStatus("正在写入编辑器…");
  try {
    const { response } = await sendToEditor({
      type: "EDITOR_APPLY_CODE",
      payload: {
        code: candidate.code,
        mode,
        expectedRevision: candidate.baseRevision
      }
    }, { expectedTabId: candidate.tabId });
    if (!response?.ok) throw new Error(response?.error || "写入编辑器失败");
    const completedPlan = candidate.planRevision != null;
    candidate = markCodeCandidateApplied(candidate, mode);
    renderCandidateCard({ scroll: false });
    persistCandidate().catch((error) => reportPersistFailure("candidate", error));
    await readEditor({ quiet: true });
    if (completedPlan) {
      await clearActivePlan();
      elements.planMode.checked = false;
      syncPlanModeUi();
    }
    setStatus(mode === "replace_all" ? "已替换完整脚本" : "已插入到光标");
  } catch (error) {
    showError(error);
  }
}

async function copyCandidate() {
  if (!candidate?.code) return showError("没有可复制的代码建议");
  try {
    await navigator.clipboard.writeText(candidate.code);
    setStatus("完整代码已复制到剪贴板");
  } catch (error) {
    showError(`复制失败：${safeError(error)}`);
  }
}

async function dismissCandidate() {
  const closingCreatedAt = candidate?.createdAt;
  await candidateWrite.catch(() => undefined);
  if (candidate?.createdAt !== closingCreatedAt) return;
  candidate = null;
  elements.candidatePanel.classList.add("hidden");
  elements.candidatePanel.classList.remove("candidate-applied");
  elements.applyButton.classList.remove("hidden");
  elements.insertButton.classList.remove("hidden");
  elements.copyButton.classList.remove("primary");
  elements.diffView.textContent = "";
  elements.candidateCodeView.textContent = "";
  await chrome.storage.local.remove(CODE_CANDIDATE_KEY);
  syncConversationEmptyState();
}

async function runScript() {
  if (!confirm("确定要运行当前 Earth Engine 脚本吗？运行可能创建导出任务或产生计算用量。")) return;
  const result = await sendToEditor({ type: "EDITOR_RUN" }).catch((error) => ({ response: { ok: false, error: safeError(error) } }));
  if (!result.response?.ok) return showError(result.response?.error || "运行失败");
  setStatus("已点击 Run；请在 Earth Engine 中查看结果");
}

function stopRequest() {
  const result = orchestrator.stopRequest((requestId) => {
    chrome.runtime.sendMessage({ type: "AI_ABORT", requestId });
  });
  if (!result.stopped) return;
  setStatus(result.queuePaused ? "正在停止当前任务；后续消息队列将暂停" : "正在停止当前任务…");
}

async function sendToEditor(message, { expectedTabId = null } = {}) {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  const activeTab = tabs[0];
  if (!activeTab?.id || !activeTab.url?.startsWith("https://code.earthengine.google.com/")) {
    throw new Error("当前标签页不是 Earth Engine Code Editor");
  }
  if (expectedTabId != null && activeTab.id !== expectedTabId) {
    throw new Error("当前 GEE 标签页不是生成此建议时的标签页，请切回原标签页");
  }
  return {
    tab: activeTab,
    response: await chrome.tabs.sendMessage(activeTab.id, message)
  };
}

async function ensureHostPermission(baseUrl) {
  const url = new URL(baseUrl);
  if (url.protocol === "http:" && !["localhost", "127.0.0.1"].includes(url.hostname)) {
    throw new Error("非本地 API 地址必须使用 HTTPS");
  }
  if (url.hostname === "api.deepseek.com") return;
  const pattern = `${url.protocol}//${url.hostname}/*`;
  const hasPermission = await chrome.permissions.contains({ origins: [pattern] });
  if (!hasPermission) {
    const granted = await chrome.permissions.request({ origins: [pattern] });
    if (!granted) throw new Error("未获得访问该模型 API 地址的权限");
  }
}

function appendMessage(role, text, { purpose = "direct" } = {}) {
  const follow = isNearScrollEnd(elements.conversation, 64);
  const entry = createChatEntry({
    id: crypto.randomUUID(),
    role,
    text,
    purpose,
    createdAt: Date.now()
  });
  chatHistory = appendChatEntry(chatHistory, entry);
  const retainedIds = new Set(chatHistory.map((item) => item.id));
  for (const oldMessage of elements.conversation.querySelectorAll("[data-chat-id]")) {
    if (!retainedIds.has(oldMessage.dataset.chatId)) oldMessage.remove();
  }
  const message = renderChatEntry(entry);
  elements.conversation.appendChild(message);
  persistChatHistory().catch((error) => reportPersistFailure("chat", error));
  syncConversationEmptyState();
  if (follow) scrollConversationToEnd();
  else updateScrollFollower();
  return message;
}

function renderChatEntry(entry) {
  const message = document.createElement("article");
  message.className = `message chat-entry ${entry.role}`;
  message.dataset.chatId = entry.id;
  message.dataset.chatCreatedAt = String(entry.createdAt);
  const meta = document.createElement("div");
  meta.className = "message-meta";
  const author = document.createElement("span");
  author.textContent = entry.role === "user" ? "你" : entry.role === "error" ? "请求错误" : "GEE AI";
  const time = document.createElement("time");
  time.dateTime = new Date(entry.createdAt).toISOString();
  time.textContent = new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit" })
    .format(entry.createdAt);
  meta.append(author, time);
  message.append(meta);
  if (entry.role === "assistant" && ["source", "plan"].includes(entry.purpose)) {
    const details = document.createElement("details");
    details.className = "transcript-details";
    const summary = document.createElement("summary");
    const revision = entry.text.match(/方案 r\d+/)?.[0];
    summary.textContent = entry.purpose === "source"
      ? entry.text.split("\n", 1)[0]
      : `${revision || "计划版本"} · 已保存完整快照`;
    const snapshot = document.createElement("div");
    snapshot.className = "message-body transcript-snapshot";
    snapshot.textContent = entry.text;
    details.append(summary, snapshot);
    message.append(details);
    message.append(createMessageActions(entry));
    return message;
  }
  const body = document.createElement("div");
  body.className = "message-body";
  body.textContent = entry.text;
  message.append(body);
  message.append(createMessageActions(entry));
  return message;
}

function createMessageActions(entry) {
  const actions = document.createElement("div");
  actions.className = "message-actions";
  const copy = document.createElement("button");
  copy.type = "button";
  copy.className = "message-action";
  copy.textContent = "复制";
  copy.setAttribute("aria-label", "复制这条消息");
  copy.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(entry.text);
      setStatus("消息已复制", "success");
    } catch (error) {
      showError(`复制失败：${safeError(error)}`);
    }
  });
  actions.append(copy);
  if (entry.role === "user") {
    const edit = document.createElement("button");
    edit.type = "button";
    edit.className = "message-action";
    edit.textContent = "再次编辑";
    edit.addEventListener("click", () => {
      selectComposerMode(entry.purpose !== "direct", { quiet: true });
      elements.prompt.value = entry.text;
      elements.prompt.focus();
      setStatus("原消息已放回输入框；发送后会作为新的后续要求");
    });
    actions.append(edit);
  }
  return actions;
}

function syncConversationEmptyState() {
  const hasTransient = Boolean(elements.conversation.querySelector(".reasoning-message"));
  const hasContent = chatHistory.length > 0
    || hasTransient
    || Boolean(candidate)
    || Boolean(orchestrator.getActivePlan())
    || elements.planMode.checked
    || !elements.toolResults.classList.contains("hidden");
  if (hasContent) elements.conversationEmpty.remove();
  else if (!elements.conversationEmpty.parentElement) elements.conversation.appendChild(elements.conversationEmpty);
}

function handleConversationScroll() {
  followConversation = isNearScrollEnd(elements.conversation, 64);
  updateScrollFollower();
}

function updateScrollFollower() {
  const hasOverflow = elements.conversation.scrollHeight > elements.conversation.clientHeight + 4;
  setScrollToLatestVisibility(elements.scrollToLatestButton, isNearScrollEnd(elements.conversation, 64), { hasOverflow });
}

function scrollConversationToEnd({ force = false, smooth = false } = {}) {
  if (!force && !followConversation && !isNearScrollEnd(elements.conversation, 64)) {
    updateScrollFollower();
    return false;
  }
  if (smooth && typeof elements.conversation.scrollTo === "function") {
    elements.conversation.scrollTo({ top: elements.conversation.scrollHeight, behavior: "smooth" });
  } else {
    elements.conversation.scrollTop = elements.conversation.scrollHeight;
  }
  followConversation = true;
  updateScrollFollower();
  return true;
}

// ISS-010: single source of truth for the turn-state badge wording so queue
// changes and busy toggles never diverge.
function refreshTurnStateBadge() {
  const queuedCount = orchestrator.getQueue().length;
  elements.turnStateBadge.textContent = busy ? "处理中" : queuedCount ? `${queuedCount} 条待发送` : "就绪";
}

function setBusy(value) {
  busy = value;
  elements.sendButton.disabled = !initialized;
  elements.sendButton.textContent = value ? "排队" : "发送";
  elements.stopButton.classList.toggle("hidden", !value);
  elements.readButton.disabled = value;
  refreshTurnStateBadge();
  elements.turnStateBadge.classList.toggle("muted", !value);
  elements.turnStateBadge.classList.toggle("processing", value);
  syncPlanModeUi();
  renderPlan();
  const currentStatus = elements.statusText.dataset.rawStatusText;
  if (currentStatus) setStatusView(elements.statusText, currentStatus, { busy });
}

function setStatus(text, state = "") {
  setStatusView(elements.statusText, text, { state, busy });
}

function showError(error) {
  setStatus(safeError(error));
}

function requiresEditorContext() {
  return elements.includeCode.checked || elements.includeSelection.checked || elements.includeConsole.checked;
}

function safeError(error) {
  return error instanceof Error ? error.message : String(error);
}

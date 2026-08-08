import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import { createOrchestrator } from "../lib/orchestrator.js";

if (!globalThis.crypto) globalThis.crypto = webcrypto;

function createEvent() {
  const listeners = [];
  return {
    addListener(listener) {
      listeners.push(listener);
    },
    fire(...args) {
      return listeners.map((listener) => listener(...args));
    },
    get first() {
      return listeners[0];
    }
  };
}

const localData = {
  settings: {
    baseUrl: "https://api.deepseek.com",
    model: "deepseek-v4-flash",
    apiKey: "must-not-leak"
  },
  apiKey: "test-key"
};
const sessionData = {};
let storageGate = null;

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function createStorageArea(data) {
  return {
    async get(key) {
      const gate = storageGate;
      if (gate) await gate;
      if (typeof key === "string") return { [key]: clone(data[key]) };
      if (Array.isArray(key)) {
        return Object.fromEntries(key.map((item) => [item, clone(data[item])]));
      }
      return clone(data);
    },
    async set(values) {
      Object.assign(data, clone(values));
    },
    async remove(key) {
      for (const item of Array.isArray(key) ? key : [key]) delete data[item];
    }
  };
}

const runtimeOnMessage = createEvent();
const runtimeOnConnect = createEvent();
globalThis.chrome = {
  runtime: {
    onInstalled: createEvent(),
    onStartup: createEvent(),
    onConnect: runtimeOnConnect,
    onMessage: runtimeOnMessage
  },
  sidePanel: {
    async setPanelBehavior() {}
  },
  storage: {
    local: createStorageArea(localData),
    session: createStorageArea(sessionData)
  }
};

let fetchCalls = 0;
globalThis.fetch = async () => {
  fetchCalls += 1;
  throw new Error("Unexpected fetch");
};

const workerModule = await import(`../service-worker.js?test=${Date.now()}`);

function dispatch(message) {
  return new Promise((resolve) => {
    const keepAlive = runtimeOnMessage.first(message, {}, resolve);
    if (keepAlive === false && message.type !== "AI_ABORT") resolve(undefined);
  });
}

const migrated = await dispatch({ type: "SETTINGS_GET" });
assert.equal(migrated.ok, true);
assert.equal(migrated.settings.thinkingEnabled, true);
assert.equal(migrated.settings.reasoningEffort, "high");
assert.equal(migrated.settings.supportsThinking, true);
assert.equal("apiKey" in migrated.settings, false);

const invalidEffort = await dispatch({
  type: "SETTINGS_SAVE",
  payload: {
    baseUrl: "https://api.deepseek.com",
    model: "deepseek-v4-flash",
    reasoningEffort: "medium"
  }
});
assert.equal(invalidEffort.ok, false);
assert.match(invalidEffort.error, /high 或 max/);

const saved = await dispatch({
  type: "SETTINGS_SAVE",
  payload: {
    baseUrl: "https://api.deepseek.com",
    model: "deepseek-v4-pro",
    projectId: "project-one",
    rememberApiKey: true,
    thinkingEnabled: false,
    reasoningEffort: "max"
  }
});
assert.equal(saved.ok, true);
assert.equal(saved.settings.thinkingEnabled, false);
assert.equal(saved.settings.reasoningEffort, "max");
assert.equal("apiKey" in localData.settings, false);

let releaseStorage;
storageGate = new Promise((resolve) => {
  releaseStorage = resolve;
});
const earlyRequest = dispatch({
  type: "AI_CHAT",
  payload: {
    requestId: "early-abort",
    purpose: "direct",
    messages: [{ role: "user", content: "test" }]
  }
});
await dispatch({ type: "AI_ABORT", requestId: "early-abort" });
releaseStorage();
storageGate = null;
const earlyResult = await earlyRequest;
assert.equal(earlyResult.ok, false);
assert.equal(earlyResult.error, "请求已停止");
assert.equal(fetchCalls, 0);

await dispatch({ type: "AI_ABORT", requestId: "abort-before-start" });
const preCancelled = await dispatch({
  type: "AI_CHAT",
  payload: {
    requestId: "abort-before-start",
    purpose: "direct",
    messages: [{ role: "user", content: "must not start" }]
  }
});
assert.equal(preCancelled.ok, false);
assert.equal(preCancelled.error, "请求已停止");
assert.equal(fetchCalls, 0);

localData.settings = {
  ...localData.settings,
  baseUrl: "https://api.deepseek.com",
  model: "deepseek-v4-flash",
  thinkingEnabled: true,
  reasoningEffort: "high"
};

let streamSignal;
globalThis.fetch = (_url, options) => {
  fetchCalls += 1;
  streamSignal = options.signal;
  return new Promise((_resolve, reject) => {
    options.signal.addEventListener("abort", () => {
      reject(new DOMException("Aborted", "AbortError"));
    }, { once: true });
  });
};

const portMessages = createEvent();
const portDisconnect = createEvent();
const posted = [];
const port = {
  name: "AI_CHAT_STREAM",
  onMessage: portMessages,
  onDisconnect: portDisconnect,
  postMessage(message) {
    posted.push(message);
  }
};
runtimeOnConnect.fire(port);
portMessages.fire({
  type: "START",
  payload: {
    requestId: "disconnect-abort",
    purpose: "direct",
    messages: [{ role: "user", content: "stream test" }]
  }
});

for (let attempt = 0; attempt < 20 && !streamSignal; attempt += 1) {
  await new Promise((resolve) => setTimeout(resolve, 0));
}
assert.ok(streamSignal, "stream fetch should start");
portDisconnect.fire();
await new Promise((resolve) => setTimeout(resolve, 0));
assert.equal(streamSignal.aborted, true);
assert.equal(posted.at(-1)?.type, "ERROR");
assert.equal(posted.at(-1)?.error, "请求已停止");

function sseResponse(text) {
  return {
    ok: true,
    status: 200,
    body: {
      getReader() {
        let sent = false;
        return {
          async read() {
            if (sent) return { done: true, value: undefined };
            sent = true;
            return { done: false, value: text };
          },
          cancel() {},
          releaseLock() {}
        };
      }
    }
  };
}

function connectStreamPort(requestId) {
  const portPosted = [];
  const streamPort = {
    name: "AI_CHAT_STREAM",
    onMessage: createEvent(),
    onDisconnect: createEvent(),
    postMessage(message) {
      portPosted.push(message);
    }
  };
  runtimeOnConnect.fire(streamPort);
  streamPort.onMessage.first({
    type: "START",
    payload: {
      requestId,
      purpose: "direct",
      messages: [{ role: "user", content: "empty content test" }]
    }
  });
  return portPosted;
}

async function waitUntil(predicate, attempts = 100) {
  for (let attempt = 0; attempt < attempts && !predicate(); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

// Reasoning-only stream: clear, actionable message instead of a generic one.
globalThis.fetch = () => sseResponse([
  'data: {"choices":[{"delta":{"reasoning_content":"thinking..."}}]}',
  'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}',
  "data: [DONE]",
  ""
].join("\n\n"));
const reasoningPosted = connectStreamPort("reasoning-only");
await waitUntil(() => reasoningPosted.some((message) => message.type === "ERROR"));
assert.ok(reasoningPosted.some((message) => message.type === "REASONING_DELTA"));
const reasoningError = reasoningPosted.find((message) => message.type === "ERROR");
assert.equal(reasoningError.error, "模型仅返回了思考内容，没有生成最终回答，请重试或调整提问");

// No reasoning and no content: distinct generic message.
globalThis.fetch = () => sseResponse("data: [DONE]\n\n");
const emptyPosted = connectStreamPort("empty-content");
await waitUntil(() => emptyPosted.some((message) => message.type === "ERROR"));
const emptyError = emptyPosted.find((message) => message.type === "ERROR");
assert.equal(emptyError.error, "模型没有返回有效内容，请重试");

// ---- Transport policy: billed chat requests time out and never auto-retry.
// A non-V4 endpoint keeps the non-streaming chat() path reachable.
localData.settings = {
  ...localData.settings,
  baseUrl: "https://compatible.example.com/v1",
  model: "generic-chat-model"
};
workerModule.__timings.chatTimeoutMs = 40;
let chatTimeoutFetches = 0;
globalThis.fetch = (_url, options) => new Promise((_resolve, reject) => {
  chatTimeoutFetches += 1;
  options.signal.addEventListener("abort", () => {
    reject(new DOMException("Aborted", "AbortError"));
  }, { once: true });
});
const chatTimeoutResult = await dispatch({
  type: "AI_CHAT",
  payload: { requestId: "chat-timeout", purpose: "direct", messages: [{ role: "user", content: "timeout" }] }
});
assert.equal(chatTimeoutResult.ok, false);
assert.match(chatTimeoutResult.error, /超时/);
assert.equal(chatTimeoutFetches, 1, "chat never auto-retries billed POSTs");
workerModule.__timings.chatTimeoutMs = 60000;

// Headers arrive but the body never ends: the total timeout must still fire.
workerModule.__timings.chatTimeoutMs = 40;
let stalledBodyFetches = 0;
globalThis.fetch = () => {
  stalledBodyFetches += 1;
  return {
    ok: true,
    status: 200,
    headers: { get: () => null },
    text: () => new Promise(() => {})
  };
};
const stalledChat = await dispatch({
  type: "AI_CHAT",
  payload: { requestId: "chat-body-stall", purpose: "direct", messages: [{ role: "user", content: "stalled body" }] }
});
assert.equal(stalledChat.ok, false);
assert.match(stalledChat.error, /超时/, "the timeout also covers the response body");
assert.equal(stalledBodyFetches, 1);
workerModule.__timings.chatTimeoutMs = 60000;

// A stalled body can also be interrupted by a manual stop.
let stalledAbortSignal = null;
globalThis.fetch = (_url, options) => {
  stalledAbortSignal = options.signal;
  return {
    ok: true,
    status: 200,
    headers: { get: () => null },
    text: () => new Promise(() => {})
  };
};
const stalledAbortRequest = dispatch({
  type: "AI_CHAT",
  payload: { requestId: "chat-body-abort", purpose: "direct", messages: [{ role: "user", content: "abort the body" }] }
});
await waitUntil(() => Boolean(stalledAbortSignal), 300);
await dispatch({ type: "AI_ABORT", requestId: "chat-body-abort" });
const stalledAbortResult = await stalledAbortRequest;
assert.equal(stalledAbortResult.ok, false);
assert.equal(stalledAbortResult.error, "请求已停止", "manual stop interrupts a stalled body read");

// Back to the official V4 endpoint for the streaming tests below.
localData.settings = {
  ...localData.settings,
  baseUrl: "https://api.deepseek.com",
  model: "deepseek-v4-flash"
};

// SSE body that delivers some chunks and then hangs until cancelled.
function stalledSseResponse(chunks = []) {
  return {
    ok: true,
    status: 200,
    body: {
      getReader() {
        let index = 0;
        let pendingResolve = null;
        return {
          read() {
            if (index < chunks.length) return Promise.resolve({ done: false, value: chunks[index++] });
            return new Promise((resolve) => {
              pendingResolve = resolve;
            });
          },
          cancel() {
            pendingResolve?.({ done: true, value: undefined });
            return Promise.resolve();
          },
          releaseLock() {}
        };
      }
    }
  };
}

// ---- Zero-content stream: one automatic retry, then success.
workerModule.__timings.streamRetryDelayMs = 5;
let retrySuccessFetches = 0;
globalThis.fetch = () => {
  retrySuccessFetches += 1;
  if (retrySuccessFetches === 1) return Promise.reject(new TypeError("Failed to fetch"));
  return sseResponse([
    'data: {"choices":[{"delta":{"content":"hello"}}]}',
    'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}',
    "data: [DONE]",
    ""
  ].join("\n\n"));
};
const retrySuccessPosted = connectStreamPort("stream-retry-success");
await waitUntil(() => retrySuccessPosted.some((message) => message.type === "DONE"), 300);
assert.equal(retrySuccessFetches, 2, "zero-content failure retries exactly once");
assert.ok(retrySuccessPosted.some((message) => message.type === "CONTENT_DELTA" && message.delta === "hello"));
assert.equal(retrySuccessPosted.find((message) => message.type === "DONE").content, "hello");

// ---- Zero-content stream: retry exhausted surfaces the original error.
let retryExhaustedFetches = 0;
globalThis.fetch = () => {
  retryExhaustedFetches += 1;
  return Promise.reject(new TypeError("Failed to fetch"));
};
const retryExhaustedPosted = connectStreamPort("stream-retry-exhausted");
await waitUntil(() => retryExhaustedPosted.some((message) => message.type === "ERROR"), 300);
assert.equal(retryExhaustedFetches, 2, "at most one retry after zero content");
assert.match(retryExhaustedPosted.find((message) => message.type === "ERROR").error, /Failed to fetch/);

// ---- Idle timeout after content deltas: no retry once output exists.
workerModule.__timings.streamIdleTimeoutMs = 30;
let stallFetches = 0;
globalThis.fetch = () => {
  stallFetches += 1;
  return stalledSseResponse(['data: {"choices":[{"delta":{"content":"partial"}}]}\n\n']);
};
const stallPosted = connectStreamPort("stream-abort-after-content");
await waitUntil(() => stallPosted.some((message) => message.type === "ERROR"), 300);
assert.equal(stallFetches, 1, "no retry after content deltas were produced");
assert.ok(stallPosted.some((message) => message.type === "CONTENT_DELTA" && message.delta === "partial"));
assert.match(stallPosted.find((message) => message.type === "ERROR").error, /超时/);
workerModule.__timings.streamIdleTimeoutMs = 60000;

// ---- First-byte timeout: silent stream retries once, then fails.
workerModule.__timings.streamFirstByteTimeoutMs = 30;
let firstByteFetches = 0;
globalThis.fetch = () => {
  firstByteFetches += 1;
  return stalledSseResponse();
};
const firstBytePosted = connectStreamPort("stream-first-byte-timeout");
await waitUntil(() => firstBytePosted.some((message) => message.type === "ERROR"), 300);
assert.equal(firstByteFetches, 2, "first-byte timeout is retryable while nothing was produced");
assert.match(firstBytePosted.find((message) => message.type === "ERROR").error, /超时/);
workerModule.__timings.streamFirstByteTimeoutMs = 30000;

// ---- Manual stop is never retried.
let manualStopFetches = 0;
let manualStopSignal = null;
globalThis.fetch = (_url, options) => {
  manualStopFetches += 1;
  manualStopSignal = options.signal;
  return new Promise((_resolve, reject) => {
    options.signal.addEventListener("abort", () => {
      reject(new DOMException("Aborted", "AbortError"));
    }, { once: true });
  });
};
const manualStopPosted = connectStreamPort("manual-stop");
await waitUntil(() => Boolean(manualStopSignal), 300);
await dispatch({ type: "AI_ABORT", requestId: "manual-stop" });
await waitUntil(() => manualStopPosted.some((message) => message.type === "ERROR"), 300);
assert.equal(manualStopFetches, 1, "manual stop is never retried");
assert.equal(manualStopSignal.aborted, true);
assert.equal(manualStopPosted.find((message) => message.type === "ERROR").error, "请求已停止");

// ---- Compatible endpoints: streaming is opt-in via compatibleStreaming.
localData.settings = {
  ...localData.settings,
  baseUrl: "https://compatible.example.com/v1",
  model: "generic-chat-model",
  compatibleStreaming: false
};
let compatGateFetches = 0;
globalThis.fetch = () => {
  compatGateFetches += 1;
  return sseResponse("data: [DONE]\n\n");
};
const compatOffPosted = connectStreamPort("compat-stream-off");
await waitUntil(() => compatOffPosted.some((message) => message.type === "ERROR"));
assert.equal(
  compatOffPosted.find((message) => message.type === "ERROR").error,
  "当前模型接口不支持 DeepSeek V4 实时思考协议"
);
assert.equal(compatGateFetches, 0, "opt-in off keeps compatible endpoints non-streaming");

// Opt-in on: plain stream flag, no DeepSeek-only fields, DONE path works.
localData.settings = { ...localData.settings, compatibleStreaming: true };
let compatStreamBody = null;
globalThis.fetch = (_url, options) => {
  compatStreamBody = JSON.parse(options.body);
  return sseResponse([
    'data: {"choices":[{"delta":{"content":"compat hello"}}]}',
    'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}',
    "data: [DONE]",
    ""
  ].join("\n\n"));
};
const compatOnPosted = connectStreamPort("compat-stream-on");
await waitUntil(() => compatOnPosted.some((message) => message.type === "DONE"), 300);
assert.equal(compatStreamBody.stream, true, "compatible endpoints stream when opted in");
assert.equal("thinking" in compatStreamBody, false);
assert.equal("reasoning_effort" in compatStreamBody, false);
assert.equal("stream_options" in compatStreamBody, false);
assert.ok(compatOnPosted.some((message) => message.type === "CONTENT_DELTA" && message.delta === "compat hello"));
assert.ok(compatOnPosted.every((message) => message.type !== "REASONING_DELTA"), "compatible streams carry no reasoning");
assert.equal(compatOnPosted.find((message) => message.type === "DONE").content, "compat hello");

// Zero-content retry and idle semantics apply to compatible streams too.
workerModule.__timings.streamRetryDelayMs = 5;
let compatRetryFetches = 0;
globalThis.fetch = () => {
  compatRetryFetches += 1;
  if (compatRetryFetches === 1) return Promise.reject(new TypeError("Failed to fetch"));
  return sseResponse([
    'data: {"choices":[{"delta":{"content":"recovered"}}]}',
    'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}',
    "data: [DONE]",
    ""
  ].join("\n\n"));
};
const compatRetryPosted = connectStreamPort("compat-stream-retry");
await waitUntil(() => compatRetryPosted.some((message) => message.type === "DONE"), 300);
assert.equal(compatRetryFetches, 2, "compatible streams retry once while nothing was produced");
assert.equal(compatRetryPosted.find((message) => message.type === "DONE").content, "recovered");
workerModule.__timings.streamRetryDelayMs = 1000;

// ---- Cross-module chain (M1/m9): settings -> orchestrator -> worker stream
// Port. The orchestrator reads SETTINGS_GET through the real message bus and
// must pick the streaming Port for a compatible endpoint with the opt-in on.
localData.settings = {
  ...localData.settings,
  baseUrl: "https://compatible.example.com/v1",
  model: "generic-chat-model",
  compatibleStreaming: true
};
let chainStreamBody = null;
globalThis.fetch = (_url, options) => {
  chainStreamBody = JSON.parse(options.body);
  return sseResponse([
    'data: {"choices":[{"delta":{"content":"chain hello"}}]}',
    'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}',
    "data: [DONE]",
    ""
  ].join("\n\n"));
};
const chainAppended = [];
let chainSettings = null;
const chainRuntime = {
  lastError: null,
  sendMessage: (message) => dispatch(message),
  connect({ name } = {}) {
    const panelListeners = [];
    const workerPort = {
      name,
      onMessage: createEvent(),
      onDisconnect: createEvent(),
      postMessage(message) {
        for (const listener of [...panelListeners]) listener(message);
      }
    };
    const panelPort = {
      name,
      onMessage: { addListener: (listener) => panelListeners.push(listener) },
      onDisconnect: { addListener: () => {} },
      postMessage(message) {
        workerPort.onMessage.fire(message);
      },
      disconnect() {
        workerPort.onDisconnect.fire();
      }
    };
    runtimeOnConnect.fire(workerPort);
    return panelPort;
  }
};
const chainDeps = {
  runtime: chainRuntime,
  appendMessage: (role, text, options) => { chainAppended.push({ role, text, ...options }); },
  showCandidate: () => {},
  setBusy: () => {},
  setStatus: () => {},
  showError: () => {},
  scrollConversationToEnd: () => {},
  updateScrollFollower: () => {},
  syncConversationEmptyState: () => {},
  readEditor: async () => null,
  openSettings: () => {},
  selectComposerMode: () => {},
  renderMessageQueue: () => {},
  renderPlan: () => {},
  persistMessageQueue: async () => {},
  persistActivePlan: async (plan) => plan ?? null,
  onSettingsLoaded: (settings) => { chainSettings = settings; },
  renderToolSources: () => {},
  setToolActivityState: () => {},
  completeToolActivity: () => {},
  hideToolResults: () => {},
  createConsoleContextSection: () => "",
  createReasoningView: () => ({ append() {}, complete() {}, remove() {} }),
  contextOptions: () => ({ includeSelection: false, includeCode: false, datasetSearch: false, docsSearch: false }),
  requiresEditorContext: () => false,
  isNearScrollEnd: () => true,
  isInitialized: () => true
};
const chainOrchestrator = createOrchestrator(chainDeps);
await chainOrchestrator.executePrompt("跨模块链路", false);
assert.equal(chainSettings.supportsThinking, false, "compatible endpoints never report thinking support");
assert.equal(chainSettings.compatibleStreaming, true, "settings carry the streaming opt-in to the orchestrator");
assert.ok(chainStreamBody, "the orchestrator reached the worker through the stream Port");
assert.equal(chainStreamBody.stream, true, "compatible chain sends the plain stream flag");
assert.equal("thinking" in chainStreamBody, false);
assert.ok(chainAppended.some((entry) => entry.role === "assistant" && entry.text === "chain hello"));

// Opt-in off in the same chain: the orchestrator falls back to AI_CHAT.
localData.settings = { ...localData.settings, compatibleStreaming: false };
let chainChatBody = null;
globalThis.fetch = (_url, options) => {
  chainChatBody = JSON.parse(options.body);
  return {
    ok: true,
    status: 200,
    headers: { get: () => null },
    text: async () => JSON.stringify({
      choices: [{ message: { content: "chain non-stream" }, finish_reason: "stop" }]
    })
  };
};
const chainFallbackOrchestrator = createOrchestrator(chainDeps);
await chainFallbackOrchestrator.executePrompt("跨模块非流式", false);
assert.ok(chainChatBody, "opt-in off reaches the worker through AI_CHAT");
assert.equal(chainChatBody.stream, false, "AI_CHAT keeps the non-streaming shape");
assert.ok(chainAppended.some((entry) => entry.role === "assistant" && entry.text === "chain non-stream"));
localData.settings = { ...localData.settings, compatibleStreaming: true };

// ---- Retrieval chain: concurrency gate and retry policy for Google pages.
function pageResponse(body) {
  return {
    ok: true,
    status: 200,
    headers: { get: () => null },
    text: async () => body
  };
}

function datasetEntries(prefix, count) {
  return Array.from({ length: count }, (_unused, index) => ({
    title: `MODIS Terra True Color ${prefix} ${index}`,
    url: `https://developers.google.com/earth-engine/datasets/catalog/${prefix}_${index}`,
    description: "modis terra true color updated daily"
  }));
}

workerModule.__timings.pageBackoffMs = 5;

// Concurrency gate: at most 4 detail pages are fetched at once.
let gateInFlight = 0;
let gatePeak = 0;
let gateFetches = 0;
localData.datasetIndexV2 = { createdAt: Date.now(), entries: datasetEntries("MODIS_GATE", 8) };
globalThis.fetch = async () => {
  gateFetches += 1;
  gateInFlight += 1;
  gatePeak = Math.max(gatePeak, gateInFlight);
  await new Promise((resolve) => setTimeout(resolve, 20));
  gateInFlight -= 1;
  return pageResponse("<html><head><title>MODIS</title></head><body>modis terra true color</body></html>");
};
const gateResult = await dispatch({
  type: "TOOLS_SEARCH",
  payload: { requestId: "gate-search", query: "modis", datasetSearch: true, docsSearch: false }
});
assert.equal(gateResult.ok, true);
assert.equal(gatePeak, 4, "detail fetches are gated at 4 concurrent requests");
assert.ok(gateFetches >= 6, "all candidate pages were fetched");
assert.ok(gateResult.sources.length >= 1, "pages still aggregate into sources");

// Retry: a flaky 503 page is retried after the backoff and succeeds.
const retryAttempts = new Map();
localData.datasetIndexV2 = { createdAt: Date.now(), entries: datasetEntries("MODIS_RETRY", 6) };
globalThis.fetch = async (url) => {
  const key = String(url);
  retryAttempts.set(key, (retryAttempts.get(key) || 0) + 1);
  if (key.includes("MODIS_RETRY_0") && retryAttempts.get(key) === 1) {
    return { ok: false, status: 503, headers: { get: () => null }, text: async () => "" };
  }
  return pageResponse("<html><head><title>MODIS</title></head><body>modis terra</body></html>");
};
const retrySearch = await dispatch({
  type: "TOOLS_SEARCH",
  payload: { requestId: "retry-search", query: "modis", datasetSearch: true, docsSearch: false }
});
assert.equal(retrySearch.ok, true);
const flakyUrl = [...retryAttempts.keys()].find((key) => key.includes("MODIS_RETRY_0"));
assert.ok(flakyUrl, "flaky page was requested");
assert.equal(retryAttempts.get(flakyUrl), 2, "retryable GET is retried after 503");
const stableUrl = [...retryAttempts.keys()].find((key) => key.includes("MODIS_RETRY_1"));
assert.equal(retryAttempts.get(stableUrl), 1, "healthy pages are fetched once");
workerModule.__timings.pageBackoffMs = 2000;

// ---- Retrieval cache: stampede lock, parsed-result cache and TTL persistence.
function datasetIndexHtml(prefix, count) {
  const items = Array.from({ length: count }, (_unused, index) => (
    `<li><a href="/earth-engine/datasets/catalog/${prefix}_${index}">MODIS Terra True Color ${prefix} ${index}</a> modis terra true color updated daily</li>`
  )).join("");
  return `<html><body><ul>${items}</ul></body></html>`;
}
const detailPageHtml = "<html><head><title>MODIS</title></head><body>modis terra true color</body></html>";

// Stampede lock: two concurrent searches share one index fetch+parse pass.
workerModule.__testing.clearRetrievalCaches();
delete localData.datasetIndexV2;
delete localData.pageDetailCacheV1;
let lockCatalogFetches = 0;
globalThis.fetch = async (url) => {
  const target = String(url);
  if (!target.includes("MODIS_LOCK")) {
    lockCatalogFetches += 1;
    // Keep the loader in flight long enough for the second search to arrive.
    await new Promise((resolve) => setTimeout(resolve, 10));
    return pageResponse(datasetIndexHtml("MODIS_LOCK", 120));
  }
  return pageResponse(detailPageHtml);
};
const [lockFirst, lockSecond] = await Promise.all([
  dispatch({ type: "TOOLS_SEARCH", payload: { requestId: "lock-a", query: "modis", datasetSearch: true, docsSearch: false } }),
  dispatch({ type: "TOOLS_SEARCH", payload: { requestId: "lock-b", query: "modis", datasetSearch: true, docsSearch: false } })
]);
assert.equal(lockFirst.ok, true);
assert.equal(lockSecond.ok, true);
assert.equal(lockCatalogFetches, 1, "concurrent searches share one in-flight index fetch");
assert.ok(Array.isArray(localData.datasetIndexV2?.entries), "parsed index is persisted for restarts");

// Abort decoupling (M6): a shared index load is never bound to the first
// caller's signal. Cancelling the first waiter must not cancel the shared
// load, and the second waiter still completes.
workerModule.__testing.clearRetrievalCaches();
delete localData.datasetIndexV2;
delete localData.pageDetailCacheV1;
let detachCatalogFetches = 0;
let detachCatalogSignal = null;
globalThis.fetch = (url, options) => {
  const target = String(url);
  if (!target.includes("MODIS_DETACH")) {
    detachCatalogFetches += 1;
    detachCatalogSignal = options.signal;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => resolve(pageResponse(datasetIndexHtml("MODIS_DETACH", 120))), 40);
      options.signal.addEventListener("abort", () => {
        clearTimeout(timer);
        reject(new DOMException("Aborted", "AbortError"));
      }, { once: true });
    });
  }
  return Promise.resolve(pageResponse(detailPageHtml));
};
const detachFirst = dispatch({
  type: "TOOLS_SEARCH",
  payload: { requestId: "detach-a", query: "modis", datasetSearch: true, docsSearch: false }
});
const detachSecond = dispatch({
  type: "TOOLS_SEARCH",
  payload: { requestId: "detach-b", query: "modis", datasetSearch: true, docsSearch: false }
});
await waitUntil(() => Boolean(detachCatalogSignal), 300);
await dispatch({ type: "AI_ABORT", requestId: "detach-a" });
const detachFirstResult = await detachFirst;
assert.equal(detachFirstResult.ok, false);
assert.equal(detachFirstResult.error, "请求已停止", "the cancelled waiter sees its own abort");
const detachSecondResult = await detachSecond;
assert.equal(detachSecondResult.ok, true, "the surviving waiter is unaffected by the first waiter's abort");
assert.equal(detachCatalogFetches, 1, "the shared index load was neither cancelled nor restarted");
assert.equal(detachCatalogSignal.aborted, false, "the shared controller outlives a single waiter's abort");

// The mirror case: cancelling the second waiter must not stop the first.
workerModule.__testing.clearRetrievalCaches();
delete localData.datasetIndexV2;
delete localData.pageDetailCacheV1;
let reverseCatalogFetches = 0;
let reverseCatalogSignal = null;
globalThis.fetch = (url, options) => {
  const target = String(url);
  if (!target.includes("MODIS_REVERSE")) {
    reverseCatalogFetches += 1;
    reverseCatalogSignal = options.signal;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => resolve(pageResponse(datasetIndexHtml("MODIS_REVERSE", 120))), 40);
      options.signal.addEventListener("abort", () => {
        clearTimeout(timer);
        reject(new DOMException("Aborted", "AbortError"));
      }, { once: true });
    });
  }
  return Promise.resolve(pageResponse(detailPageHtml));
};
const reverseFirst = dispatch({
  type: "TOOLS_SEARCH",
  payload: { requestId: "reverse-a", query: "modis", datasetSearch: true, docsSearch: false }
});
const reverseSecond = dispatch({
  type: "TOOLS_SEARCH",
  payload: { requestId: "reverse-b", query: "modis", datasetSearch: true, docsSearch: false }
});
await waitUntil(() => Boolean(reverseCatalogSignal), 300);
await dispatch({ type: "AI_ABORT", requestId: "reverse-b" });
const reverseSecondResult = await reverseSecond;
assert.equal(reverseSecondResult.ok, false, "the second waiter can cancel its own wait independently");
const reverseFirstResult = await reverseFirst;
assert.equal(reverseFirstResult.ok, true, "the first waiter survives the second waiter's abort");
assert.equal(reverseCatalogFetches, 1);

// Reference counting: when every waiter cancels, the underlying load stops.
workerModule.__testing.clearRetrievalCaches();
delete localData.datasetIndexV2;
delete localData.pageDetailCacheV1;
let allAbortSignal = null;
globalThis.fetch = (url, options) => {
  const target = String(url);
  if (!target.includes("MODIS_ALLABORT")) {
    allAbortSignal = options.signal;
    return new Promise((_resolve, reject) => {
      options.signal.addEventListener("abort", () => {
        reject(new DOMException("Aborted", "AbortError"));
      }, { once: true });
    });
  }
  return Promise.resolve(pageResponse(detailPageHtml));
};
const allFirst = dispatch({
  type: "TOOLS_SEARCH",
  payload: { requestId: "all-abort-a", query: "modis", datasetSearch: true, docsSearch: false }
});
const allSecond = dispatch({
  type: "TOOLS_SEARCH",
  payload: { requestId: "all-abort-b", query: "modis", datasetSearch: true, docsSearch: false }
});
await waitUntil(() => Boolean(allAbortSignal), 300);
await dispatch({ type: "AI_ABORT", requestId: "all-abort-a" });
assert.equal(allAbortSignal.aborted, false, "one remaining waiter keeps the shared load alive");
await dispatch({ type: "AI_ABORT", requestId: "all-abort-b" });
const [allFirstResult, allSecondResult] = await Promise.all([allFirst, allSecond]);
assert.equal(allFirstResult.ok, false);
assert.equal(allSecondResult.ok, false);
assert.equal(allAbortSignal.aborted, true, "the shared load is cancelled once every waiter gives up");

// Parsed-result cache: a repeat search is served without re-fetching pages.
workerModule.__testing.clearRetrievalCaches();
delete localData.pageDetailCacheV1;
localData.datasetIndexV2 = { createdAt: Date.now(), entries: datasetEntries("MODIS_MEM", 6) };
let memDetailFetches = 0;
globalThis.fetch = async () => {
  memDetailFetches += 1;
  return pageResponse(detailPageHtml);
};
const memFirst = await dispatch({
  type: "TOOLS_SEARCH",
  payload: { requestId: "mem-a", query: "modis", datasetSearch: true, docsSearch: false }
});
assert.equal(memFirst.ok, true);
const firstRoundFetches = memDetailFetches;
assert.ok(firstRoundFetches >= 1, "detail pages were fetched on the first search");
assert.ok(localData.pageDetailCacheV1, "detail summaries are persisted under a dedicated key");
const memSecond = await dispatch({
  type: "TOOLS_SEARCH",
  payload: { requestId: "mem-b", query: "modis", datasetSearch: true, docsSearch: false }
});
assert.equal(memSecond.ok, true);
assert.equal(memDetailFetches, firstRoundFetches, "repeat searches are served from the parsed-result cache");
assert.deepEqual(memSecond.sources, memFirst.sources, "cached parses produce identical sources");

// Service worker restart: persistent summaries are consulted before fetching.
workerModule.__testing.clearRetrievalCaches();
const persistedKey = workerModule.detailCacheKey(
  "https://developers.google.com/earth-engine/datasets/catalog/MODIS_MEM_0", "modis", "dataset"
);
assert.ok(localData.pageDetailCacheV1[persistedKey]?.result, "previous search persisted a detail summary");
let restartFetches = 0;
globalThis.fetch = async () => {
  restartFetches += 1;
  return pageResponse(detailPageHtml);
};
const restartSearch = await dispatch({
  type: "TOOLS_SEARCH",
  payload: { requestId: "restart-hit", query: "modis", datasetSearch: true, docsSearch: false }
});
assert.equal(restartSearch.ok, true);
assert.equal(restartFetches, 0, "fresh persistent summaries skip the network after a restart");

// TTL: entries older than 24h are filtered on read and refetched.
workerModule.__testing.clearRetrievalCaches();
for (const item of Object.values(localData.pageDetailCacheV1)) {
  item.createdAt = Date.now() - 25 * 60 * 60 * 1000;
}
let expiredFetches = 0;
globalThis.fetch = async () => {
  expiredFetches += 1;
  return pageResponse(detailPageHtml);
};
const expiredSearch = await dispatch({
  type: "TOOLS_SEARCH",
  payload: { requestId: "expired-refetch", query: "modis", datasetSearch: true, docsSearch: false }
});
assert.equal(expiredSearch.ok, true);
assert.ok(expiredFetches >= 1, "expired persistent entries are filtered and refetched");

// Memory TTL (m4): in-memory parses also expire after 24h, even while the
// worker stays alive. The persistent copy is removed so only the memory TTL
// can explain the refetch.
workerModule.__testing.clearRetrievalCaches();
delete localData.pageDetailCacheV1;
localData.datasetIndexV2 = { createdAt: Date.now(), entries: datasetEntries("MODIS_MTTL", 1) };
let memTtlFetches = 0;
globalThis.fetch = async () => {
  memTtlFetches += 1;
  return pageResponse(detailPageHtml);
};
const memTtlFirst = await dispatch({
  type: "TOOLS_SEARCH",
  payload: { requestId: "mem-ttl-a", query: "modis", datasetSearch: true, docsSearch: false }
});
assert.equal(memTtlFirst.ok, true);
assert.equal(memTtlFetches, 1, "first search fetches the detail page once");
workerModule.__testing.ageMemoryDetailCache(25 * 60 * 60 * 1000);
delete localData.pageDetailCacheV1;
const memTtlSecond = await dispatch({
  type: "TOOLS_SEARCH",
  payload: { requestId: "mem-ttl-b", query: "modis", datasetSearch: true, docsSearch: false }
});
assert.equal(memTtlSecond.ok, true);
assert.equal(memTtlFetches, 2, "memory entries older than 24h are filtered and refetched");

// Detail single-flight (m4): concurrent first queries of the same page share
// one fetch+parse pass.
workerModule.__testing.clearRetrievalCaches();
delete localData.pageDetailCacheV1;
localData.datasetIndexV2 = { createdAt: Date.now(), entries: datasetEntries("MODIS_DLOCK", 3) };
let detailLockFetches = 0;
globalThis.fetch = async () => {
  detailLockFetches += 1;
  // Keep the fetch in flight long enough for both searches to arrive.
  await new Promise((resolve) => setTimeout(resolve, 15));
  return pageResponse(detailPageHtml);
};
const [detailLockA, detailLockB] = await Promise.all([
  dispatch({ type: "TOOLS_SEARCH", payload: { requestId: "detail-lock-a", query: "modis", datasetSearch: true, docsSearch: false } }),
  dispatch({ type: "TOOLS_SEARCH", payload: { requestId: "detail-lock-b", query: "modis", datasetSearch: true, docsSearch: false } })
]);
assert.equal(detailLockA.ok, true);
assert.equal(detailLockB.ok, true);
assert.equal(detailLockFetches, 3, "concurrent first queries share one fetch per detail page");
assert.deepEqual(detailLockB.sources, detailLockA.sources, "shared parses produce identical sources");

// Detail abort decoupling (M-1, mirror of M6): the shared page load runs
// under its own controller. Cancelling the first waiter must not cancel the
// shared fetch, and the second waiter still completes.
workerModule.__testing.clearRetrievalCaches();
delete localData.pageDetailCacheV1;
localData.datasetIndexV2 = { createdAt: Date.now(), entries: datasetEntries("MODIS_DDETACH", 1) };
let detailDetachFetches = 0;
let detailDetachSignal = null;
globalThis.fetch = (_url, options) => {
  detailDetachFetches += 1;
  detailDetachSignal = options.signal;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve(pageResponse(detailPageHtml)), 40);
    options.signal.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(new DOMException("Aborted", "AbortError"));
    }, { once: true });
  });
};
const detailDetachFirst = dispatch({
  type: "TOOLS_SEARCH",
  payload: { requestId: "detail-detach-a", query: "modis", datasetSearch: true, docsSearch: false }
});
const detailDetachSecond = dispatch({
  type: "TOOLS_SEARCH",
  payload: { requestId: "detail-detach-b", query: "modis", datasetSearch: true, docsSearch: false }
});
await waitUntil(() => Boolean(detailDetachSignal), 300);
await dispatch({ type: "AI_ABORT", requestId: "detail-detach-a" });
const detailDetachFirstResult = await detailDetachFirst;
assert.equal(detailDetachFirstResult.ok, false);
assert.equal(detailDetachFirstResult.error, "请求已停止", "the cancelled detail waiter sees its own abort");
const detailDetachSecondResult = await detailDetachSecond;
assert.equal(detailDetachSecondResult.ok, true, "the surviving detail waiter is unaffected by the first waiter's abort");
assert.equal(detailDetachFetches, 1, "the shared detail fetch was neither cancelled nor restarted");
assert.equal(detailDetachSignal.aborted, false, "the shared detail controller outlives a single waiter's abort");

// The mirror case: cancelling the second waiter must not stop the first.
workerModule.__testing.clearRetrievalCaches();
delete localData.pageDetailCacheV1;
localData.datasetIndexV2 = { createdAt: Date.now(), entries: datasetEntries("MODIS_DREVERSE", 1) };
let detailReverseFetches = 0;
let detailReverseSignal = null;
globalThis.fetch = (_url, options) => {
  detailReverseFetches += 1;
  detailReverseSignal = options.signal;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve(pageResponse(detailPageHtml)), 40);
    options.signal.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(new DOMException("Aborted", "AbortError"));
    }, { once: true });
  });
};
const detailReverseFirst = dispatch({
  type: "TOOLS_SEARCH",
  payload: { requestId: "detail-reverse-a", query: "modis", datasetSearch: true, docsSearch: false }
});
const detailReverseSecond = dispatch({
  type: "TOOLS_SEARCH",
  payload: { requestId: "detail-reverse-b", query: "modis", datasetSearch: true, docsSearch: false }
});
await waitUntil(() => Boolean(detailReverseSignal), 300);
await dispatch({ type: "AI_ABORT", requestId: "detail-reverse-b" });
const detailReverseSecondResult = await detailReverseSecond;
assert.equal(detailReverseSecondResult.ok, false, "the second detail waiter can cancel its own wait independently");
const detailReverseFirstResult = await detailReverseFirst;
assert.equal(detailReverseFirstResult.ok, true, "the first detail waiter survives the second waiter's abort");
assert.equal(detailReverseFetches, 1);

// Reference counting: when every detail waiter cancels, the underlying fetch
// is aborted.
workerModule.__testing.clearRetrievalCaches();
delete localData.pageDetailCacheV1;
localData.datasetIndexV2 = { createdAt: Date.now(), entries: datasetEntries("MODIS_DALLABORT", 1) };
let detailAllAbortSignal = null;
globalThis.fetch = (_url, options) => {
  detailAllAbortSignal = options.signal;
  return new Promise((_resolve, reject) => {
    options.signal.addEventListener("abort", () => {
      reject(new DOMException("Aborted", "AbortError"));
    }, { once: true });
  });
};
const detailAllFirst = dispatch({
  type: "TOOLS_SEARCH",
  payload: { requestId: "detail-all-abort-a", query: "modis", datasetSearch: true, docsSearch: false }
});
const detailAllSecond = dispatch({
  type: "TOOLS_SEARCH",
  payload: { requestId: "detail-all-abort-b", query: "modis", datasetSearch: true, docsSearch: false }
});
await waitUntil(() => Boolean(detailAllAbortSignal), 300);
await dispatch({ type: "AI_ABORT", requestId: "detail-all-abort-a" });
assert.equal(detailAllAbortSignal.aborted, false, "one remaining detail waiter keeps the shared fetch alive");
await dispatch({ type: "AI_ABORT", requestId: "detail-all-abort-b" });
const [detailAllFirstResult, detailAllSecondResult] = await Promise.all([detailAllFirst, detailAllSecond]);
assert.equal(detailAllFirstResult.ok, false);
assert.equal(detailAllSecondResult.ok, false);
assert.equal(detailAllAbortSignal.aborted, true, "the shared detail fetch stops once every waiter gives up");

// ---- GEE REST routing: independent OAuth orchestration behind messages.
let geeAuthFlowCalls = 0;
globalThis.chrome.identity = {
  getRedirectURL: () => "https://sw-tests.chromiumapp.org/",
  async launchWebAuthFlow({ url }) {
    geeAuthFlowCalls += 1;
    // Echo the request's OAuth state back, as Google does for legit flows.
    const requestedState = new URL(url).searchParams.get("state") || "";
    return `https://sw-tests.chromiumapp.org/#access_token=sw-token-${geeAuthFlowCalls}&expires_in=3600${requestedState ? `&state=${requestedState}` : ""}`;
  }
};
localData.settings = {
  ...localData.settings,
  geeClientId: "sw-client.apps.googleusercontent.com",
  projectId: "gee proj"
};
function geeJson(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    text: async () => JSON.stringify(body)
  };
}

// Not configured: clear Chinese guidance, no auth attempt.
localData.settings = { ...localData.settings, geeClientId: "" };
delete sessionData.geeAccessTokenV1;
const geeMissing = await dispatch({ type: "GEE_REST_LIST_ASSETS", payload: { requestId: "gee-missing" } });
assert.equal(geeMissing.ok, false);
assert.equal(geeMissing.error, "请先在设置中填写 Google OAuth 客户端 ID / Project ID");
assert.equal(geeAuthFlowCalls, 0, "missing configuration never opens the auth flow");
localData.settings = { ...localData.settings, geeClientId: "sw-client.apps.googleusercontent.com" };

// Assets success: normalization, pagination token and encoded project.
const geeUrls = [];
globalThis.fetch = async (url) => {
  geeUrls.push(String(url));
  return geeJson(200, {
    assets: [
      { id: "projects/gee proj/assets/ndvi", type: "IMAGE_COLLECTION" },
      { name: "projects/gee proj/assets/legacy" }
    ],
    nextPageToken: "page-2"
  });
};
const geeAssets = await dispatch({ type: "GEE_REST_LIST_ASSETS", payload: { requestId: "gee-assets" } });
assert.equal(geeAssets.ok, true);
assert.equal(geeAssets.requestId, "gee-assets");
assert.equal(geeAssets.nextPageToken, "page-2");
assert.deepEqual(geeAssets.items[0], { id: "projects/gee proj/assets/ndvi", name: "ndvi", type: "IMAGE_COLLECTION" });
assert.equal(geeAssets.items[1].type, "UNKNOWN", "missing asset fields get defaults");
assert.match(geeUrls[0], /\/projects\/gee%20proj\/assets\?/);
assert.match(geeUrls[0], /pageSize=100/);
assert.equal(geeAuthFlowCalls, 1, "first REST call authorizes once");

// Session-cached token: follow-up requests skip the auth flow.
const geeCached = await dispatch({ type: "GEE_REST_LIST_ASSETS", payload: { requestId: "gee-assets-cached" } });
assert.equal(geeCached.ok, true);
assert.equal(geeAuthFlowCalls, 1, "cached token skips the auth flow");

// Optional pageToken is forwarded to the REST endpoint.
await dispatch({ type: "GEE_REST_LIST_ASSETS", payload: { requestId: "gee-assets-page", pageToken: "page-2" } });
assert.match(geeUrls.at(-1), /pageToken=page-2/);

// Tasks success: pageSize=50, nextPageToken pass-through and tolerant
// operation normalization.
globalThis.fetch = async (url) => {
  geeUrls.push(String(url));
  return geeJson(200, {
    operations: [
      { name: "operations/a", metadata: { state: "RUNNING", description: "ingest image" } },
      { done: true }
    ],
    nextPageToken: "tasks-page-2"
  });
};
const geeTasks = await dispatch({ type: "GEE_REST_LIST_TASKS", payload: { requestId: "gee-tasks" } });
assert.equal(geeTasks.ok, true);
assert.equal(geeTasks.requestId, "gee-tasks");
assert.equal(geeTasks.nextPageToken, "tasks-page-2", "task lists paginate like assets");
assert.equal(geeTasks.items[0].state, "RUNNING");
assert.equal(geeTasks.items[0].summary, "ingest image");
assert.equal(geeTasks.items[1].state, "DONE", "done flag maps to DONE without metadata");
assert.match(geeUrls.at(-1), /\/operations\?pageSize=50$/);

// Optional task pageToken is forwarded to the operations endpoint.
await dispatch({ type: "GEE_REST_LIST_TASKS", payload: { requestId: "gee-tasks-page", pageToken: "tasks-page-2" } });
assert.match(geeUrls.at(-1), /pageToken=tasks-page-2/);

// 401: cache cleared, re-authorized exactly once, then success.
delete sessionData.geeAccessTokenV1;
let gee401Calls = 0;
globalThis.fetch = async () => {
  gee401Calls += 1;
  return gee401Calls === 1 ? geeJson(401, { error: { message: "expired" } }) : geeJson(200, { operations: [] });
};
const geeFlowBefore = geeAuthFlowCalls;
const geeReauth = await dispatch({ type: "GEE_REST_LIST_TASKS", payload: { requestId: "gee-401-reauth" } });
assert.equal(geeReauth.ok, true);
assert.equal(gee401Calls, 2, "one 401 retry, no more");
assert.equal(geeAuthFlowCalls, geeFlowBefore + 2, "initial auth plus exactly one re-auth");

// Persistent 401: user-readable Chinese error, still only one re-auth.
delete sessionData.geeAccessTokenV1;
globalThis.fetch = async () => geeJson(401, { error: { message: "expired" } });
const geeFailBefore = geeAuthFlowCalls;
const gee401Fail = await dispatch({ type: "GEE_REST_LIST_TASKS", payload: { requestId: "gee-401-fail" } });
assert.equal(gee401Fail.ok, false);
assert.match(gee401Fail.error, /Earth Engine 授权失败/);
assert.equal(geeAuthFlowCalls, geeFailBefore + 2, "never re-authorizes more than once");

// ---- OAuth concurrency (M7): cache misses share one authorization flow and
// concurrent 401s never wipe a fresher token.
function slowAuthFlow(tokens) {
  let calls = 0;
  return {
    get calls() {
      return calls;
    },
    async launch({ url }) {
      calls += 1;
      // Keep the flow in flight long enough for concurrent callers to arrive.
      await new Promise((resolve) => setTimeout(resolve, 20));
      const requestedState = new URL(url).searchParams.get("state") || "";
      return `https://sw-tests.chromiumapp.org/#access_token=${tokens(calls)}&expires_in=3600${requestedState ? `&state=${requestedState}` : ""}`;
    }
  };
}

// Concurrent cache misses: exactly one interactive authorization popup.
delete sessionData.geeAccessTokenV1;
const sharedFlow = slowAuthFlow((count) => `shared-token-${count}`);
globalThis.chrome.identity.launchWebAuthFlow = sharedFlow.launch;
globalThis.fetch = async () => geeJson(200, { assets: [], nextPageToken: "" });
const [concurrentA, concurrentB] = await Promise.all([
  dispatch({ type: "GEE_REST_LIST_ASSETS", payload: { requestId: "gee-concurrent-a" } }),
  dispatch({ type: "GEE_REST_LIST_ASSETS", payload: { requestId: "gee-concurrent-b" } })
]);
assert.equal(concurrentA.ok, true);
assert.equal(concurrentB.ok, true);
assert.equal(sharedFlow.calls, 1, "concurrent cache misses open exactly one auth flow");
assert.equal(sessionData.geeAccessTokenV1.token, "shared-token-1");

// Concurrent 401s on the same stale token: one re-auth, and the later 401
// must not clear the fresh token the first request just stored.
sessionData.geeAccessTokenV1 = {
  token: "stale-token",
  expiresAt: Date.now() + 60 * 60 * 1000,
  clientId: "sw-client.apps.googleusercontent.com"
};
const reauthFlow = slowAuthFlow((count) => `fresh-token-${count}`);
globalThis.chrome.identity.launchWebAuthFlow = reauthFlow.launch;
let staleUses = 0;
let freshUses = 0;
globalThis.fetch = async (_url, options) => {
  const auth = String(options?.headers?.Authorization || "");
  if (auth.includes("stale-token")) {
    staleUses += 1;
    return geeJson(401, { error: { message: "expired" } });
  }
  freshUses += 1;
  return geeJson(200, { assets: [], nextPageToken: "" });
};
const [reauthA, reauthB] = await Promise.all([
  dispatch({ type: "GEE_REST_LIST_ASSETS", payload: { requestId: "gee-401-concurrent-a" } }),
  dispatch({ type: "GEE_REST_LIST_ASSETS", payload: { requestId: "gee-401-concurrent-b" } })
]);
assert.equal(reauthA.ok, true);
assert.equal(reauthB.ok, true);
assert.equal(staleUses, 2, "both requests started with the stale token");
assert.equal(freshUses, 2, "both retries succeeded with the fresh token");
assert.equal(reauthFlow.calls, 1, "concurrent 401s re-authorize exactly once");
assert.equal(sessionData.geeAccessTokenV1.token, "fresh-token-1", "the fresh token survives a late concurrent 401");

console.log("Service worker tests passed.");

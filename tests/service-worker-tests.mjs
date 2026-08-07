import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";

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

console.log("Service worker tests passed.");

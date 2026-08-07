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

await import(`../service-worker.js?test=${Date.now()}`);

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

console.log("Service worker tests passed.");

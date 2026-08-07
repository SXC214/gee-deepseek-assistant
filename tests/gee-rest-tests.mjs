import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import {
  GEE_AUTH_ENDPOINT,
  GEE_AUTH_SCOPE,
  GEE_REST_BASE,
  __timings,
  buildAuthUrl,
  parseAuthFragment,
  normalizeAsset,
  normalizeOperation,
  listAssets,
  listTasks
} from "../lib/gee-rest.js";

if (!globalThis.crypto) globalThis.crypto = webcrypto;
__timings.restBackoffMs = 2;

function mockResponse(status, body = "") {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    text: async () => (typeof body === "string" ? body : JSON.stringify(body))
  };
}

// ---- buildAuthUrl: implicit flow with the earthengine scope.
{
  const url = new URL(buildAuthUrl("client-123.apps.googleusercontent.com", "https://abc.chromiumapp.org/"));
  assert.equal(`${url.origin}${url.pathname}`, GEE_AUTH_ENDPOINT);
  assert.equal(url.searchParams.get("client_id"), "client-123.apps.googleusercontent.com");
  assert.equal(url.searchParams.get("response_type"), "token");
  assert.equal(url.searchParams.get("scope"), GEE_AUTH_SCOPE);
  assert.equal(url.searchParams.get("redirect_uri"), "https://abc.chromiumapp.org/");
  assert.equal(url.searchParams.get("include_granted_scopes"), "true");
  assert.throws(() => buildAuthUrl("", "https://x/"), /客户端 ID/);
  assert.throws(() => buildAuthUrl("client", ""), /重定向 URI/);
}

// ---- parseAuthFragment: token extraction, defaults and error fragments.
{
  const parsed = parseAuthFragment("https://abc.chromiumapp.org/#access_token=ya29.tok&expires_in=3599&token_type=Bearer");
  assert.equal(parsed.accessToken, "ya29.tok");
  assert.equal(parsed.expiresIn, 3599);
  const fallback = parseAuthFragment("https://abc.chromiumapp.org/#access_token=only-token");
  assert.equal(fallback.expiresIn, 3600);
  assert.throws(() => parseAuthFragment("https://abc.chromiumapp.org/#error=access_denied"), /授权失败/);
  assert.throws(() => parseAuthFragment("https://abc.chromiumapp.org/#token_type=Bearer"), /access_token/);
}

// ---- Normalization tolerates missing fields.
{
  assert.deepEqual(normalizeAsset({ id: "projects/p/assets/folder/img", type: "IMAGE" }), {
    id: "projects/p/assets/folder/img",
    name: "img",
    type: "IMAGE"
  });
  assert.deepEqual(normalizeAsset({ name: "projects/p/assets/only-name" }), {
    id: "projects/p/assets/only-name",
    name: "only-name",
    type: "UNKNOWN"
  });
  assert.deepEqual(normalizeAsset(null), { id: "", name: "（未知资产）", type: "UNKNOWN" });
  assert.deepEqual(normalizeOperation({
    name: "operations/abc",
    metadata: { state: "COMPLETED", description: "Export image" }
  }), { name: "operations/abc", state: "COMPLETED", summary: "Export image" });
  assert.deepEqual(normalizeOperation({ done: false }), { name: "", state: "RUNNING", summary: "" });
}

// ---- listAssets: URL encoding, auth header, pagination parsing.
{
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options });
    return mockResponse(200, {
      assets: [
        { id: "projects/p/assets/ndvi", type: "IMAGE_COLLECTION" },
        { name: "projects/p/assets/legacy/table1", type: "TABLE" }
      ],
      nextPageToken: "next-1"
    });
  };
  const result = await listAssets("tok-1", "my proj", "prev-token");
  assert.equal(calls.length, 1);
  assert.ok(calls[0].url.startsWith(`${GEE_REST_BASE}/projects/my%20proj/assets?`), "project is URL-encoded");
  assert.match(calls[0].url, /pageSize=100/);
  assert.match(calls[0].url, /pageToken=prev-token/);
  assert.equal(calls[0].options.headers.Authorization, "Bearer tok-1");
  assert.equal(result.nextPageToken, "next-1");
  assert.deepEqual(result.items[0], { id: "projects/p/assets/ndvi", name: "ndvi", type: "IMAGE_COLLECTION" });
  assert.deepEqual(result.items[1], { id: "projects/p/assets/legacy/table1", name: "table1", type: "TABLE" });
}

// ---- listTasks: pageSize=50 and tolerant normalization.
{
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(url);
    return mockResponse(200, {
      operations: [{ name: "operations/x", metadata: { state: "RUNNING", description: "ingest" } }, { done: true }]
    });
  };
  const result = await listTasks("tok-2", "proj");
  assert.match(calls[0], /\/projects\/proj\/operations\?pageSize=50$/);
  assert.equal(result.items.length, 2);
  assert.equal(result.items[0].state, "RUNNING");
  assert.equal(result.items[1].state, "DONE");
}

// ---- 401 surfaces as code UNAUTHORIZED; 503 is retried (maxRetries 2).
{
  globalThis.fetch = async () => mockResponse(401, { error: { message: "expired" } });
  const error = await listAssets("tok", "proj").then(() => null, (failure) => failure);
  assert.equal(error.code, "UNAUTHORIZED");

  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return calls <= 2 ? mockResponse(503) : mockResponse(200, { assets: [] });
  };
  const result = await listAssets("tok", "proj");
  assert.equal(calls, 3, "503 is retried up to maxRetries=2");
  assert.deepEqual(result.items, []);

  calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return mockResponse(503);
  };
  const exhausted = await listAssets("tok", "proj").then(() => null, (failure) => failure);
  assert.equal(calls, 3, "retry budget is exhausted after 3 attempts");
  assert.match(exhausted.message, /HTTP 503/);
}

// ---- Authorization orchestration inside the service worker.
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

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function createStorageArea(data) {
  return {
    async get(key) {
      if (typeof key === "string") return { [key]: clone(data[key]) };
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

const localData = {
  settings: {
    baseUrl: "https://api.deepseek.com",
    model: "deepseek-v4-flash",
    projectId: "gee proj",
    geeClientId: "client-id-1.apps.googleusercontent.com"
  }
};
const sessionData = {};
let authFlowCalls = 0;
let authFlowUrls = [];
globalThis.chrome = {
  runtime: {
    onInstalled: createEvent(),
    onStartup: createEvent(),
    onConnect: createEvent(),
    onMessage: createEvent()
  },
  sidePanel: {
    async setPanelBehavior() {}
  },
  storage: {
    local: createStorageArea(localData),
    session: createStorageArea(sessionData)
  },
  identity: {
    getRedirectURL: () => "https://test-extension.chromiumapp.org/",
    async launchWebAuthFlow({ url }) {
      authFlowCalls += 1;
      authFlowUrls.push(url);
      return `https://test-extension.chromiumapp.org/#access_token=flow-token-${authFlowCalls}&expires_in=3600`;
    }
  }
};
globalThis.fetch = async () => {
  throw new Error("Unexpected fetch");
};

const worker = await import(`../service-worker.js?gee-rest=${Date.now()}`);
const assetsBody = {
  assets: [{ id: "projects/gee proj/assets/ndvi", type: "IMAGE_COLLECTION" }],
  nextPageToken: ""
};

// Cache hit: unexpired token skips the auth flow entirely.
{
  sessionData.geeAccessTokenV1 = { token: "cached-token", expiresAt: Date.now() + 10 * 60 * 1000 };
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options });
    return mockResponse(200, assetsBody);
  };
  const before = authFlowCalls;
  const result = await worker.__testing.runGeeRestCall("assets", {});
  assert.equal(authFlowCalls, before, "valid cache never opens the auth flow");
  assert.equal(calls[0].options.headers.Authorization, "Bearer cached-token");
  assert.ok(calls[0].url.includes("/projects/gee%20proj/assets"), "project id is encoded in the REST URL");
  assert.equal(result.items[0].name, "ndvi");
}

// Expired cache: re-authorizes and writes the fresh record back.
{
  sessionData.geeAccessTokenV1 = { token: "old-token", expiresAt: Date.now() - 1000 };
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push(options);
    return mockResponse(200, assetsBody);
  };
  const before = authFlowCalls;
  await worker.__testing.runGeeRestCall("assets", {});
  assert.equal(authFlowCalls, before + 1, "expired cache triggers one auth flow");
  const authUrl = new URL(authFlowUrls.at(-1));
  assert.equal(authUrl.searchParams.get("client_id"), "client-id-1.apps.googleusercontent.com");
  assert.equal(authUrl.searchParams.get("redirect_uri"), "https://test-extension.chromiumapp.org/");
  assert.equal(calls[0].headers.Authorization, `Bearer flow-token-${authFlowCalls}`);
  assert.equal(sessionData.geeAccessTokenV1.token, `flow-token-${authFlowCalls}`);
  assert.ok(sessionData.geeAccessTokenV1.expiresAt > Date.now());
}

// 401: cache is cleared and re-authorization happens exactly once.
{
  delete sessionData.geeAccessTokenV1;
  let calls = 0;
  const seenAuth = [];
  globalThis.fetch = async (_url, options) => {
    calls += 1;
    seenAuth.push(options.headers.Authorization);
    return calls === 1
      ? mockResponse(401, { error: { message: "expired" } })
      : mockResponse(200, { operations: [{ name: "operations/x", metadata: { state: "DONE" } }] });
  };
  const before = authFlowCalls;
  const result = await worker.__testing.runGeeRestCall("tasks", {});
  assert.equal(calls, 2, "one 401 retry, no more");
  assert.equal(authFlowCalls, before + 2, "initial auth plus exactly one re-auth");
  assert.notEqual(seenAuth[0], seenAuth[1], "retry uses the fresh token");
  assert.match(seenAuth[0], /Bearer flow-token-/);
  assert.equal(result.items[0].state, "DONE");
}

// Persistent 401: surfaces a readable Chinese error after one re-auth.
{
  delete sessionData.geeAccessTokenV1;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return mockResponse(401, { error: { message: "expired" } });
  };
  const before = authFlowCalls;
  const error = await worker.__testing.runGeeRestCall("assets", {}).then(() => null, (failure) => failure);
  assert.equal(calls, 2);
  assert.equal(authFlowCalls, before + 2, "never re-authorizes more than once");
  assert.match(error.message, /Earth Engine 授权失败/);
  assert.equal(error.code, undefined, "final error is user-facing, not UNAUTHORIZED");
}

// Missing configuration: clear guidance instead of an auth attempt.
{
  const savedClientId = localData.settings.geeClientId;
  localData.settings.geeClientId = "";
  delete sessionData.geeAccessTokenV1;
  const before = authFlowCalls;
  const error = await worker.__testing.runGeeRestCall("assets", {}).then(() => null, (failure) => failure);
  assert.equal(error.message, "请先在设置中填写 Google OAuth 客户端 ID / Project ID");
  assert.equal(authFlowCalls, before, "no auth flow without configuration");
  localData.settings.geeClientId = savedClientId;
}

console.log("GEE REST tests passed.");

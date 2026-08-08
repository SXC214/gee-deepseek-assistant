import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import {
  GEE_AUTH_ENDPOINT,
  GEE_AUTH_SCOPE,
  GEE_REST_BASE,
  OAUTH_STATE_MIN_LENGTH,
  __timings,
  buildAuthUrl,
  createOAuthState,
  parseAuthFragment,
  verifyOAuthState,
  normalizeAsset,
  normalizeOperation,
  listAssets,
  listTasks,
  importTable,
  pollOperation
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

// ---- buildAuthUrl: implicit flow with the earthengine scope and CSRF state.
{
  const { url, state } = buildAuthUrl("client-123.apps.googleusercontent.com", "https://abc.chromiumapp.org/");
  const parsed = new URL(url);
  assert.equal(`${parsed.origin}${parsed.pathname}`, GEE_AUTH_ENDPOINT);
  assert.equal(parsed.searchParams.get("client_id"), "client-123.apps.googleusercontent.com");
  assert.equal(parsed.searchParams.get("response_type"), "token");
  assert.equal(parsed.searchParams.get("scope"), GEE_AUTH_SCOPE);
  assert.equal(parsed.searchParams.get("redirect_uri"), "https://abc.chromiumapp.org/");
  assert.equal(parsed.searchParams.get("include_granted_scopes"), "true");
  assert.equal(parsed.searchParams.get("state"), state, "the generated state rides along in the URL");
  assert.match(state, /^[0-9a-f]{64}$/, "state is 32 random bytes rendered as hex");
  assert.notEqual(state, buildAuthUrl("client", "https://x/").state, "every request gets fresh state");
  assert.equal(buildAuthUrl("client", "https://x/", "fixed-state").state, "fixed-state", "callers may pin state");
  assert.throws(() => buildAuthUrl("", "https://x/"), /客户端 ID/);
  assert.throws(() => buildAuthUrl("client", ""), /重定向 URI/);
}

// ---- OAuth state generation and constant-time verification.
{
  const state = createOAuthState();
  assert.match(state, /^[0-9a-f]{64}$/);
  assert.equal(state.length >= OAUTH_STATE_MIN_LENGTH, true);
  assert.notEqual(state, createOAuthState());
  assert.equal(verifyOAuthState(state, state), true);
  const flipped = `${state.slice(0, -1)}${state.at(-1) === "0" ? "1" : "0"}`;
  assert.equal(verifyOAuthState(state, flipped), false, "one flipped nibble fails");
  assert.equal(verifyOAuthState(state, ""), false, "missing callback state fails");
  assert.equal(verifyOAuthState(state, `${state}00`), false, "length mismatch fails");
  assert.equal(verifyOAuthState("short", "short"), false, "low-entropy state is never accepted");
  assert.equal(verifyOAuthState(null, state), false);
  assert.equal(verifyOAuthState(state, null), false);
}

// ---- parseAuthFragment: token extraction, defaults, state and error fragments.
{
  const parsed = parseAuthFragment("https://abc.chromiumapp.org/#access_token=ya29.tok&expires_in=3599&token_type=Bearer&state=abc123");
  assert.equal(parsed.accessToken, "ya29.tok");
  assert.equal(parsed.expiresIn, 3599);
  assert.equal(parsed.state, "abc123");
  const fallback = parseAuthFragment("https://abc.chromiumapp.org/#access_token=only-token");
  assert.equal(fallback.expiresIn, 3600);
  assert.equal(fallback.state, "", "absent state surfaces as an empty string for the verifier");
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

// ---- listTasks: pageSize=50, optional pageToken and tolerant normalization.
{
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(url);
    return mockResponse(200, {
      operations: [{ name: "operations/x", metadata: { state: "RUNNING", description: "ingest" } }, { done: true }],
      nextPageToken: "tasks-next-1"
    });
  };
  const result = await listTasks("tok-2", "proj");
  assert.match(calls[0], /\/projects\/proj\/operations\?pageSize=50$/);
  assert.equal(result.items.length, 2);
  assert.equal(result.items[0].state, "RUNNING");
  assert.equal(result.items[1].state, "DONE");
  assert.equal(result.nextPageToken, "tasks-next-1");
  await listTasks("tok-2", "proj", "tasks-next-1");
  assert.match(calls[1], /pageSize=50/);
  assert.match(calls[1], /pageToken=tasks-next-1/);
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

// ---- importTable: request shape, headers and LRO response pass-through.
{
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options });
    return mockResponse(200, { name: "projects/gee proj/operations/op-1", done: false, metadata: { type: "INGEST_TABLE" } });
  };
  const operation = await importTable("tok-import", "gee proj", {
    assetName: "boundaries",
    uris: ["gs://bucket/a.csv", "gs://bucket/b.csv"],
    charset: "UTF-8"
  });
  assert.equal(calls.length, 1);
  assert.ok(calls[0].url.endsWith("/projects/gee%20proj/table:import"), "project is URL-encoded in the path");
  assert.equal(calls[0].options.method, "POST");
  assert.equal(calls[0].options.headers.Authorization, "Bearer tok-import");
  assert.equal(calls[0].options.headers["Content-Type"], "application/json");
  const body = JSON.parse(calls[0].options.body);
  assert.match(body.requestId, /^[0-9a-f-]{36}$/i, "requestId is a UUID");
  assert.equal(body.tableManifest.name, "projects/gee proj/assets/boundaries", "the manifest keeps the raw project name");
  assert.deepEqual(body.tableManifest.sources, [{
    charset: "UTF-8",
    maxErrorMeters: 1,
    uris: ["gs://bucket/a.csv", "gs://bucket/b.csv"]
  }]);
  assert.equal(operation.done, false);
  assert.equal(operation.name, "projects/gee proj/operations/op-1");

  await assert.rejects(importTable("tok", "proj", { uris: ["gs://b/x.csv"] }), /资产名称/);
  await assert.rejects(importTable("tok", "proj", { assetName: "t", uris: [] }), /上传来源/);
}

// ---- importTable errors: 409 maps to ALREADY_EXISTS; 503 is never retried.
{
  globalThis.fetch = async () => mockResponse(409, { error: { message: "asset exists", status: "ALREADY_EXISTS" } });
  const conflict = await importTable("tok", "proj", { assetName: "t", uris: ["gs://b/x.csv"] }).then(() => null, (failure) => failure);
  assert.equal(conflict.code, "ALREADY_EXISTS");
  assert.equal(conflict.status, 409);
  assert.match(conflict.message, /asset exists/);

  let postCalls = 0;
  globalThis.fetch = async () => {
    postCalls += 1;
    return mockResponse(503, {});
  };
  const failure = await importTable("tok", "proj", { assetName: "t", uris: ["gs://b/x.csv"] }).then(() => null, (err) => err);
  assert.equal(postCalls, 1, "non-idempotent POSTs never auto-retry");
  assert.match(failure.message, /HTTP 503/);

  globalThis.fetch = async () => mockResponse(401, { error: { message: "expired" } });
  const unauthorized = await importTable("tok", "proj", { assetName: "t", uris: ["gs://b/x.csv"] }).then(() => null, (err) => err);
  assert.equal(unauthorized.code, "UNAUTHORIZED", "401 keeps the re-auth contract");
}

// ---- pollOperation: polls until done and reuses the retryable GET path.
{
  __timings.importPollIntervalMs = 5;
  const polls = [];
  let pollCount = 0;
  globalThis.fetch = async (url, options) => {
    polls.push({ url, options });
    pollCount += 1;
    if (pollCount < 2) return mockResponse(200, { name: "projects/p/operations/op-9", done: false, metadata: { type: "INGEST_TABLE" } });
    if (pollCount < 3) return mockResponse(503, {});
    return mockResponse(200, {
      name: "projects/p/operations/op-9",
      done: true,
      response: { name: "projects/p/assets/tbl", type: "TABLE" }
    });
  };
  const final = await pollOperation("tok-poll", "projects/p/operations/op-9");
  assert.equal(polls.length, 3, "running -> 503 (retried once) -> done");
  for (const call of polls) {
    assert.equal(call.url, `${GEE_REST_BASE}/projects/p/operations/op-9`);
    assert.equal(call.options.headers.Authorization, "Bearer tok-poll");
  }
  assert.equal(final.done, true);
  assert.equal(final.response.type, "TABLE");
}

// ---- pollOperation: operation.error rejects with the server detail.
{
  globalThis.fetch = async () => mockResponse(200, {
    name: "projects/p/operations/op-err",
    done: true,
    error: { code: 3, message: "manifest invalid" }
  });
  const failure = await pollOperation("tok", "projects/p/operations/op-err").then(() => null, (err) => err);
  assert.equal(failure.code, "OPERATION_FAILED");
  assert.match(failure.message, /manifest invalid/);
}

// ---- pollOperation: never-done operations hit the poll timeout.
{
  __timings.importPollIntervalMs = 2;
  globalThis.fetch = async () => mockResponse(200, { name: "projects/p/operations/op-slow", done: false });
  const timeout = await pollOperation("tok", "projects/p/operations/op-slow", { timeoutMs: 30 }).then(() => null, (err) => err);
  assert.equal(timeout.code, "POLL_TIMEOUT");
  assert.match(timeout.message, /未在/);
  __timings.importPollIntervalMs = 2500;
}

// ---- pollOperation: an external abort interrupts the wait between polls.
{
  __timings.importPollIntervalMs = 200;
  globalThis.fetch = async () => mockResponse(200, { name: "projects/p/operations/op-abort", done: false });
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 20);
  const aborted = await pollOperation("tok", "projects/p/operations/op-abort", { signal: controller.signal }).then(() => null, (err) => err);
  assert.equal(aborted.name, "AbortError");
  __timings.importPollIntervalMs = 2500;
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
// When non-null, the fake auth flow returns this state instead of echoing the
// request's state, letting tests exercise CSRF rejection paths.
let authFlowStateOverride = null;
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
      const requestedState = new URL(url).searchParams.get("state") || "";
      const callbackState = authFlowStateOverride !== null ? authFlowStateOverride : requestedState;
      const fragment = `access_token=flow-token-${authFlowCalls}&expires_in=3600${callbackState ? `&state=${callbackState}` : ""}`;
      return `https://test-extension.chromiumapp.org/#${fragment}`;
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
  assert.match(authUrl.searchParams.get("state") || "", /^[0-9a-f]{64}$/, "the auth request carries high-entropy state");
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

// CSRF guard (m1): a callback that omits the state is rejected.
{
  delete sessionData.geeAccessTokenV1;
  authFlowStateOverride = "";
  const before = authFlowCalls;
  const error = await worker.__testing.runGeeRestCall("assets", {}).then(() => null, (failure) => failure);
  authFlowStateOverride = null;
  assert.equal(authFlowCalls, before + 1, "one flow ran before the callback was rejected");
  assert.match(error.message, /state 校验未通过/, "missing callback state is refused with a readable error");
  assert.equal(sessionData.geeAccessTokenV1, undefined, "no token is cached from a rejected callback");
}

// CSRF guard (m1): a callback whose state does not match the request is rejected.
{
  delete sessionData.geeAccessTokenV1;
  authFlowStateOverride = "f".repeat(64);
  const before = authFlowCalls;
  const error = await worker.__testing.runGeeRestCall("assets", {}).then(() => null, (failure) => failure);
  authFlowStateOverride = null;
  assert.equal(authFlowCalls, before + 1);
  assert.match(error.message, /state 校验未通过/, "mismatched callback state is refused");
  assert.equal(sessionData.geeAccessTokenV1, undefined, "a forged callback never installs a token");
}

// After a rejected callback the auth lock is released: a normal flow succeeds again.
{
  delete sessionData.geeAccessTokenV1;
  globalThis.fetch = async () => mockResponse(200, assetsBody);
  const before = authFlowCalls;
  const result = await worker.__testing.runGeeRestCall("assets", {});
  assert.equal(authFlowCalls, before + 1);
  assert.equal(result.items[0].name, "ndvi", "the lock recovers after a CSRF rejection");
}

console.log("GEE REST tests passed.");

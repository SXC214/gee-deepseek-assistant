import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const bridgeSource = fs.readFileSync(new URL("../page-bridge.js", import.meta.url), "utf8");
const contentSource = fs.readFileSync(new URL("../content-script.js", import.meta.url), "utf8");

// Google internal endpoints wrap JSON in an anti-XSSI )]}' envelope.
function envelope(body) {
  return `)]}'\n${typeof body === "string" ? body : JSON.stringify(body)}`;
}

function httpResponse(status, body) {
  const text = typeof body === "string" ? body : envelope(body);
  return { ok: status >= 200 && status < 300, status, text: async () => text };
}

function createBridgeHarness({ hostname = "code.earthengine.google.com", onFetch }) {
  const listeners = new Map();
  const posted = [];
  const calls = [];
  const windowMock = {
    addEventListener(type, handler) { listeners.set(type, handler); },
    postMessage(message) { posted.push(message); },
    location: { hostname }
  };
  const context = vm.createContext({
    window: windowMock,
    document: { title: "Mock Script - Earth Engine Code Editor", querySelector: () => null },
    fetch: async (url, options = {}) => {
      const call = { url, options };
      calls.push(call);
      return onFetch(call, calls);
    },
    FormData,
    Blob,
    setTimeout,
    clearTimeout,
    Promise,
    Date,
    // Host JSON so parsed structures share the test realm (deepEqual-friendly).
    JSON
  });
  vm.runInContext(bridgeSource, context);

  return {
    calls,
    async request(action, payload = {}) {
      posted.length = 0;
      await listeners.get("message")({
        source: windowMock,
        data: { channel: "gee-ai-assistant", type: "GEE_AI_BRIDGE_REQUEST", id: "shp", action, payload }
      });
      // structuredClone moves the reply back into the test realm so
      // deepStrictEqual can compare cross-realm structures.
      return structuredClone(posted.at(-1));
    }
  };
}

// XSRF fetch + geturl success: envelope stripping, credentials and XSRF header.
let tokenRefreshes = 0;
const successHarness = createBridgeHarness({
  onFetch(call) {
    if (call.url === "/xsrf/refresh") {
      tokenRefreshes += 1;
      return httpResponse(200, envelope({ xsrfToken: "TOK-1", xsrfTokenExpiresInMs: 600000 }));
    }
    if (call.url === "/assets/upload/geturl") {
      return httpResponse(200, envelope({ url: "https://blobstore.example/session-1" }));
    }
    throw new Error(`Unexpected fetch: ${call.url}`);
  }
});

const firstUrl = await successHarness.request("SHP_GET_UPLOAD_URL");
assert.equal(firstUrl.ok, true);
assert.equal(firstUrl.result.url, "https://blobstore.example/session-1");
assert.equal(tokenRefreshes, 1);
assert.equal(successHarness.calls[0].options.credentials, "include");
assert.equal(successHarness.calls[1].options.credentials, "include");
assert.equal(successHarness.calls[1].options.headers["x-xsrf-token"], "TOK-1");

// Token cached inside its TTL: a second geturl must not refresh the XSRF token.
const secondUrl = await successHarness.request("SHP_GET_UPLOAD_URL");
assert.equal(secondUrl.ok, true);
assert.equal(secondUrl.result.url, "https://blobstore.example/session-1");
assert.equal(tokenRefreshes, 1);

function createGeturlFailureHarness(status) {
  let refreshes = 0;
  const harness = createBridgeHarness({
    onFetch(call) {
      if (call.url === "/xsrf/refresh") {
        refreshes += 1;
        return httpResponse(200, envelope({ xsrfToken: `TOK-${refreshes}`, xsrfTokenExpiresInMs: 600000 }));
      }
      return httpResponse(status, envelope({ error: "denied" }));
    }
  });
  return { harness, refreshes: () => refreshes };
}

// 401 maps to the readable session error and drops the cached token.
{
  const { harness, refreshes } = createGeturlFailureHarness(401);
  const failed = await harness.request("SHP_GET_UPLOAD_URL");
  assert.equal(failed.ok, false);
  assert.match(failed.error, /页面会话无效或未登录/);
  assert.match(failed.error, /401/);
  await harness.request("SHP_GET_UPLOAD_URL");
  assert.equal(refreshes(), 2);
}

// 403 shares the same session-error semantics.
{
  const { harness } = createGeturlFailureHarness(403);
  const failed = await harness.request("SHP_GET_UPLOAD_URL");
  assert.equal(failed.ok, false);
  assert.match(failed.error, /页面会话无效或未登录/);
  assert.match(failed.error, /403/);
}

// Other non-2xx statuses surface a structured HTTP error.
{
  const { harness } = createGeturlFailureHarness(500);
  const failed = await harness.request("SHP_GET_UPLOAD_URL");
  assert.equal(failed.ok, false);
  assert.match(failed.error, /HTTP error 500/);
}

// Network failure while fetching the XSRF token surfaces a Chinese error.
{
  const harness = createBridgeHarness({
    onFetch() { throw new TypeError("Failed to fetch"); }
  });
  const failed = await harness.request("SHP_GET_UPLOAD_URL");
  assert.equal(failed.ok, false);
  assert.match(failed.error, /网络请求失败/);
}

// Byte upload: multipart part names are hardcoded to "file", filenames and
// bytes are preserved, and gs:// uris map back onto the file order.
{
  let uploadCall = null;
  const harness = createBridgeHarness({
    onFetch(call) {
      if (call.url === "https://blobstore.example/session-9") {
        uploadCall = call;
        return httpResponse(200, envelope(["gs://bucket/uploads/a.shp", "gs://bucket/uploads/b.dbf"]));
      }
      throw new Error(`Unexpected fetch: ${call.url}`);
    }
  });

  const shpBytes = new Uint8Array([1, 2, 3, 4]);
  const dbfBytes = new Uint8Array([9, 8, 7]);
  const upload = await harness.request("SHP_UPLOAD_BLOB", {
    uploadUrl: "https://blobstore.example/session-9",
    files: [
      { name: "a.shp", buffer: shpBytes.buffer },
      { name: "b.dbf", buffer: dbfBytes }
    ]
  });
  assert.equal(upload.ok, true);
  assert.deepEqual(upload.result.uris, ["gs://bucket/uploads/a.shp", "gs://bucket/uploads/b.dbf"]);
  assert.deepEqual(upload.result.files, [
    { name: "a.shp", uri: "gs://bucket/uploads/a.shp" },
    { name: "b.dbf", uri: "gs://bucket/uploads/b.dbf" }
  ]);

  assert.equal(uploadCall.options.method, "POST");
  assert.equal(uploadCall.options.credentials, "include");
  assert.equal(uploadCall.options.headers, undefined);
  assert.ok(uploadCall.options.body instanceof FormData);
  const parts = [...uploadCall.options.body.entries()];
  assert.equal(parts.length, 2);
  assert.deepEqual(parts.map(([field]) => field), ["file", "file"]);
  assert.deepEqual(parts.map(([, file]) => file.name), ["a.shp", "b.dbf"]);
  assert.deepEqual(new Uint8Array(await parts[0][1].arrayBuffer()), shpBytes);
  assert.deepEqual(new Uint8Array(await parts[1][1].arrayBuffer()), dbfBytes);
}

// Blobstore non-2xx surfaces the HTTP status in the error message.
{
  const harness = createBridgeHarness({
    onFetch() { return httpResponse(500, "server exploded"); }
  });
  const failed = await harness.request("SHP_UPLOAD_BLOB", {
    uploadUrl: "https://blobstore.example/session-x",
    files: [{ name: "a.shp", buffer: new Uint8Array([1]).buffer }]
  });
  assert.equal(failed.ok, false);
  assert.match(failed.error, /HTTP error 500/);
}

// Payload validation: missing uploadUrl and empty file lists are rejected
// before any network call happens.
{
  const harness = createBridgeHarness({
    onFetch() { throw new Error("no fetch expected"); }
  });
  const missingUrl = await harness.request("SHP_UPLOAD_BLOB", {
    files: [{ name: "a.shp", buffer: new ArrayBuffer(1) }]
  });
  assert.equal(missingUrl.ok, false);
  assert.match(missingUrl.error, /uploadUrl/);

  const emptyFiles = await harness.request("SHP_UPLOAD_BLOB", {
    uploadUrl: "https://blobstore.example/session-x",
    files: []
  });
  assert.equal(emptyFiles.ok, false);
  assert.match(emptyFiles.error, /files/);
}

// Both actions are rejected outside the Code Editor origin without fetching.
{
  const harness = createBridgeHarness({
    hostname: "earthengine.google.com",
    onFetch() { throw new Error("fetch must not be called outside the editor origin"); }
  });
  const urlResult = await harness.request("SHP_GET_UPLOAD_URL");
  assert.equal(urlResult.ok, false);
  assert.match(urlResult.error, /code\.earthengine\.google\.com/);

  const blobResult = await harness.request("SHP_UPLOAD_BLOB", { uploadUrl: "https://blobstore.example/x", files: [] });
  assert.equal(blobResult.ok, false);
  assert.match(blobResult.error, /code\.earthengine\.google\.com/);
  assert.equal(harness.calls.length, 0);
}

// ---------- content-script forwarding ----------

function createContentHarness() {
  let chromeHandler = null;
  let windowHandler = null;
  const posted = [];
  const windowMock = {
    addEventListener(type, handler) { if (type === "message") windowHandler = handler; },
    postMessage(message) { posted.push(message); }
  };
  const context = vm.createContext({
    window: windowMock,
    document: { querySelectorAll: () => [], querySelector: () => null, getElementById: () => null },
    chrome: { runtime: { onMessage: { addListener(handler) { chromeHandler = handler; } } } },
    crypto: { randomUUID: () => "cs-request-id" },
    setTimeout,
    clearTimeout,
    Promise,
    Set
  });
  vm.runInContext(contentSource, context);

  return {
    posted,
    dispatch(message, sendResponse) {
      return chromeHandler(message, {}, sendResponse);
    },
    resolveBridge(result, { ok = true, error } = {}) {
      windowHandler({
        source: windowMock,
        data: { channel: "gee-ai-assistant", type: "GEE_AI_BRIDGE_RESPONSE", id: "cs-request-id", ok, result, error }
      });
    }
  };
}

// SHP_GET_UPLOAD_URL is forwarded through the bridge with the standard wrapper.
{
  const harness = createContentHarness();
  let response = null;
  const async = harness.dispatch({ type: "SHP_GET_UPLOAD_URL" }, (value) => { response = structuredClone(value); });
  assert.equal(async, true);
  assert.equal(harness.posted.length, 1);
  assert.equal(harness.posted[0].channel, "gee-ai-assistant");
  assert.equal(harness.posted[0].action, "SHP_GET_UPLOAD_URL");
  harness.resolveBridge({ url: "https://blobstore.example/session-2" });
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(response, { ok: true, result: { url: "https://blobstore.example/session-2" } });
}

// SHP_UPLOAD_BLOB forwards the payload verbatim and preserves error wrapping.
{
  const harness = createContentHarness();
  const payload = {
    uploadUrl: "https://blobstore.example/session-3",
    files: [{ name: "a.shp", buffer: new ArrayBuffer(2) }]
  };
  let response = null;
  const async = harness.dispatch({ type: "SHP_UPLOAD_BLOB", payload }, (value) => { response = structuredClone(value); });
  assert.equal(async, true);
  assert.equal(harness.posted[0].action, "SHP_UPLOAD_BLOB");
  assert.equal(harness.posted[0].payload.uploadUrl, payload.uploadUrl);
  harness.resolveBridge(null, { ok: false, error: "页面会话无效或未登录，请在 Code Editor 页面刷新后重试（HTTP 401）" });
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(response.ok, false);
  assert.match(response.error, /页面会话无效或未登录/);
}

console.log("Page-bridge shapefile upload tests passed.");

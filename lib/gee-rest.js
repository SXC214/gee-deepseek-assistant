// Minimal Google Earth Engine REST (v1) client used with the extension's own
// independent OAuth client. Pure logic only: chrome APIs stay in the service
// worker, so every function here is unit-testable in Node with a fetch mock.
// Web-page tokens are never reused; tokens come exclusively from a user-
// approved chrome.identity authorization flow.

import { fetchWithPolicy, waitInterruptible } from "./http.js";

export const GEE_AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
export const GEE_AUTH_SCOPE = "https://www.googleapis.com/auth/earthengine";
export const GEE_REST_BASE = "https://earthengine.googleapis.com/v1";
export const GEE_REST_MAX_RETRIES = 2;
export const OAUTH_STATE_MIN_LENGTH = 32;

// Mutable so Node tests can shorten retry backoff; production defaults stay
// conservative.
export const __timings = {
  restTimeoutMs: 20000,
  restBackoffMs: 1000,
  importPollIntervalMs: 2500,
  importPollTimeoutMs: 120000
};

export function createGeeRestError(message, code = "GEE_REST_ERROR", status = 0) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  return error;
}

/**
 * High-entropy OAuth state: 32 random bytes rendered as 64 hex characters.
 * crypto.getRandomValues is a CSP-safe PRNG source available in both the
 * service worker and Node test environments (stronger than a single UUID).
 */
export function createOAuthState() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * Compares the state sent with the authorization request against the state
 * echoed in the callback. A plain equality check would be practically safe
 * for 256-bit random state, but a constant-time comparison removes even the
 * theoretical timing channel at zero practical cost, so it is preferred.
 */
export function verifyOAuthState(expected, actual) {
  if (typeof expected !== "string" || typeof actual !== "string") return false;
  if (expected.length < OAUTH_STATE_MIN_LENGTH || expected.length !== actual.length) return false;
  let diff = 0;
  for (let index = 0; index < expected.length; index += 1) {
    diff |= expected.charCodeAt(index) ^ actual.charCodeAt(index);
  }
  return diff === 0;
}

/**
 * Builds the implicit-flow authorization URL for the extension's own client.
 * Returns { url, state }: every request carries a fresh high-entropy state
 * that the caller must keep (inside its authorization lock) and verify
 * against the callback to block CSRF / response-confusion attacks.
 */
export function buildAuthUrl(clientId, redirectUri, state = createOAuthState()) {
  if (!String(clientId || "").trim()) throw new Error("缺少 Google OAuth 客户端 ID");
  if (!String(redirectUri || "").trim()) throw new Error("缺少授权重定向 URI");
  const params = new URLSearchParams({
    client_id: String(clientId).trim(),
    response_type: "token",
    scope: GEE_AUTH_SCOPE,
    redirect_uri: String(redirectUri).trim(),
    include_granted_scopes: "true",
    state: String(state)
  });
  return { url: `${GEE_AUTH_ENDPOINT}?${params.toString()}`, state: String(state) };
}

/** Extracts access_token / expires_in / state from a redirect callback URL hash. */
export function parseAuthFragment(url) {
  const hash = String(url).split("#")[1] || "";
  const params = new URLSearchParams(hash);
  const authError = params.get("error");
  if (authError) throw createGeeRestError(`Google 授权失败（${authError}）`, "AUTH_FAILED");
  const accessToken = params.get("access_token");
  if (!accessToken) throw createGeeRestError("Google 授权回调中缺少 access_token", "AUTH_FAILED");
  const expiresIn = Number(params.get("expires_in"));
  return {
    accessToken,
    expiresIn: Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn : 3600,
    state: params.get("state") || ""
  };
}

async function geeRestGet(token, path, { signal } = {}) {
  // Idempotent GET: moderate retries for throttling / flaky gateways. HTTP
  // 401 is never retried here; the caller re-authorizes exactly once. The
  // body is consumed inside the kernel so a stalled response cannot hang
  // past the timeout or an external abort.
  const consumed = await fetchWithPolicy(`${GEE_REST_BASE}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
    signal,
    timeoutMs: __timings.restTimeoutMs,
    retryable: true,
    maxRetries: GEE_REST_MAX_RETRIES,
    backoffMs: __timings.restBackoffMs,
    consume: async (response) => ({
      ok: response.ok,
      status: response.status,
      raw: await response.text()
    })
  });
  let data = null;
  if (consumed.raw) {
    try {
      data = JSON.parse(consumed.raw);
    } catch {
      data = null;
    }
  }
  if (!consumed.ok) {
    if (consumed.status === 401) {
      throw createGeeRestError("Earth Engine 授权已失效，需要重新授权", "UNAUTHORIZED", 401);
    }
    const detail = data?.error?.message || `HTTP ${consumed.status}`;
    throw createGeeRestError(`Earth Engine REST 请求失败：${detail}`, "GEE_REST_ERROR", consumed.status);
  }
  return data && typeof data === "object" ? data : {};
}

/**
 * Non-idempotent POST: never auto-retried (a billed/creating request must
 * not be duplicated by the kernel). Error wrapping mirrors geeRestGet; a
 * 409/ALREADY_EXISTS surfaces with code ALREADY_EXISTS so callers can offer
 * a rename path, and a 401 keeps code UNAUTHORIZED for the re-auth chain.
 */
export async function geeRestPost(token, path, body, { signal, timeoutMs } = {}) {
  const consumed = await fetchWithPolicy(`${GEE_REST_BASE}${path}`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${token}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body),
    signal,
    timeoutMs: Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : __timings.restTimeoutMs,
    retryable: false,
    consume: async (response) => ({
      ok: response.ok,
      status: response.status,
      raw: await response.text()
    })
  });
  let data = null;
  if (consumed.raw) {
    try {
      data = JSON.parse(consumed.raw);
    } catch {
      data = null;
    }
  }
  if (!consumed.ok) {
    if (consumed.status === 401) {
      throw createGeeRestError("Earth Engine 授权已失效，需要重新授权", "UNAUTHORIZED", 401);
    }
    const detail = data?.error?.message || `HTTP ${consumed.status}`;
    if (consumed.status === 409 || data?.error?.status === "ALREADY_EXISTS") {
      throw createGeeRestError(`Earth Engine 资产名已存在：${detail}`, "ALREADY_EXISTS", consumed.status);
    }
    throw createGeeRestError(`Earth Engine REST 请求失败：${detail}`, "GEE_REST_ERROR", consumed.status);
  }
  return data && typeof data === "object" ? data : {};
}

/**
 * Starts a table:import ingestion. The byte payload already lives in GCS
 * (gs:// references); this only registers the manifest and returns the LRO
 * operation object to be polled via pollOperation.
 */
export async function importTable(token, project, { assetName, uris, charset = "UTF-8" } = {}, { signal } = {}) {
  const name = String(assetName || "").trim();
  if (!name) throw createGeeRestError("缺少资产名称", "INVALID_ARGUMENT");
  const sourceUris = (Array.isArray(uris) ? uris : []).map((uri) => String(uri).trim()).filter(Boolean);
  if (!sourceUris.length) throw createGeeRestError("缺少可用的上传来源（gs:// 引用）", "INVALID_ARGUMENT");
  const body = {
    requestId: crypto.randomUUID(),
    tableManifest: {
      name: `projects/${String(project)}/assets/${name}`,
      sources: [{
        charset: String(charset || "UTF-8"),
        maxErrorMeters: 1,
        uris: sourceUris
      }]
    }
  };
  const path = `/projects/${encodeURIComponent(String(project))}/table:import`;
  return geeRestPost(token, path, body, { signal });
}

/**
 * Polls a long-running operation until done. Reuses the retryable GET path
 * for each poll; an AbortSignal interrupts both polls and the wait between
 * them. A finished operation carrying `error` rejects; exceeding `timeoutMs`
 * rejects with a readable Chinese timeout error.
 */
export async function pollOperation(token, operationName, {
  intervalMs = __timings.importPollIntervalMs,
  timeoutMs = __timings.importPollTimeoutMs,
  signal
} = {}) {
  const name = String(operationName || "").replace(/^\/+/, "");
  if (!name) throw createGeeRestError("缺少待轮询的操作名称", "INVALID_ARGUMENT");
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const operation = await geeRestGet(token, `/${name}`, { signal });
    if (operation.error) {
      const detail = operation.error.message || JSON.stringify(operation.error);
      throw createGeeRestError(`Earth Engine 导入任务失败：${detail}`, "OPERATION_FAILED", 0);
    }
    if (operation.done) return operation;
    if (Date.now() >= deadline) {
      throw createGeeRestError(`导入任务未在 ${Math.round(timeoutMs / 1000)} 秒内完成，请稍后在任务列表中查看结果`, "POLL_TIMEOUT", 0);
    }
    await waitInterruptible(intervalMs, signal);
  }
}

/** Normalizes a v1 asset, tolerating missing fields. */
export function normalizeAsset(asset) {
  const item = asset && typeof asset === "object" ? asset : {};
  const id = String(item.id || item.name || "");
  const segments = id.split("/").filter(Boolean);
  return {
    id,
    name: segments.length ? segments[segments.length - 1] : "（未知资产）",
    type: String(item.type || "UNKNOWN")
  };
}

/** Normalizes a v1 operation, tolerating missing metadata fields. */
export function normalizeOperation(operation) {
  const item = operation && typeof operation === "object" ? operation : {};
  const metadata = item.metadata && typeof item.metadata === "object" ? item.metadata : {};
  return {
    name: String(item.name || ""),
    state: String(metadata.state || (item.done ? "DONE" : "RUNNING")),
    summary: String(metadata.description || metadata.type || "").slice(0, 140)
  };
}

export async function listAssets(token, project, pageToken = "", { signal } = {}) {
  const params = new URLSearchParams({ pageSize: "100" });
  if (pageToken) params.set("pageToken", String(pageToken));
  const path = `/projects/${encodeURIComponent(String(project))}/assets?${params.toString()}`;
  const data = await geeRestGet(token, path, { signal });
  return {
    items: Array.isArray(data.assets) ? data.assets.map(normalizeAsset) : [],
    nextPageToken: typeof data.nextPageToken === "string" ? data.nextPageToken : ""
  };
}

export async function listTasks(token, project, pageToken = "", { signal } = {}) {
  const params = new URLSearchParams({ pageSize: "50" });
  if (pageToken) params.set("pageToken", String(pageToken));
  const path = `/projects/${encodeURIComponent(String(project))}/operations?${params.toString()}`;
  const data = await geeRestGet(token, path, { signal });
  return {
    items: Array.isArray(data.operations) ? data.operations.map(normalizeOperation) : [],
    nextPageToken: typeof data.nextPageToken === "string" ? data.nextPageToken : ""
  };
}

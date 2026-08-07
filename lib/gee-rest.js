// Minimal Google Earth Engine REST (v1) client used with the extension's own
// independent OAuth client. Pure logic only: chrome APIs stay in the service
// worker, so every function here is unit-testable in Node with a fetch mock.
// Web-page tokens are never reused; tokens come exclusively from a user-
// approved chrome.identity authorization flow.

import { fetchWithPolicy } from "./http.js";

export const GEE_AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
export const GEE_AUTH_SCOPE = "https://www.googleapis.com/auth/earthengine";
export const GEE_REST_BASE = "https://earthengine.googleapis.com/v1";
export const GEE_REST_MAX_RETRIES = 2;

// Mutable so Node tests can shorten retry backoff; production defaults stay
// conservative.
export const __timings = {
  restTimeoutMs: 20000,
  restBackoffMs: 1000
};

export function createGeeRestError(message, code = "GEE_REST_ERROR", status = 0) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  return error;
}

/** Builds the implicit-flow authorization URL for the extension's own client. */
export function buildAuthUrl(clientId, redirectUri) {
  if (!String(clientId || "").trim()) throw new Error("缺少 Google OAuth 客户端 ID");
  if (!String(redirectUri || "").trim()) throw new Error("缺少授权重定向 URI");
  const params = new URLSearchParams({
    client_id: String(clientId).trim(),
    response_type: "token",
    scope: GEE_AUTH_SCOPE,
    redirect_uri: String(redirectUri).trim(),
    include_granted_scopes: "true"
  });
  return `${GEE_AUTH_ENDPOINT}?${params.toString()}`;
}

/** Extracts access_token / expires_in from a redirect callback URL hash. */
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
    expiresIn: Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn : 3600
  };
}

async function geeRestGet(token, path, { signal } = {}) {
  // Idempotent GET: moderate retries for throttling / flaky gateways. HTTP
  // 401 is never retried here; the caller re-authorizes exactly once.
  const response = await fetchWithPolicy(`${GEE_REST_BASE}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
    signal,
    timeoutMs: __timings.restTimeoutMs,
    retryable: true,
    maxRetries: GEE_REST_MAX_RETRIES,
    backoffMs: __timings.restBackoffMs
  });
  const raw = await response.text();
  let data = null;
  if (raw) {
    try {
      data = JSON.parse(raw);
    } catch {
      data = null;
    }
  }
  if (!response.ok) {
    if (response.status === 401) {
      throw createGeeRestError("Earth Engine 授权已失效，需要重新授权", "UNAUTHORIZED", 401);
    }
    const detail = data?.error?.message || `HTTP ${response.status}`;
    throw createGeeRestError(`Earth Engine REST 请求失败：${detail}`, "GEE_REST_ERROR", response.status);
  }
  return data && typeof data === "object" ? data : {};
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

export async function listTasks(token, project, { signal } = {}) {
  const path = `/projects/${encodeURIComponent(String(project))}/operations?pageSize=50`;
  const data = await geeRestGet(token, path, { signal });
  return {
    items: Array.isArray(data.operations) ? data.operations.map(normalizeOperation) : []
  };
}

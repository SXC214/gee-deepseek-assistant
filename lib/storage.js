/**
 * Storage-quota governance for the sidepanel write paths. Writes that fail
 * with a clear quota error trigger a graded eviction chain: chat history is
 * halved first, then the code candidate is reduced to its metadata, and only
 * then is the write given up. Any other failure (transient storage errors,
 * invalidated extension contexts, serialization problems) is rethrown to the
 * caller untouched, because destructive eviction would turn a recoverable
 * hiccup into permanent data loss. Pure functions plus an injected storage
 * adapter keep the chain unit-testable without chrome.
 *
 * The six sidepanel storage keys and their read/write serialization live
 * here too, so every persisted shape has exactly one definition.
 */
import { sanitizeChatHistory } from "./chat.js";
import { sanitizeCodeCandidate } from "./candidate.js";
import { restorePlanSession, sanitizePlanSession } from "./plan.js";
import { sanitizeMessageQueue } from "./queue.js";

export const ACTIVE_PLAN_KEY = "activePlanV1";
export const CHAT_HISTORY_KEY = "chatHistoryV1";
export const CODE_CANDIDATE_KEY = "codeCandidateV1";
export const MESSAGE_QUEUE_KEY = "messageQueueV1";
export const SHP_ASSETS_KEY = "shpAssetsV1";

/** Reads and sanitizes the persisted chat transcript. */
export async function readChatHistory(storage) {
  const stored = await storage.get(CHAT_HISTORY_KEY);
  return sanitizeChatHistory(stored?.[CHAT_HISTORY_KEY]);
}

/**
 * Reads the persisted queue snapshot; tolerates both the legacy bare-array
 * shape and the current { items, paused } wrapper.
 */
export async function readMessageQueue(storage) {
  const stored = await storage.get(MESSAGE_QUEUE_KEY);
  const snapshot = stored?.[MESSAGE_QUEUE_KEY];
  const items = sanitizeMessageQueue(snapshot?.items ?? snapshot);
  return { items, paused: Boolean(snapshot?.paused && items.length) };
}

/** Serializes the queue; an empty queue is written by removal instead. */
export async function writeMessageQueueSnapshot(storage, { items, paused }) {
  const snapshot = { schemaVersion: 1, items: sanitizeMessageQueue(items), paused: Boolean(paused) };
  if (!snapshot.items.length) {
    await storage.remove(MESSAGE_QUEUE_KEY);
    return snapshot;
  }
  await storage.set({ [MESSAGE_QUEUE_KEY]: snapshot });
  return snapshot;
}

/** Reads and sanitizes the persisted code candidate (null when absent). */
export async function readCodeCandidate(storage) {
  const stored = await storage.get(CODE_CANDIDATE_KEY);
  return sanitizeCodeCandidate(stored?.[CODE_CANDIDATE_KEY]);
}

/** Sanitizes a candidate for persistence; null means it cannot be stored. */
export function serializeCodeCandidate(candidate) {
  return sanitizeCodeCandidate(candidate);
}

/** Reads and restores the persisted plan session (null when absent). */
export async function readActivePlan(storage) {
  const stored = await storage.get(ACTIVE_PLAN_KEY);
  return restorePlanSession(stored?.[ACTIVE_PLAN_KEY]);
}

/**
 * Serializes a plan session with its transient runtime state preserved:
 * the durable shape is sanitized against stableState, then the live state
 * is restored. Returns null when the session cannot be sanitized, and
 * removes the key when the session is absent.
 */
export async function serializeActivePlan(storage, plan) {
  if (!plan) {
    await storage.remove(ACTIVE_PLAN_KEY);
    return null;
  }
  const transientState = plan.state;
  const sanitized = sanitizePlanSession({ ...plan, state: plan.stableState });
  if (!sanitized) return null;
  return { ...sanitized, state: transientState };
}

function isValidBbox(bbox) {
  return Array.isArray(bbox) && bbox.length === 4
    && bbox.every((value) => typeof value === "number" && Number.isFinite(value));
}

/**
 * Sanitizes the persisted local shapefile asset list. Entries must look like
 * { id:"shp:<基名>", name, featureCount, bbox, properties, geoJson,
 * createdAt }; corrupted entries are dropped independently, the id is
 * rebuilt from the name when missing, and a malformed bbox degrades to null
 * instead of losing the whole asset. Writes that exceed the quota reject at
 * the caller, which handles them through isQuotaExceededError (the chat/
 * candidate eviction chain intentionally never touches these assets).
 */
export function sanitizeShpAssets(raw) {
  if (!Array.isArray(raw)) return [];
  const assets = [];
  const seen = new Set();
  for (const entry of raw) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const name = typeof entry.name === "string" ? entry.name.trim() : "";
    if (!name) continue;
    const geoJson = entry.geoJson;
    if (!geoJson || typeof geoJson !== "object" || Array.isArray(geoJson)) continue;
    if (geoJson.type !== "FeatureCollection" || !Array.isArray(geoJson.features)) continue;
    const id = typeof entry.id === "string" && entry.id.startsWith("shp:") ? entry.id : `shp:${name}`;
    if (seen.has(id)) continue;
    seen.add(id);
    assets.push({
      id,
      name,
      featureCount: Number.isInteger(entry.featureCount) && entry.featureCount >= 0
        ? entry.featureCount
        : geoJson.features.length,
      bbox: isValidBbox(entry.bbox) ? entry.bbox : null,
      properties: Array.isArray(entry.properties) ? entry.properties.filter((item) => typeof item === "string") : [],
      geoJson,
      createdAt: Number.isFinite(entry.createdAt) ? entry.createdAt : 0
    });
  }
  return assets;
}

/** Reads and sanitizes the persisted local shapefile assets. */
export async function readShpAssets(storage) {
  const stored = await storage.get(SHP_ASSETS_KEY);
  return sanitizeShpAssets(stored?.[SHP_ASSETS_KEY]);
}

/** Serializes the asset list; an empty list is written by removal instead. */
export async function writeShpAssets(storage, list) {
  const assets = sanitizeShpAssets(list);
  if (!assets.length) {
    await storage.remove(SHP_ASSETS_KEY);
    return assets;
  }
  await storage.set({ [SHP_ASSETS_KEY]: assets });
  return assets;
}

/** Keeps the newest half of a transcript; used to retry oversized writes. */
export function halveChatHistory(entries) {
  const list = Array.isArray(entries) ? entries : [];
  if (list.length <= 1) return list.slice();
  return list.slice(Math.floor(list.length / 2));
}

/**
 * Strips the large code bodies from a candidate so only its metadata
 * survives. The reduced record no longer passes sanitizeCodeCandidate, so a
 * later restore drops it gracefully instead of rendering broken code.
 */
export function candidateMetaOnly(candidate) {
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return null;
  return { ...candidate, code: "", baseCode: "" };
}

/**
 * True only for errors that unambiguously mean the storage quota was hit.
 * chrome.storage rejects quota-exceeded writes either as a DOMException named
 * "QuotaExceededError" or as an Error whose message names the budget that was
 * exhausted ("QUOTA_BYTES quota exceeded", "MAX_QUOTA_BYTES per-item quota
 * exceeded", ...); both shapes are covered. Everything else must propagate
 * untouched so transient/context/serialization failures never trigger the
 * destructive eviction chain.
 */
export function isQuotaExceededError(error) {
  if (!error || typeof error !== "object") return false;
  if (error.name === "QuotaExceededError") return true;
  const message = String(error.message || "").toUpperCase();
  return message.includes("QUOTA") || message.includes("MAX_QUOTA");
}

async function trySet(storage, key, value) {
  try {
    await storage.set({ [key]: value });
    return true;
  } catch (error) {
    if (!isQuotaExceededError(error)) throw error;
    return false;
  }
}

async function readStored(storage, key) {
  try {
    const stored = await storage.get(key);
    return stored ? stored[key] : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Writes targetValue under targetKey. On quota failure it retries while
 * evicting:
 * 1) halve the chat transcript repeatedly (the pending snapshot itself when
 *    the transcript is the write target),
 * 2) reduce the code candidate to metadata only, then retry the *last
 *    reduced* chat snapshot (not the original oversized one),
 * 3) give up.
 *
 * Returns { persisted, degraded, evictions, finalValues }:
 * - persisted: the intended targetValue ended up in storage;
 * - degraded: the code candidate was reduced to metadata (its code bodies are
 *   gone, so UIs must not claim the code card was saved);
 * - finalValues: the final stored value of every key this call touched, so
 *   callers can resync all affected in-memory state in one pass.
 */
export async function setWithQuotaEviction(storage, { targetKey, targetValue, chatKey, candidateKey }) {
  const evictions = [];
  const finalValues = {};
  const finish = (persisted, degraded) => ({ persisted, degraded, evictions, finalValues });

  if (await trySet(storage, targetKey, targetValue)) {
    finalValues[targetKey] = targetValue;
    return finish(true, false);
  }

  // Stage 1: halve the chat transcript until the target write fits.
  // lastReducedChat remembers the smallest snapshot attempted so stage 2 can
  // retry that reduced snapshot instead of the original oversized one.
  let lastReducedChat = null;
  if (targetKey === chatKey) {
    let snapshot = Array.isArray(targetValue) ? targetValue : [];
    while (snapshot.length > 1) {
      snapshot = halveChatHistory(snapshot);
      evictions.push("chat-history-halved");
      lastReducedChat = snapshot;
      if (await trySet(storage, chatKey, snapshot)) {
        finalValues[chatKey] = snapshot;
        return finish(true, false);
      }
    }
  } else {
    let stored = await readStored(storage, chatKey);
    stored = Array.isArray(stored) ? stored : [];
    while (stored.length > 1) {
      stored = halveChatHistory(stored);
      evictions.push("chat-history-halved");
      lastReducedChat = stored;
      if (!(await trySet(storage, chatKey, stored))) continue;
      finalValues[chatKey] = stored;
      if (await trySet(storage, targetKey, targetValue)) {
        finalValues[targetKey] = targetValue;
        return finish(true, false);
      }
    }
  }

  // Stage 2: degrade the code candidate to metadata only to free its space.
  const candidate = targetKey === candidateKey ? targetValue : await readStored(storage, candidateKey);
  const meta = candidateMetaOnly(candidate);
  if (!meta) return finish(false, false);

  evictions.push("candidate-meta-only");
  if (targetKey === candidateKey) {
    // The candidate itself could not fit: only its metadata survives, so the
    // intended write is reported as not persisted even though meta is stored.
    if (await trySet(storage, candidateKey, meta)) {
      finalValues[candidateKey] = meta;
      if (lastReducedChat) finalValues[chatKey] = lastReducedChat;
    }
    return finish(false, true);
  }

  if (await trySet(storage, candidateKey, meta)) {
    finalValues[candidateKey] = meta;
  }
  // Retry the last reduced snapshot when the chat transcript is the target;
  // the original oversized snapshot already failed above.
  const retryValue = targetKey === chatKey && lastReducedChat ? lastReducedChat : targetValue;
  if (await trySet(storage, targetKey, retryValue)) {
    finalValues[targetKey] = retryValue;
    return finish(true, true);
  }
  return finish(false, true);
}

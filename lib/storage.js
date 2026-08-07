/**
 * Storage-quota governance for the sidepanel write paths. Writes that fail
 * (quota or serialization errors) trigger a graded eviction chain:
 * chat history is halved first, then the code candidate is reduced to its
 * metadata, and only then is the write given up. Pure functions plus an
 * injected storage adapter keep the chain unit-testable without chrome.
 */

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

async function trySet(storage, key, value) {
  try {
    await storage.set({ [key]: value });
    return true;
  } catch {
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
 * Writes targetValue under targetKey. On failure it retries while evicting:
 * 1) halve the chat transcript repeatedly (the pending snapshot itself when
 *    the transcript is the write target),
 * 2) reduce the code candidate to metadata only,
 * 3) give up. Returns { persisted, evictions, finalValue } where finalValue
 * is the value that finally fit (or the reduced candidate), so callers can
 * resync their in-memory state.
 */
export async function setWithQuotaEviction(storage, { targetKey, targetValue, chatKey, candidateKey }) {
  const evictions = [];
  if (await trySet(storage, targetKey, targetValue)) {
    return { persisted: true, evictions, finalValue: targetValue };
  }

  // Stage 1: halve the chat transcript until the target write fits.
  if (targetKey === chatKey) {
    let snapshot = Array.isArray(targetValue) ? targetValue : [];
    while (snapshot.length > 1) {
      snapshot = halveChatHistory(snapshot);
      evictions.push("chat-history-halved");
      if (await trySet(storage, chatKey, snapshot)) {
        return { persisted: true, evictions, finalValue: snapshot };
      }
    }
  } else {
    let stored = await readStored(storage, chatKey);
    stored = Array.isArray(stored) ? stored : [];
    while (stored.length > 1) {
      stored = halveChatHistory(stored);
      evictions.push("chat-history-halved");
      if (!(await trySet(storage, chatKey, stored))) continue;
      if (await trySet(storage, targetKey, targetValue)) {
        return { persisted: true, evictions, finalValue: targetValue };
      }
    }
  }

  // Stage 2: degrade the code candidate to metadata only to free its space.
  const candidate = targetKey === candidateKey ? targetValue : await readStored(storage, candidateKey);
  const meta = candidateMetaOnly(candidate);
  if (meta) {
    evictions.push("candidate-meta-only");
    if (targetKey === candidateKey) {
      if (await trySet(storage, candidateKey, meta)) {
        return { persisted: true, evictions, finalValue: meta };
      }
    } else {
      // Best effort: the reduced record frees quota for the real target.
      await trySet(storage, candidateKey, meta);
      if (await trySet(storage, targetKey, targetValue)) {
        return { persisted: true, evictions, finalValue: targetValue };
      }
    }
  }

  return { persisted: false, evictions, finalValue: null };
}

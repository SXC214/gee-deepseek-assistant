const QUEUE_SCHEMA_VERSION = 1;
const MAX_QUEUE_ITEMS = 10;
const MAX_QUEUE_TEXT_LENGTH = 12_000;

export function createQueuedMessage({ id, text, planMode = false, createdAt = Date.now() } = {}) {
  const normalizedText = sanitizeQueuedText(text);
  if (!normalizedText) throw new TypeError("Queued message requires non-empty text.");
  return {
    schemaVersion: QUEUE_SCHEMA_VERSION,
    id: cleanId(id) || fallbackId(createdAt, normalizedText),
    text: normalizedText,
    planMode: Boolean(planMode),
    createdAt: normalizeTimestamp(createdAt)
  };
}

export function sanitizeMessageQueue(value) {
  const source = Array.isArray(value) ? value : [];
  const output = [];
  const seen = new Set();
  for (const item of source) {
    try {
      const queued = createQueuedMessage(item);
      if (seen.has(queued.id)) continue;
      seen.add(queued.id);
      output.push(queued);
    } catch {
      // Ignore damaged entries without discarding the rest of the queue.
    }
  }
  return output.slice(-MAX_QUEUE_ITEMS);
}

export function enqueueMessage(queue, item) {
  return sanitizeMessageQueue([...sanitizeMessageQueue(queue), createQueuedMessage(item)]);
}

export function removeQueuedMessage(queue, id) {
  return sanitizeMessageQueue(queue).filter((item) => item.id !== id);
}

export function prioritizeQueuedMessage(queue, id) {
  const items = sanitizeMessageQueue(queue);
  const selected = items.find((item) => item.id === id);
  if (!selected) return items;
  return [selected, ...items.filter((item) => item.id !== id)];
}

export function sanitizeQueuedText(value) {
  return String(value ?? "")
    .replace(/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/gi, "[已隐藏私钥]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/gi, "Bearer [已隐藏令牌]")
    .replace(/\bsk-[A-Za-z0-9_-]{16,}\b/g, "[已隐藏 API Key]")
    .replace(/\r\n?/g, "\n")
    .trim()
    .slice(0, MAX_QUEUE_TEXT_LENGTH);
}

function cleanId(value) {
  return typeof value === "string" ? value.trim().slice(0, 120) : "";
}

function normalizeTimestamp(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : Date.now();
}

function fallbackId(createdAt, text) {
  let hash = 2166136261;
  for (const character of text) {
    hash ^= character.codePointAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return `${normalizeTimestamp(createdAt)}-${(hash >>> 0).toString(36)}`;
}

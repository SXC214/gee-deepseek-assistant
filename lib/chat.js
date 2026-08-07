const CHAT_SCHEMA_VERSION = 1;
const MAX_CHAT_ENTRIES = 100;
const MAX_CHAT_TEXT_LENGTH = 20_000;
const ALLOWED_ROLES = new Set(["user", "assistant", "error"]);
const ALLOWED_PURPOSES = new Set(["direct", "source", "plan", "plan_action", "plan_generate"]);

/**
 * Creates the persisted, display-only form of a chat entry.
 * Reasoning text and editor context never pass through this module.
 */
export function createChatEntry({ id, role, text, purpose = "direct", createdAt = Date.now() } = {}) {
  const normalizedRole = ALLOWED_ROLES.has(role) ? role : "assistant";
  const normalizedText = sanitizeChatText(text);
  if (!normalizedText) throw new TypeError("Chat entry requires non-empty text.");

  return {
    schemaVersion: CHAT_SCHEMA_VERSION,
    id: cleanId(id) || fallbackId(createdAt, normalizedRole, normalizedText),
    role: normalizedRole,
    purpose: ALLOWED_PURPOSES.has(purpose) ? purpose : "direct",
    text: normalizedText,
    createdAt: normalizeTimestamp(createdAt)
  };
}

/** Returns a bounded, chronological and storage-safe chat transcript. */
export function sanitizeChatHistory(value) {
  const source = Array.isArray(value) ? value : [];
  const entries = [];
  const seen = new Set();

  for (const candidate of source) {
    if (!candidate || typeof candidate !== "object" || candidate.kind === "reasoning") continue;
    try {
      const entry = createChatEntry(candidate);
      if (seen.has(entry.id)) continue;
      seen.add(entry.id);
      entries.push(entry);
    } catch {
      // Corrupted or empty stored entries are ignored independently.
    }
  }

  entries.sort((left, right) => left.createdAt - right.createdAt);
  return entries.slice(-MAX_CHAT_ENTRIES);
}

/** Appends one entry without mutating the caller's transcript. */
export function appendChatEntry(history, entry) {
  return sanitizeChatHistory([...sanitizeChatHistory(history), createChatEntry(entry)]);
}

export function sanitizeChatText(value) {
  return redactSecrets(String(value ?? ""))
    .replace(/\r\n?/g, "\n")
    .trim()
    .slice(0, MAX_CHAT_TEXT_LENGTH);
}

function redactSecrets(value) {
  return value
    .replace(/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/gi, "[已隐藏私钥]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/gi, "Bearer [已隐藏令牌]")
    .replace(/\bsk-[A-Za-z0-9_-]{16,}\b/g, "[已隐藏 API Key]");
}

function cleanId(value) {
  return typeof value === "string" ? value.trim().slice(0, 120) : "";
}

function normalizeTimestamp(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : Date.now();
}

function fallbackId(createdAt, role, text) {
  const timestamp = normalizeTimestamp(createdAt);
  let hash = 2166136261;
  for (const char of `${role}:${text}`) {
    hash ^= char.codePointAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return `${timestamp}-${(hash >>> 0).toString(36)}`;
}

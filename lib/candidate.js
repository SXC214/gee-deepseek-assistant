const CANDIDATE_SCHEMA_VERSION = 1;
const MAX_CODE_LENGTH = 2_000_000;
const MAX_REVISION_LENGTH = 300;
const CANDIDATE_STATUSES = new Set(["ready", "applied"]);
const APPLICATION_MODES = new Set(["replace_all", "insert"]);

/** Creates the bounded local-storage representation of generated code. */
export function createCodeCandidate(value = {}) {
  const candidate = sanitizeCodeCandidate(value);
  if (!candidate) throw new TypeError("Code candidate requires valid generated code.");
  return candidate;
}

/** Drops unexpected fields from an untrusted chrome.storage value. */
export function sanitizeCodeCandidate(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const code = normalizeCode(value.code);
  if (!code.trim() || code.length > MAX_CODE_LENGTH) return null;
  const baseCode = normalizeCode(value.baseCode);

  return {
    schemaVersion: CANDIDATE_SCHEMA_VERSION,
    code,
    baseCode: baseCode.length <= MAX_CODE_LENGTH ? baseCode : "",
    baseRevision: cleanText(value.baseRevision, MAX_REVISION_LENGTH),
    tabId: positiveInteger(value.tabId),
    planRevision: nonNegativeIntegerOrNull(value.planRevision),
    status: CANDIDATE_STATUSES.has(value.status) ? value.status : "ready",
    applicationMode: APPLICATION_MODES.has(value.applicationMode) ? value.applicationMode : "",
    createdAt: normalizeTimestamp(value.createdAt),
    appliedAt: value.status === "applied" ? normalizeTimestamp(value.appliedAt) : null
  };
}

export function markCodeCandidateApplied(value, mode, appliedAt = Date.now()) {
  const candidate = createCodeCandidate(value);
  if (!APPLICATION_MODES.has(mode)) throw new TypeError("Unknown code application mode.");
  return {
    ...candidate,
    status: "applied",
    applicationMode: mode,
    appliedAt: normalizeTimestamp(appliedAt)
  };
}

function normalizeCode(value) {
  return typeof value === "string" ? value.replace(/\r\n?/g, "\n") : "";
}

function cleanText(value, limit) {
  return typeof value === "string" ? value.trim().slice(0, limit) : "";
}

function positiveInteger(value) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function nonNegativeIntegerOrNull(value) {
  if (value == null || value === "") return null;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : null;
}

function normalizeTimestamp(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : Date.now();
}

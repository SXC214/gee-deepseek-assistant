import { isReasoningPass } from "./reasoning-gate.js";

const REASONING_SCHEMA_VERSION = 1;
const MAX_TEXT = 2000;
const MAX_ITEMS = 40;
const OPEN_STATUSES = new Set(["open", "settled"]);

export function createReasoningSession({ conversationId = "", pass = "fast", prompt = "", now = Date.now() } = {}) {
  const createdAt = normalizeTimestamp(now);
  return {
    schemaVersion: REASONING_SCHEMA_VERSION,
    conversationId: cleanId(conversationId) || fallbackId(createdAt),
    pass: isReasoningPass(pass) ? pass : "fast",
    goal: {
      text: cleanText(prompt),
      doneCriteria: []
    },
    core: [],
    verified: [],
    open: [],
    next: {
      action: "classify_task",
      description: "确定当前任务需要的推理与验证强度"
    },
    failures: [],
    seamCount: 0,
    createdAt,
    updatedAt: createdAt
  };
}

export function sanitizeReasoningSession(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const goalText = cleanText(value.goal?.text || value.goal || "");
  const createdAt = normalizeTimestamp(value.createdAt);
  const session = {
    schemaVersion: REASONING_SCHEMA_VERSION,
    conversationId: cleanId(value.conversationId) || fallbackId(createdAt),
    pass: isReasoningPass(value.pass) ? value.pass : "fast",
    goal: {
      text: goalText,
      doneCriteria: cleanTextArray(value.goal?.doneCriteria)
    },
    core: sanitizeCore(value.core),
    verified: sanitizeVerified(value.verified),
    open: sanitizeOpen(value.open),
    next: sanitizeNext(value.next),
    failures: sanitizeFailures(value.failures),
    seamCount: nonNegativeInteger(value.seamCount),
    createdAt,
    updatedAt: normalizeTimestamp(value.updatedAt || createdAt)
  };
  if (!session.goal.text && !session.core.length && !session.verified.length && !session.open.length) return null;
  return session;
}

export function setReasoningPass(session, pass, now = Date.now()) {
  return updateSession(session, { pass: isReasoningPass(pass) ? pass : session?.pass }, now);
}

export function setReasoningGoal(session, text, doneCriteria = session?.goal?.doneCriteria, now = Date.now()) {
  return updateSession(session, {
    goal: { text: cleanText(text), doneCriteria: cleanTextArray(doneCriteria) }
  }, now);
}

export function setReasoningNext(session, action, description, now = Date.now()) {
  return updateSession(session, { next: sanitizeNext({ action, description }) }, now);
}

export function setCoreValue(session, key, value, { status = "asserted", evidenceRef = "" } = {}, now = Date.now()) {
  const normalized = sanitizeCoreEntry({ key, value, status, evidenceRef });
  if (!normalized) return sanitizeReasoningSession(session);
  const current = sanitizeReasoningSession(session) || createReasoningSession({ prompt: "", now });
  const core = current.core.filter((entry) => entry.key !== normalized.key);
  core.push(normalized);
  return updateSession(current, { core: core.slice(-MAX_ITEMS) }, now);
}

export function addVerifiedCheckpoint(session, checkpoint, now = Date.now()) {
  const normalized = sanitizeVerifiedEntry(checkpoint, session?.verified?.length || 0, now);
  if (!normalized) return sanitizeReasoningSession(session);
  const current = sanitizeReasoningSession(session) || createReasoningSession({ prompt: normalized.claim, now });
  const verified = current.verified.filter((entry) => entry.id !== normalized.id);
  verified.push(normalized);
  return updateSession(current, { verified: verified.slice(-MAX_ITEMS) }, now);
}

export function addOpenQuestion(session, question, now = Date.now()) {
  const normalized = sanitizeOpenEntry(question, session?.open?.length || 0);
  if (!normalized) return sanitizeReasoningSession(session);
  const current = sanitizeReasoningSession(session) || createReasoningSession({ prompt: normalized.question, now });
  const open = current.open.filter((entry) => entry.id !== normalized.id);
  open.push(normalized);
  return updateSession(current, { open: open.slice(-MAX_ITEMS) }, now);
}

export function recordReasoningFailure(session, failure, now = Date.now()) {
  const normalized = sanitizeFailureEntry(failure, now);
  if (!normalized) return sanitizeReasoningSession(session);
  const current = sanitizeReasoningSession(session) || createReasoningSession({ prompt: normalized.diagnosis, now });
  const matching = current.failures.find((entry) => entry.signature === normalized.signature);
  normalized.attempts = Math.max(normalized.attempts, (matching?.attempts || 0) + 1);
  const failures = current.failures.filter((entry) => entry.signature !== normalized.signature);
  failures.push(normalized);
  return updateSession(current, { failures: failures.slice(-MAX_ITEMS), pass: "loop" }, now);
}

export function advanceReasoningSeam(session, { action, description } = {}, now = Date.now()) {
  const current = sanitizeReasoningSession(session);
  if (!current) return null;
  return updateSession(current, {
    seamCount: current.seamCount + 1,
    next: action || description ? sanitizeNext({ action, description }) : current.next
  }, now);
}

/** Compact outer-register state for model/tool requests; never includes CoT. */
export function formatReasoningEnvelope(session) {
  const value = sanitizeReasoningSession(session);
  if (!value || value.pass === "fast") return "";
  return JSON.stringify({
    pass: value.pass,
    goal: value.goal,
    core: value.core,
    verified: value.verified.map(({ id, claim, verifier, evidenceRef, coverage }) => ({
      id, claim, verifier, evidenceRef, coverage
    })),
    open: value.open.filter((entry) => entry.status === "open"),
    next: value.next,
    failures: value.failures.map(({ signature, attempts, diagnosis, prohibitedRetry }) => ({
      signature, attempts, diagnosis, prohibitedRetry
    }))
  });
}

function updateSession(session, patch, now) {
  const current = sanitizeReasoningSession(session)
    || createReasoningSession({ prompt: patch?.goal?.text || "", pass: patch?.pass, now });
  return sanitizeReasoningSession({ ...current, ...patch, updatedAt: normalizeTimestamp(now) });
}

function sanitizeCore(value) {
  return asArray(value).map(sanitizeCoreEntry).filter(Boolean).slice(-MAX_ITEMS);
}

function sanitizeCoreEntry(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const key = cleanId(value.key);
  const entryValue = cleanText(value.value);
  if (!key || !entryValue) return null;
  return {
    key,
    value: entryValue,
    status: value.status === "verified" ? "verified" : "asserted",
    evidenceRef: cleanId(value.evidenceRef)
  };
}

function sanitizeVerified(value) {
  return asArray(value).map((entry, index) => sanitizeVerifiedEntry(entry, index)).filter(Boolean).slice(-MAX_ITEMS);
}

function sanitizeVerifiedEntry(value, index, now = Date.now()) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const claim = cleanText(value.claim);
  const verifier = cleanId(value.verifier);
  const coverage = cleanText(value.coverage);
  if (!claim || !verifier || !coverage) return null;
  return {
    id: cleanId(value.id) || `V${String(index + 1).padStart(3, "0")}`,
    claim,
    verifier,
    evidenceRef: cleanId(value.evidenceRef),
    coverage,
    createdAt: normalizeTimestamp(value.createdAt || now)
  };
}

function sanitizeOpen(value) {
  return asArray(value).map((entry, index) => sanitizeOpenEntry(entry, index)).filter(Boolean).slice(-MAX_ITEMS);
}

function sanitizeOpenEntry(value, index) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const question = cleanText(value.question);
  if (!question) return null;
  return {
    id: cleanId(value.id) || `O${String(index + 1).padStart(3, "0")}`,
    question,
    candidates: cleanTextArray(value.candidates),
    settleBy: cleanText(value.settleBy),
    status: OPEN_STATUSES.has(value.status) ? value.status : "open"
  };
}

function sanitizeFailures(value) {
  return asArray(value).map(sanitizeFailureEntry).filter(Boolean).slice(-MAX_ITEMS);
}

function sanitizeFailureEntry(value, now = Date.now()) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const signature = cleanText(value.signature);
  const diagnosis = cleanText(value.diagnosis);
  if (!signature || !diagnosis) return null;
  return {
    signature,
    attempts: Math.max(1, nonNegativeInteger(value.attempts)),
    diagnosis,
    prohibitedRetry: cleanText(value.prohibitedRetry),
    createdAt: normalizeTimestamp(value.createdAt || now)
  };
}

function sanitizeNext(value) {
  const action = cleanId(value?.action) || "await_user";
  const description = cleanText(value?.description) || "等待用户提供下一步指令";
  return { action, description };
}

function cleanTextArray(value) {
  return asArray(value).map(cleanText).filter(Boolean).slice(0, MAX_ITEMS);
}

function cleanText(value) {
  return String(value ?? "").replace(/\r\n?/g, "\n").trim().slice(0, MAX_TEXT);
}

function cleanId(value) {
  return typeof value === "string" ? value.trim().replace(/[^A-Za-z0-9_.:-]/g, "_").slice(0, 120) : "";
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function nonNegativeInteger(value) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : 0;
}

function normalizeTimestamp(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : Date.now();
}

function fallbackId(createdAt) {
  return `reasoning-${createdAt}`;
}

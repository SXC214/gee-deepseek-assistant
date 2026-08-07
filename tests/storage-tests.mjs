import assert from "node:assert/strict";
import {
  ACTIVE_PLAN_KEY,
  CHAT_HISTORY_KEY,
  CODE_CANDIDATE_KEY,
  MESSAGE_QUEUE_KEY,
  candidateMetaOnly,
  halveChatHistory,
  readActivePlan,
  readChatHistory,
  readCodeCandidate,
  readMessageQueue,
  serializeActivePlan,
  serializeCodeCandidate,
  setWithQuotaEviction,
  writeMessageQueueSnapshot
} from "../lib/storage.js";
import { createPlanSession, setPlanState } from "../lib/plan.js";

// halveChatHistory keeps the newest half and tolerates tiny or invalid input.
assert.deepEqual(halveChatHistory([1, 2, 3, 4]), [3, 4]);
assert.deepEqual(halveChatHistory([1, 2, 3]), [2, 3]);
assert.deepEqual(halveChatHistory([1]), [1]);
assert.deepEqual(halveChatHistory(null), []);

// candidateMetaOnly strips the large code bodies but keeps metadata fields.
assert.deepEqual(
  candidateMetaOnly({ schemaVersion: 1, code: "x".repeat(10), baseCode: "y", tabId: 3, status: "ready" }),
  { schemaVersion: 1, code: "", baseCode: "", tabId: 3, status: "ready" }
);
assert.equal(candidateMetaOnly(null), null);
assert.equal(candidateMetaOnly([1, 2]), null);

const CHAT = "chatHistoryV1";
const CANDIDATE = "codeCandidateV1";

function createFakeStorage(initial = {}) {
  const data = structuredClone(initial);
  const writes = [];
  let rejectSet = () => false;
  return {
    data,
    writes,
    setRejector(fn) {
      rejectSet = fn;
    },
    async get(key) {
      if (typeof key === "string") return { [key]: structuredClone(data[key]) };
      return Object.fromEntries(key.map((item) => [item, structuredClone(data[item])]));
    },
    async set(values) {
      writes.push(values);
      if (rejectSet(values, data)) {
        throw new DOMException("QUOTA_BYTES quota exceeded", "QuotaExceededError");
      }
      Object.assign(data, structuredClone(values));
    },
    async remove(key) {
      for (const item of Array.isArray(key) ? key : [key]) delete data[item];
    }
  };
}

// Healthy write: no eviction, exactly one storage write.
{
  const storage = createFakeStorage();
  const outcome = await setWithQuotaEviction(storage, {
    targetKey: CHAT,
    targetValue: [1, 2],
    chatKey: CHAT,
    candidateKey: CANDIDATE
  });
  assert.deepEqual(outcome, { persisted: true, evictions: [], finalValue: [1, 2] });
  assert.deepEqual(storage.data[CHAT], [1, 2]);
  assert.equal(storage.writes.length, 1);
}

// Oversized chat write: the pending snapshot is halved until it fits.
{
  const storage = createFakeStorage();
  storage.setRejector((values) => Array.isArray(values[CHAT]) && values[CHAT].length > 5);
  const snapshot = Array.from({ length: 20 }, (_unused, index) => index);
  const outcome = await setWithQuotaEviction(storage, {
    targetKey: CHAT,
    targetValue: snapshot,
    chatKey: CHAT,
    candidateKey: CANDIDATE
  });
  assert.equal(outcome.persisted, true);
  assert.deepEqual(outcome.finalValue, [15, 16, 17, 18, 19], "halving keeps the newest half");
  assert.deepEqual(storage.data[CHAT], [15, 16, 17, 18, 19]);
  assert.ok(outcome.evictions.length >= 2);
  assert.ok(outcome.evictions.every((eviction) => eviction === "chat-history-halved"));
}

// Candidate write: stored chat history is halved to free quota first.
{
  const storage = createFakeStorage({
    [CHAT]: Array.from({ length: 8 }, (_unused, index) => index),
    [CANDIDATE]: { code: "old", baseCode: "" }
  });
  storage.setRejector((values, current) => Boolean(values[CANDIDATE])
    && values[CANDIDATE].code !== ""
    && Array.isArray(current[CHAT])
    && current[CHAT].length > 2);
  const outcome = await setWithQuotaEviction(storage, {
    targetKey: CANDIDATE,
    targetValue: { code: "new", baseCode: "base" },
    chatKey: CHAT,
    candidateKey: CANDIDATE
  });
  assert.equal(outcome.persisted, true);
  assert.ok(outcome.evictions.includes("chat-history-halved"), "chat history was halved before the candidate gave up");
  assert.equal(outcome.evictions.includes("candidate-meta-only"), false);
  assert.deepEqual(storage.data[CANDIDATE], { code: "new", baseCode: "base" });
  assert.ok(storage.data[CHAT].length <= 4);
}

// Nothing fits: candidate degrades to metadata so the chat write succeeds.
{
  const storage = createFakeStorage({
    [CHAT]: [0],
    [CANDIDATE]: { code: "big", baseCode: "base" }
  });
  storage.setRejector((values, current) => {
    if (values[CANDIDATE] !== undefined) return values[CANDIDATE].code !== "";
    return current[CANDIDATE]?.code !== "";
  });
  const target = [{ id: "a" }, { id: "b" }, { id: "c" }];
  const outcome = await setWithQuotaEviction(storage, {
    targetKey: CHAT,
    targetValue: target,
    chatKey: CHAT,
    candidateKey: CANDIDATE
  });
  assert.equal(outcome.persisted, true);
  assert.ok(outcome.evictions.includes("candidate-meta-only"));
  assert.deepEqual(storage.data[CANDIDATE], { code: "", baseCode: "" }, "candidate kept metadata only");
  assert.deepEqual(storage.data[CHAT], target);
  assert.deepEqual(outcome.finalValue, target);
}

// Candidate target itself is oversized: it degrades to metadata in stage two.
{
  const storage = createFakeStorage();
  storage.setRejector((values) => values[CANDIDATE]?.code === "too-big");
  const outcome = await setWithQuotaEviction(storage, {
    targetKey: CANDIDATE,
    targetValue: { code: "too-big", baseCode: "b", tabId: 7 },
    chatKey: CHAT,
    candidateKey: CANDIDATE
  });
  assert.equal(outcome.persisted, true);
  assert.deepEqual(outcome.evictions, ["candidate-meta-only"]);
  assert.deepEqual(storage.data[CANDIDATE], { code: "", baseCode: "", tabId: 7 });
}

// Give up: every write fails, so nothing is persisted and callers notify.
{
  const storage = createFakeStorage({ [CHAT]: [1], [CANDIDATE]: { code: "x", baseCode: "" } });
  storage.setRejector(() => true);
  const outcome = await setWithQuotaEviction(storage, {
    targetKey: CHAT,
    targetValue: [1, 2, 3],
    chatKey: CHAT,
    candidateKey: CANDIDATE
  });
  assert.equal(outcome.persisted, false);
  assert.equal(outcome.finalValue, null);
  assert.ok(outcome.evictions.includes("chat-history-halved"));
  assert.ok(outcome.evictions.includes("candidate-meta-only"));
}

// Storage keys keep the exact names the sidepanel used before the merge.
assert.equal(CHAT_HISTORY_KEY, "chatHistoryV1");
assert.equal(CODE_CANDIDATE_KEY, "codeCandidateV1");
assert.equal(MESSAGE_QUEUE_KEY, "messageQueueV1");
assert.equal(ACTIVE_PLAN_KEY, "activePlanV1");

// readChatHistory sanitizes stored entries and drops corrupted ones.
{
  const storage = createFakeStorage({
    [CHAT_HISTORY_KEY]: [
      { id: "a", role: "user", text: "你好", purpose: "direct", createdAt: 1000 },
      { role: "assistant" },
      { id: "b", role: "assistant", text: "回答", createdAt: 2000 }
    ]
  });
  const history = await readChatHistory(storage);
  assert.equal(history.length, 2, "corrupted entry is dropped independently");
  assert.deepEqual(history.map((entry) => entry.id), ["a", "b"]);
  assert.deepEqual(history.map((entry) => entry.role), ["user", "assistant"]);
  assert.deepEqual(await readChatHistory(createFakeStorage()), []);
}

// readMessageQueue tolerates the snapshot wrapper and the legacy bare array.
{
  const item = { id: "q1", text: "队列消息", planMode: false, createdAt: 1000 };
  const wrapped = createFakeStorage({
    [MESSAGE_QUEUE_KEY]: { schemaVersion: 1, items: [item], paused: true }
  });
  const snapshot = await readMessageQueue(wrapped);
  assert.equal(snapshot.items.length, 1);
  assert.equal(snapshot.items[0].text, "队列消息");
  assert.equal(snapshot.paused, true);

  const legacy = await readMessageQueue(createFakeStorage({ [MESSAGE_QUEUE_KEY]: [item] }));
  assert.equal(legacy.items.length, 1, "legacy bare-array shape still restores");
  assert.equal(legacy.paused, false);

  const emptyPaused = await readMessageQueue(
    createFakeStorage({ [MESSAGE_QUEUE_KEY]: { items: [], paused: true } })
  );
  assert.deepEqual(emptyPaused, { items: [], paused: false }, "paused never survives an empty queue");

  assert.deepEqual(await readMessageQueue(createFakeStorage()), { items: [], paused: false });
}

// writeMessageQueueSnapshot sets non-empty snapshots and removes empty ones.
{
  const storage = createFakeStorage();
  const snapshot = await writeMessageQueueSnapshot(storage, {
    items: [{ id: "q1", text: "队列消息", planMode: true, createdAt: 5 }],
    paused: true
  });
  assert.equal(snapshot.schemaVersion, 1);
  assert.equal(snapshot.items.length, 1);
  assert.equal(snapshot.items[0].planMode, true);
  assert.equal(storage.data[MESSAGE_QUEUE_KEY].paused, true);

  await writeMessageQueueSnapshot(storage, { items: [], paused: true });
  assert.equal(MESSAGE_QUEUE_KEY in storage.data, false, "empty queue is written as removal");
}

// readCodeCandidate / serializeCodeCandidate round-trip a valid candidate.
{
  const storage = createFakeStorage({
    [CODE_CANDIDATE_KEY]: { code: "var a = 1;", baseCode: "" }
  });
  const restored = await readCodeCandidate(storage);
  assert.equal(restored.code, "var a = 1;");
  assert.equal(restored.status, "ready");
  assert.equal(await readCodeCandidate(createFakeStorage()), null);

  assert.equal(serializeCodeCandidate({ code: "" }), null, "empty code cannot be stored");
  assert.equal(serializeCodeCandidate({ code: "var b = 2;" }).code, "var b = 2;");
}

// readActivePlan / serializeActivePlan keep the transient runtime state.
{
  const plan = setPlanState(createPlanSession("分析 NDVI 时序"), "researching");
  assert.equal(plan.state, "researching");
  assert.equal(plan.stableState, "idle");

  const storage = createFakeStorage();
  const serialized = await serializeActivePlan(storage, plan);
  assert.equal(serialized.state, "researching", "live transient state is preserved");
  assert.equal(serialized.stableState, "idle");
  await storage.set({ [ACTIVE_PLAN_KEY]: serialized });

  const restored = await readActivePlan(storage);
  assert.equal(restored.originalRequest, "分析 NDVI 时序");
  assert.equal(restored.state, "idle", "restore falls back to the stable state");

  assert.equal(await serializeActivePlan(storage, null), null);
  assert.equal(ACTIVE_PLAN_KEY in storage.data, false, "absent plan is written as removal");

  assert.equal(await serializeActivePlan(createFakeStorage(), { originalRequest: "" }), null);
}

console.log("Storage eviction tests passed.");

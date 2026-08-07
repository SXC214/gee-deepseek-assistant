import assert from "node:assert/strict";
import { candidateMetaOnly, halveChatHistory, setWithQuotaEviction } from "../lib/storage.js";

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

console.log("Storage eviction tests passed.");

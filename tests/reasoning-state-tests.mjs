import assert from "node:assert/strict";
import {
  addOpenQuestion,
  addVerifiedCheckpoint,
  advanceReasoningSeam,
  createReasoningSession,
  formatReasoningEnvelope,
  recordReasoningFailure,
  sanitizeReasoningSession,
  setCoreValue,
  setReasoningNext,
  setReasoningPass
} from "../lib/reasoning-state.js";

let session = createReasoningSession({ conversationId: "c1", pass: "full", prompt: "生成 NDVI 脚本", now: 1000 });
session = setCoreValue(session, "dataset", "COPERNICUS/S2_SR_HARMONIZED", {
  status: "verified",
  evidenceRef: "source_1"
}, 1001);
session = addVerifiedCheckpoint(session, {
  claim: "数据集 ID 已由官方目录核验",
  verifier: "gee_catalog",
  evidenceRef: "source_1",
  coverage: "数据集身份"
}, 1002);
session = addOpenQuestion(session, {
  question: "采用月中值还是月最大值？",
  candidates: ["median", "max"],
  settleBy: "user_confirmation"
}, 1003);
session = setReasoningNext(session, "ask_user", "等待用户确认时间合成方式", 1004);
session = advanceReasoningSeam(session, {}, 1005);

assert.equal(session.pass, "full");
assert.equal(session.core[0].status, "verified");
assert.equal(session.verified[0].id, "V001");
assert.equal(session.open[0].id, "O001");
assert.equal(session.seamCount, 1);
assert.match(formatReasoningEnvelope(session), /gee_catalog/);

session = recordReasoningFailure(session, {
  signature: "Image.select did not match",
  diagnosis: "目标波段不存在",
  prohibitedRetry: "不要重复相同 select"
}, 1006);
session = recordReasoningFailure(session, {
  signature: "Image.select did not match",
  diagnosis: "目标波段不存在"
}, 1007);
assert.equal(session.pass, "loop");
assert.equal(session.failures[0].attempts, 2);

const restored = sanitizeReasoningSession(JSON.parse(JSON.stringify(session)));
assert.equal(restored.goal.text, "生成 NDVI 脚本");
assert.equal(restored.verified[0].coverage, "数据集身份");
assert.equal(setReasoningPass(restored, "bad").pass, "loop");
assert.equal(sanitizeReasoningSession({}), null);

const privateFields = JSON.stringify(restored);
assert.doesNotMatch(privateFields, /reasoning_content|tool_calls/i);

console.log("Reasoning state tests passed.");

import assert from "node:assert/strict";
import {
  appendChatEntry,
  createChatEntry,
  sanitizeChatHistory,
  sanitizeChatText
} from "../lib/chat.js";
import { alignConversationToUser } from "../lib/conversation.js";

const first = createChatEntry({
  id: "u1",
  role: "user",
  text: "计算 NDVI",
  purpose: "plan",
  createdAt: 10
});
const second = createChatEntry({
  id: "a1",
  role: "assistant",
  text: "请先确认研究区边界。",
  purpose: "plan",
  createdAt: 20
});
assert.deepEqual(appendChatEntry([first], second).map((entry) => entry.id), ["u1", "a1"]);
assert.equal(createChatEntry({ id: "s1", role: "assistant", text: "官方来源", purpose: "source" }).purpose, "source");

const restored = sanitizeChatHistory([
  second,
  { ...first, apiKey: "must not survive" },
  { id: "thinking", role: "assistant", kind: "reasoning", text: "private chain of thought", createdAt: 15 },
  { id: "empty", role: "assistant", text: "" }
]);
assert.deepEqual(restored.map((entry) => entry.id), ["u1", "a1"]);
assert.equal("apiKey" in restored[0], false);
assert.equal(restored.some((entry) => entry.id === "thinking"), false);

assert.equal(sanitizeChatText("Bearer abcdefghijklmnopqrstuvwxyz"), "Bearer [已隐藏令牌]");
assert.equal(sanitizeChatText("sk-abcdefghijklmnopqrstuvwxyz"), "[已隐藏 API Key]");
assert.throws(() => createChatEntry({ role: "user", text: "   " }), /non-empty/);

const bounded = sanitizeChatHistory(Array.from({ length: 105 }, (_, index) => ({
  id: `m${index}`,
  role: "assistant",
  text: String(index),
  createdAt: index + 1
})));
assert.equal(bounded.length, 100);
assert.equal(bounded[0].id, "m5");

// Entries without an explicit purpose default to "direct", which is what
// appendMessage relies on when persisting direct-mode turns.
assert.equal(createChatEntry({ id: "d0", role: "user", text: "你好" }).purpose, "direct");

// ---- Multi-turn context persistence: rebuild directConversation exactly the
// way sidepanel.js restoreChatHistory does (purpose filter + role filter +
// 12-turn window + alignConversationToUser).
function rebuildDirectConversation(history) {
  return alignConversationToUser(
    history
      .filter((entry) => entry.purpose === "direct" && ["user", "assistant"].includes(entry.role))
      .map((entry) => ({ role: entry.role, content: entry.text }))
      .slice(-12)
  );
}

const mixedHistory = sanitizeChatHistory([
  { id: "d-u1", role: "user", text: "解释 NDVI 的计算方式", purpose: "direct", createdAt: 1 },
  { id: "d-a1", role: "assistant", text: "NDVI = (NIR - Red) / (NIR + Red)。", purpose: "direct", createdAt: 2 },
  { id: "p-u1", role: "user", text: "规划一个多年 NDVI 分析", purpose: "plan", createdAt: 3 },
  { id: "s-a1", role: "assistant", text: "官方资料快照", purpose: "source", createdAt: 4 },
  { id: "pa-u1", role: "user", text: "确认方案 r1，请按此生成代码。", purpose: "plan_action", createdAt: 5 },
  { id: "e-1", role: "error", text: "请求失败：超时", purpose: "direct", createdAt: 6 },
  { id: "d-u2", role: "user", text: "继续解释波段选择", purpose: "direct", createdAt: 7 }
]);
assert.deepEqual(rebuildDirectConversation(mixedHistory), [
  { role: "user", content: "解释 NDVI 的计算方式" },
  { role: "assistant", content: "NDVI = (NIR - Red) / (NIR + Red)。" },
  { role: "user", content: "继续解释波段选择" }
], "only direct user/assistant turns rebuild the conversation; errors and plan entries stay out");

// Truncation windows can start with an assistant turn; alignment drops it
// so the rebuilt context always begins with a user message.
const assistantFirst = sanitizeChatHistory([
  { id: "d-a0", role: "assistant", text: "旧的助手回答", purpose: "direct", createdAt: 1 },
  { id: "d-u1b", role: "user", text: "新的问题", purpose: "direct", createdAt: 2 }
]);
assert.deepEqual(rebuildDirectConversation(assistantFirst), [
  { role: "user", content: "新的问题" }
]);

// The 12-turn window is applied before alignment, mirroring restoreChatHistory.
const longHistory = sanitizeChatHistory(Array.from({ length: 30 }, (_, index) => ({
  id: `d-${index}`,
  role: index % 2 === 0 ? "user" : "assistant",
  text: `第 ${index} 轮`,
  purpose: "direct",
  createdAt: index + 1
})));
const rebuiltLong = rebuildDirectConversation(longHistory);
assert.equal(rebuiltLong.length, 12);
assert.equal(rebuiltLong[0].role, "user", "windowed conversation still starts with a user turn");
assert.equal(rebuiltLong.at(-1).content, "第 29 轮");

console.log("Chat tests passed.");

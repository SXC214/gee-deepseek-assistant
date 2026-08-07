import assert from "node:assert/strict";
import {
  appendChatEntry,
  createChatEntry,
  sanitizeChatHistory,
  sanitizeChatText
} from "../lib/chat.js";

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

console.log("Chat tests passed.");

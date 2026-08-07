import assert from "node:assert/strict";
import {
  createQueuedMessage,
  enqueueMessage,
  prioritizeQueuedMessage,
  removeQueuedMessage,
  sanitizeMessageQueue
} from "../lib/queue.js";

const first = createQueuedMessage({ id: "first", text: "修复当前脚本", planMode: false, createdAt: 1 });
const second = createQueuedMessage({ id: "second", text: "再规划年度 NDVI", planMode: true, createdAt: 2 });
assert.equal(first.planMode, false);
assert.equal(second.planMode, true);

let queue = enqueueMessage([], first);
queue = enqueueMessage(queue, second);
assert.deepEqual(queue.map((item) => item.id), ["first", "second"]);
queue = prioritizeQueuedMessage(queue, "second");
assert.deepEqual(queue.map((item) => item.id), ["second", "first"]);
queue = sanitizeMessageQueue(queue);
assert.deepEqual(queue.map((item) => item.id), ["second", "first"], "saved queue order must preserve priority");
queue = removeQueuedMessage(queue, "second");
assert.deepEqual(queue.map((item) => item.id), ["first"]);

const sanitized = sanitizeMessageQueue([
  first,
  first,
  null,
  { id: "secret", text: "Bearer abcdefghijklmnopqrstuvwxyz", createdAt: 3 }
]);
assert.equal(sanitized.length, 2);
assert.match(sanitized[1].text, /已隐藏令牌/);
assert.throws(() => createQueuedMessage({ text: "   " }), /non-empty/);

const bounded = sanitizeMessageQueue(Array.from({ length: 14 }, (_, index) => ({
  id: `item-${index}`,
  text: `消息 ${index}`,
  createdAt: index + 1
})));
assert.equal(bounded.length, 10);
assert.equal(bounded[0].id, "item-4");

console.log("Message queue tests passed.");

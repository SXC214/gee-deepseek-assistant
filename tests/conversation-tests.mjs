import assert from "node:assert/strict";
import { alignConversationToUser } from "../lib/conversation.js";

// Already user-led conversations pass through with identical content.
const userLed = [
  { role: "user", content: "q1" },
  { role: "assistant", content: "a1" },
  { role: "user", content: "q2" }
];
assert.deepEqual(alignConversationToUser(userLed), userLed);

// Truncation landing on an assistant turn: leading non-user messages drop.
const assistantLed = [
  { role: "assistant", content: "a0" },
  { role: "user", content: "q1" },
  { role: "assistant", content: "a1" }
];
assert.deepEqual(alignConversationToUser(assistantLed), [
  { role: "user", content: "q1" },
  { role: "assistant", content: "a1" }
]);

// Several leading non-user messages (including unexpected roles) all drop.
assert.deepEqual(
  alignConversationToUser([
    { role: "system", content: "s" },
    { role: "assistant", content: "a" },
    { role: "assistant", content: "b" },
    { role: "user", content: "q" }
  ]),
  [{ role: "user", content: "q" }]
);

// All non-user input empties out instead of leaking a bad prefix.
assert.deepEqual(
  alignConversationToUser([
    { role: "assistant", content: "a" },
    { role: "assistant", content: "b" }
  ]),
  []
);

// Empty and malformed inputs are safe.
assert.deepEqual(alignConversationToUser([]), []);
assert.deepEqual(alignConversationToUser(null), []);
assert.deepEqual(alignConversationToUser([null, { role: "user", content: "q" }]), [{ role: "user", content: "q" }]);

// The input array is never mutated.
const original = [{ role: "assistant", content: "a" }, { role: "user", content: "q" }];
alignConversationToUser(original);
assert.equal(original.length, 2);
assert.equal(original[0].role, "assistant");

console.log("Conversation alignment tests passed.");

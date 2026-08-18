import assert from "node:assert/strict";
import { escalateReasoningPass, selectReasoningPass } from "../lib/reasoning-gate.js";

assert.equal(selectReasoningPass({ prompt: "解释 ee.Image.clip" }), "fast");
assert.equal(selectReasoningPass({ prompt: "生成完整 NDVI 脚本" }), "full");
assert.equal(selectReasoningPass({ planMode: true, prompt: "分析 NDVI" }), "loop");
assert.equal(selectReasoningPass({ requestedPass: "fast", planMode: true }), "fast", "explicit override wins");
assert.equal(selectReasoningPass({ previousFailures: [{ signature: "x" }] }), "loop");
assert.equal(selectReasoningPass({
  prompt: "帮我看看",
  editorState: {
    consoleText: "Layer error: Image.select did not match any bands",
    consoleRead: { status: "captured" }
  },
  contextOptions: { includeConsole: true }
}), "loop");
assert.equal(selectReasoningPass({
  prompt: "解释当前选区",
  editorState: { selection: "var x = 1;" },
  contextOptions: { includeSelection: true }
}), "full");
assert.equal(escalateReasoningPass("full", "fast"), "full");
assert.equal(escalateReasoningPass("fast", "loop"), "loop");

console.log("Reasoning gate tests passed.");

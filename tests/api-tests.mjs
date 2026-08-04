import assert from "node:assert/strict";
import { buildChatRequestBody, isOfficialDeepSeekV4, isValidReasoningEffort } from "../lib/api.js";

const messages = [{ role: "user", content: "计算 NDVI" }];
assert.equal(isOfficialDeepSeekV4("https://api.deepseek.com", "deepseek-v4-flash"), true);
assert.equal(isOfficialDeepSeekV4("https://api.deepseek.com/v1", "deepseek-v4-pro"), true);
assert.equal(isOfficialDeepSeekV4("https://proxy.example.com", "deepseek-v4-flash"), false);
assert.equal(isOfficialDeepSeekV4("https://api.deepseek.com", "deepseek-chat"), false);
assert.equal(isValidReasoningEffort("max"), true);
assert.equal(isValidReasoningEffort("low"), false);

const official = buildChatRequestBody({
  model: "deepseek-v4-flash",
  messages,
  settings: { baseUrl: "https://api.deepseek.com", thinkingEnabled: true, reasoningEffort: "max" },
  purpose: "plan_research"
});
assert.deepEqual(official.thinking, { type: "enabled" });
assert.equal(official.reasoning_effort, "max");
assert.equal(official.stream, true);
assert.deepEqual(official.stream_options, { include_usage: true });
assert.deepEqual(official.response_format, { type: "json_object" });

const disabled = buildChatRequestBody({
  model: "deepseek-v4-pro", messages,
  settings: { baseUrl: "https://api.deepseek.com", thinkingEnabled: false, reasoningEffort: "max" }
});
assert.deepEqual(disabled.thinking, { type: "disabled" });
assert.equal("reasoning_effort" in disabled, false);

const compatibility = buildChatRequestBody({
  model: "deepseek-v4-flash", messages,
  settings: { baseUrl: "https://my-openai-compatible.example/v1", thinkingEnabled: true, reasoningEffort: "max" },
  purpose: "plan_clarify", stream: true
});
assert.equal(compatibility.stream, false);
assert.equal("thinking" in compatibility, false);
assert.equal("reasoning_effort" in compatibility, false);
assert.equal("stream_options" in compatibility, false);
assert.equal("response_format" in compatibility, false);

console.log("API request tests passed.");

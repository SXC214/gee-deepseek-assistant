import assert from "node:assert/strict";
import {
  buildChatRequestBody,
  isOfficialDeepSeekV4,
  isOfficialDeepSeekV4Flash,
  isValidReasoningEffort,
  normalizeChatMessages
} from "../lib/api.js";

const messages = [{ role: "user", content: "计算 NDVI" }];
assert.equal(isOfficialDeepSeekV4("https://api.deepseek.com", "deepseek-v4-flash"), true);
assert.equal(isOfficialDeepSeekV4("https://api.deepseek.com/v1", "deepseek-v4-pro"), true);
assert.equal(isOfficialDeepSeekV4("https://proxy.example.com", "deepseek-v4-flash"), false);
assert.equal(isOfficialDeepSeekV4("https://api.deepseek.com", "deepseek-chat"), false);
assert.equal(isOfficialDeepSeekV4Flash("https://api.deepseek.com/v1", "deepseek-v4-flash"), true);
assert.equal(isOfficialDeepSeekV4Flash("https://api.deepseek.com", "deepseek-v4-pro"), false);
assert.equal(isOfficialDeepSeekV4Flash("https://proxy.example.com", "deepseek-v4-flash"), false);

// Suffixed model names keep streaming instead of silently downgrading.
assert.equal(isOfficialDeepSeekV4("https://api.deepseek.com", "deepseek-v4-flash-latest"), true);
assert.equal(isOfficialDeepSeekV4("https://api.deepseek.com", "deepseek-v4-pro-2026-01"), true);
assert.equal(isOfficialDeepSeekV4Flash("https://api.deepseek.com", "deepseek-v4-flash-latest"), true);
assert.equal(isOfficialDeepSeekV4Flash("https://api.deepseek.com", "deepseek-v4-pro-latest"), false);

// Unrelated model names must not match by prefix.
assert.equal(isOfficialDeepSeekV4("https://api.deepseek.com", "deepseek-v3"), false);
assert.equal(isOfficialDeepSeekV4("https://api.deepseek.com", "deepseek-v4"), false);
assert.equal(isOfficialDeepSeekV4("https://api.deepseek.com", "gpt-4o"), false);
assert.equal(isOfficialDeepSeekV4Flash("https://api.deepseek.com", "deepseek-v3-flash"), false);

// Look-alike names sharing a prefix are not V4 models unless a "-" separator
// introduces the suffix (m2).
assert.equal(isOfficialDeepSeekV4("https://api.deepseek.com", "deepseek-v4-flashback"), false);
assert.equal(isOfficialDeepSeekV4("https://api.deepseek.com", "deepseek-v4-flashback-latest"), false);
assert.equal(isOfficialDeepSeekV4("https://api.deepseek.com", "deepseek-v4-prototype"), false);
assert.equal(isOfficialDeepSeekV4Flash("https://api.deepseek.com", "deepseek-v4-flashback"), false);
assert.equal(isOfficialDeepSeekV4("https://api.deepseek.com", "deepseek-v4-flash-latest"), true);
assert.equal(isOfficialDeepSeekV4("https://api.deepseek.com", "deepseek-v4-pro-preview"), true);

// Misclassified look-alikes keep the plain compatibility request shape.
const flashback = buildChatRequestBody({
  model: "deepseek-v4-flashback", messages,
  settings: { baseUrl: "https://api.deepseek.com", thinkingEnabled: true },
  stream: true
});
assert.equal("thinking" in flashback, false, "flashback must not receive thinking fields");
assert.equal("reasoning_effort" in flashback, false);
assert.equal("stream_options" in flashback, false);
assert.equal(flashback.stream, false, "flashback stays on the non-streaming shape without opt-in");

const suffixed = buildChatRequestBody({
  model: "deepseek-v4-flash-latest", messages,
  settings: { baseUrl: "https://api.deepseek.com", thinkingEnabled: true }
});
assert.equal(suffixed.stream, true);
assert.deepEqual(suffixed.thinking, { type: "enabled" });

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

const structureRepair = buildChatRequestBody({
  model: "deepseek-v4-flash",
  messages,
  settings: { baseUrl: "https://api.deepseek.com", thinkingEnabled: true },
  purpose: "plan_research_structure_repair"
});
assert.deepEqual(
  structureRepair.response_format,
  { type: "json_object" },
  "the no-tools structure repair must retain strict JSON mode"
);

const toolMessages = normalizeChatMessages([
  { role: "user", content: "核验数据集" },
  {
    role: "assistant",
    content: "",
    reasoning_content: "需要查询目录",
    tool_calls: [{
      id: "call_1",
      type: "function",
      function: { name: "search_gee_datasets", arguments: '{"query":"Sentinel-2"}' }
    }]
  },
  { role: "tool", tool_call_id: "call_1", content: '{"ok":true}' }
]);
assert.equal(toolMessages[1].reasoning_content, "需要查询目录");
assert.equal(toolMessages[1].tool_calls[0].function.name, "search_gee_datasets");
assert.equal(toolMessages[2].tool_call_id, "call_1");

const officialTools = buildChatRequestBody({
  model: "deepseek-v4-flash",
  messages: toolMessages,
  settings: { baseUrl: "https://api.deepseek.com", thinkingEnabled: true },
  purpose: "plan_research",
  tools: [{
    type: "function",
    function: {
      name: "search_gee_datasets",
      description: "Search the official catalog",
      parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] }
    }
  }]
});
assert.equal(officialTools.tools[0].function.name, "search_gee_datasets");
assert.equal("tool_choice" in officialTools, false, "thinking tool requests rely on DeepSeek's default auto routing");
assert.equal("response_format" in officialTools, false, "tool turns rely on final schema validation");
const toolsDisabled = buildChatRequestBody({
  model: "deepseek-v4-flash",
  messages,
  settings: { baseUrl: "https://api.deepseek.com", thinkingEnabled: true },
  tools: officialTools.tools,
  toolChoice: "none"
});
assert.equal(toolsDisabled.tool_choice, "none", "an explicit tool opt-out remains serializable");
assert.throws(() => normalizeChatMessages([{ role: "tool", content: "x" }]), /tool_call_id/);

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
assert.equal("tools" in compatibility, false, "compatible endpoints do not receive resident DeepSeek tools");

// compatibleStreaming opt-in stays off by default: generic endpoints keep the
// non-streaming shape even when the caller requests streaming.
const compatFlagOff = buildChatRequestBody({
  model: "generic-model", messages,
  settings: { baseUrl: "https://my-openai-compatible.example/v1", compatibleStreaming: false },
  stream: true
});
assert.equal(compatFlagOff.stream, false);

// Enabled opt-in: only a plain stream flag, no DeepSeek-only fields.
const compatFlagOn = buildChatRequestBody({
  model: "generic-model", messages,
  settings: { baseUrl: "https://my-openai-compatible.example/v1", compatibleStreaming: true },
  stream: true
});
assert.equal(compatFlagOn.stream, true);
assert.equal("thinking" in compatFlagOn, false);
assert.equal("reasoning_effort" in compatFlagOn, false);
assert.equal("stream_options" in compatFlagOn, false);
assert.equal("response_format" in compatFlagOn, false);

// The opt-in only affects streaming callers; chat() keeps stream:false.
const compatFlagNonStream = buildChatRequestBody({
  model: "generic-model", messages,
  settings: { baseUrl: "https://my-openai-compatible.example/v1", compatibleStreaming: true },
  stream: false
});
assert.equal(compatFlagNonStream.stream, false);

// Official endpoints ignore the flag and keep the full V4 request shape.
const officialWithFlag = buildChatRequestBody({
  model: "deepseek-v4-flash", messages,
  settings: { baseUrl: "https://api.deepseek.com", thinkingEnabled: true, compatibleStreaming: true }
});
assert.equal(officialWithFlag.stream, true);
assert.deepEqual(officialWithFlag.thinking, { type: "enabled" });
assert.deepEqual(officialWithFlag.stream_options, { include_usage: true });

console.log("API request tests passed.");

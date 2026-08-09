import assert from "node:assert/strict";
import {
  CUSTOM_PROVIDER_ID,
  PROVIDER_PRESETS,
  findProviderPreset,
  matchProviderPreset
} from "../lib/provider-presets.js";

// Preset table contract: every provider exposes a non-empty label, an
// https OpenAI-compatible base URL and a non-empty default model name.
assert.ok(Array.isArray(PROVIDER_PRESETS) && PROVIDER_PRESETS.length >= 4, "at least four providers must be preset");
for (const preset of PROVIDER_PRESETS) {
  assert.match(preset.id, /^[a-z0-9-]+$/);
  assert.ok(preset.label.length > 0, `${preset.id} must have a label`);
  const expectedProtocol = preset.id === "local-qoder" ? "http:" : "https:";
  assert.ok(new URL(preset.baseUrl).protocol === expectedProtocol, `${preset.id} base URL must use the expected protocol`);
  assert.ok(!preset.baseUrl.endsWith("/"), `${preset.id} base URL must not end with a slash`);
  assert.ok(preset.defaultModel.length > 0, `${preset.id} must have a default model`);
}

// The three third-party providers requested for this release must exist.
const ids = PROVIDER_PRESETS.map((preset) => preset.id);
assert.ok(ids.includes("zhipu"), "zhipu preset must exist");
assert.ok(ids.includes("moonshot"), "moonshot preset must exist");
assert.ok(ids.includes("qwen"), "qwen preset must exist");

// Verified endpoints (per provider docs): Zhipu open.bigmodel.cn paas/v4,
// Moonshot api.moonshot.cn/v1, DashScope compatible-mode. Model names are
// the series' current general-purpose models, never a dated snapshot lock-in.
assert.equal(findProviderPreset("zhipu").baseUrl, "https://open.bigmodel.cn/api/paas/v4");
assert.equal(findProviderPreset("zhipu").defaultModel, "glm-5.2");
assert.equal(findProviderPreset("moonshot").baseUrl, "https://api.moonshot.cn/v1");
assert.equal(findProviderPreset("moonshot").defaultModel, "kimi-k3");
assert.equal(findProviderPreset("qwen").baseUrl, "https://dashscope.aliyuncs.com/compatible-mode/v1");
assert.equal(findProviderPreset("qwen").defaultModel, "qwen3.8-max");
assert.equal(findProviderPreset("deepseek").baseUrl, "https://api.deepseek.com");
assert.equal(findProviderPreset("deepseek").defaultModel, "deepseek-v4-flash");

assert.equal(findProviderPreset(CUSTOM_PROVIDER_ID), null);
assert.equal(findProviderPreset("nope"), null);

// Reverse matching: saved settings echo back the right preset; anything
// off-preset falls back to custom. Trailing slashes and extra whitespace
// never break matching.
assert.equal(matchProviderPreset("https://api.deepseek.com", "deepseek-v4-flash"), "deepseek");
assert.equal(matchProviderPreset("https://open.bigmodel.cn/api/paas/v4/", "glm-5.2"), "zhipu");
assert.equal(matchProviderPreset(" https://api.moonshot.cn/v1 ", " kimi-k3 "), "moonshot");
assert.equal(matchProviderPreset("https://dashscope.aliyuncs.com/compatible-mode/v1", "qwen3.8-max"), "qwen");
assert.equal(matchProviderPreset("https://api.deepseek.com", "deepseek-v4-pro"), null);
assert.equal(matchProviderPreset("https://my-proxy.example.com/v1", "anything"), null);
assert.equal(matchProviderPreset("", ""), null);

// Presets are pure fill-in data: they must stay frozen so a UI bug can
// never mutate the shared table.
assert.ok(Object.isFrozen(PROVIDER_PRESETS));
assert.ok(PROVIDER_PRESETS.every((preset) => Object.isFrozen(preset)));

console.log("Provider presets tests passed.");

import assert from "node:assert/strict";
import {
  buildCorsHeaders,
  buildPromptFromMessages,
  isAuthorized,
  loadConfig,
  parseStreamJsonLine,
  streamJsonLineToSse
} from "../tools/cli-bridge/server.mjs";

// buildPromptFromMessages：多角色按顺序分段拼接。
const prompt = buildPromptFromMessages([
  { role: "system", content: "你是 Earth Engine 专家。" },
  { role: "user", content: "什么是 NDVI？" },
  { role: "assistant", content: "NDVI 是归一化植被指数。" },
  { role: "user", content: "写一段 ee 代码。" }
]);
assert.match(prompt, /\[system\]\n你是 Earth Engine 专家。/);
assert.match(prompt, /\[user\]\n什么是 NDVI？/);
assert.match(prompt, /\[assistant\]\nNDVI 是归一化植被指数。/);
assert.ok(prompt.indexOf("[system]") < prompt.indexOf("[user]"));
assert.ok(prompt.indexOf("[assistant]") < prompt.lastIndexOf("[user]"));
assert.ok(prompt.includes("[user]\n写一段 ee 代码。"));

// buildPromptFromMessages：空数组与非法输入边界。
assert.equal(buildPromptFromMessages([]), "");
assert.equal(buildPromptFromMessages(null), "");
assert.equal(buildPromptFromMessages("nope"), "");
assert.equal(buildPromptFromMessages([{ role: "user", content: "   " }]), "");
assert.equal(buildPromptFromMessages([null, 42, { role: "user", content: "" }]), "");

// buildPromptFromMessages：多段 content 数组（OpenAI 多模态格式）只取 text 部分。
const multimodal = buildPromptFromMessages([
  { role: "user", content: [{ type: "text", text: "波段 B2" }, { type: "image_url" }, { type: "text", text: "波段 B3" }] }
]);
assert.match(multimodal, /\[user\]\n波段 B2\n波段 B3/);

// streamJsonLineToSse：逐字增量行 → OpenAI SSE 帧。
function ssePayload(sse) {
  return JSON.parse(sse.slice("data: ".length).trim());
}
const deltaLine = JSON.stringify({
  type: "stream_event",
  event: { type: "content_block_delta", delta: { type: "text_delta", text: "你好 " } }
});
const deltaSse = streamJsonLineToSse(deltaLine);
assert.match(deltaSse, /^data: /);
assert.match(deltaSse, /\n\n$/);
assert.equal(ssePayload(deltaSse).choices[0].delta.content, "你好 ");
assert.equal(ssePayload(deltaSse).choices[0].finish_reason, null);

// streamJsonLineToSse：整块 assistant 消息行与 result 行也能转出文本帧。
assert.equal(
  ssePayload(streamJsonLineToSse(JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "答案" }, { type: "tool_use", id: "x" }] } }))).choices[0].delta.content,
  "答案"
);
assert.equal(
  ssePayload(streamJsonLineToSse(JSON.stringify({ type: "result", subtype: "success", result: "最终结果" }))).choices[0].delta.content,
  "最终结果"
);

// streamJsonLineToSse：非文本行与坏行容错。
assert.equal(streamJsonLineToSse(JSON.stringify({ type: "system", subtype: "init", session_id: "abc" })), null);
assert.equal(streamJsonLineToSse(JSON.stringify({ type: "stream_event", event: { type: "message_stop" } })), null);
assert.equal(streamJsonLineToSse(JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id: "x" }] } })), null);
assert.equal(streamJsonLineToSse("这不是 JSON"), null);
assert.equal(streamJsonLineToSse(""), null);
assert.equal(streamJsonLineToSse("   "), null);
assert.equal(streamJsonLineToSse(null), null);
assert.equal(streamJsonLineToSse(123), null);

// parseStreamJsonLine：kind 区分，供服务端去重与聚合使用。
assert.equal(parseStreamJsonLine(deltaLine).kind, "delta");
assert.equal(parseStreamJsonLine(JSON.stringify({ type: "result", result: "done" })).kind, "result");
assert.equal(parseStreamJsonLine("{oops").kind, "invalid");
assert.equal(parseStreamJsonLine(JSON.stringify({ type: "system", subtype: "init" })).kind, "other");

// isAuthorized：配置了 Key 时必须 Bearer 精确匹配。
assert.equal(isAuthorized({ authorization: "Bearer sk-local-123" }, "sk-local-123"), true);
assert.equal(isAuthorized({ Authorization: "Bearer sk-local-123" }, "sk-local-123"), true);
assert.equal(isAuthorized({ authorization: "Bearer wrong-key" }, "sk-local-123"), false);
assert.equal(isAuthorized({ authorization: "Basic sk-local-123" }, "sk-local-123"), false);
assert.equal(isAuthorized({}, "sk-local-123"), false);
assert.equal(isAuthorized(null, "sk-local-123"), false);

// isAuthorized：无 Key 时默认拒绝；仅显式逃生门（BRIDGE_ALLOW_NO_AUTH=1）放行。
assert.equal(isAuthorized({ authorization: "Bearer anything" }, ""), false, "no key without escape hatch must reject");
assert.equal(isAuthorized({}, undefined), false);
assert.equal(isAuthorized({}, "", true), true, "escape hatch allows unauthenticated local trials");
assert.equal(isAuthorized({ authorization: "Bearer wrong" }, "sk-local-123", true), false, "a configured key still wins over the escape hatch");

// loadConfig：BRIDGE_ALLOW_NO_AUTH 仅接受字面量 "1"。
assert.equal(loadConfig({}).allowNoAuth, false);
assert.equal(loadConfig({ BRIDGE_ALLOW_NO_AUTH: "1" }).allowNoAuth, true);
assert.equal(loadConfig({ BRIDGE_ALLOW_NO_AUTH: "true" }).allowNoAuth, false);

// buildCorsHeaders：仅 chrome-extension:// 来源白名单回显 ACAO。
const extensionOrigin = "chrome-extension://abcdefghijklmnopabcdefghijklmnop";
assert.equal(buildCorsHeaders(extensionOrigin)["Access-Control-Allow-Origin"], extensionOrigin);
assert.equal(buildCorsHeaders("https://evil.example.com")["Access-Control-Allow-Origin"], undefined, "foreign origins get no ACAO header");
assert.equal(buildCorsHeaders(undefined)["Access-Control-Allow-Origin"], undefined);
assert.equal(buildCorsHeaders("chrome-extension://tooshort")["Access-Control-Allow-Origin"], undefined);
assert.equal(buildCorsHeaders("http://abcdefghijklmnopabcdefghijklmnop")["Access-Control-Allow-Origin"], undefined);
assert.equal(buildCorsHeaders(extensionOrigin).Vary, "Origin");
assert.equal(buildCorsHeaders(extensionOrigin)["Access-Control-Allow-Headers"], "Content-Type, Authorization");

console.log("CLI bridge tests passed.");

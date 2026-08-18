import assert from "node:assert/strict";
import {
  buildReadOnlyGeeTools,
  createToolCallSignature,
  executeReadOnlyGeeToolCall
} from "../lib/agent-tools.js";

const tools = buildReadOnlyGeeTools({
  datasetSearch: true,
  docsSearch: false,
  includeCode: true,
  includeSelection: false,
  includeConsole: true
});
assert.deepEqual(tools.map((tool) => tool.function.name), [
  "search_gee_datasets",
  "read_gee_editor",
  "read_gee_console"
]);
assert.equal(tools.some((tool) => /write|apply|run/i.test(tool.function.name)), false);

const sent = [];
const runtime = {
  async sendMessage(message) {
    sent.push(message);
    return {
      ok: true,
      context: "官方目录：COPERNICUS/S2_SR_HARMONIZED",
      sources: [{ type: "dataset", url: "https://developers.google.com/earth-engine/datasets/catalog/COPERNICUS_S2_SR_HARMONIZED" }],
      warnings: []
    };
  }
};
const searchCall = {
  id: "call_1",
  type: "function",
  function: { name: "search_gee_datasets", arguments: '{"query":"Sentinel-2 surface reflectance"}' }
};
const searched = await executeReadOnlyGeeToolCall(searchCall, {
  runtime,
  requestId: "req-1",
  contextOptions: { datasetSearch: true }
});
assert.equal(searched.ok, true);
assert.equal(searched.message.role, "tool");
assert.equal(searched.message.tool_call_id, "call_1");
assert.equal(searched.sources.length, 1);
assert.deepEqual(sent[0].payload, {
  requestId: "req-1",
  query: "Sentinel-2 surface reflectance",
  datasetSearch: true,
  docsSearch: false
});

const denied = await executeReadOnlyGeeToolCall(searchCall, {
  runtime,
  contextOptions: { datasetSearch: false }
});
assert.equal(denied.ok, false);
assert.match(JSON.parse(denied.message.content).error, /未由用户启用/);

const editor = await executeReadOnlyGeeToolCall({
  id: "call_2",
  function: { name: "read_gee_editor", arguments: "{}" }
}, {
  readEditor: async () => ({ title: "demo", code: "var x = 1;", selection: "x", consoleText: "secret-console" }),
  contextOptions: { includeCode: true, includeSelection: false, includeConsole: false }
});
const editorValue = JSON.parse(editor.message.content);
assert.equal(editorValue.code, "var x = 1;");
assert.equal(editorValue.selection, "");
assert.equal("consoleText" in editorValue, false, "editor tool must not leak console text");

const unknown = await executeReadOnlyGeeToolCall({
  id: "call_3",
  function: { name: "run_gee_script", arguments: "{}" }
}, { contextOptions: {} });
assert.equal(unknown.ok, false);
assert.match(JSON.parse(unknown.message.content).error, /不允许的工具/);

assert.equal(
  createToolCallSignature({ function: { name: "search_gee_docs", arguments: '{"b":2,"a":1}' } }),
  createToolCallSignature({ function: { name: "search_gee_docs", arguments: '{"a":1,"b":2}' } })
);

console.log("Read-only agent tool tests passed.");

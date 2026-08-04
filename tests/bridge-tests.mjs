import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

let code = "var x = 1;\nprint(x);";
let focused = false;
let selection = { start: { row: 0, column: 0 }, end: { row: 0, column: 0 } };

const session = {
  getValue: () => code,
  getTextRange: (range) => range.start.row === range.end.row && range.start.column === range.end.column ? "" : "var x = 1;",
  replace: (range, text) => {
    if (range.start.row === 0 && range.start.column === 0 && range.end.row === 1) code = text;
    else code += text;
  }
};

const editor = {
  session,
  getSelectionRange: () => selection,
  getCursorPosition: () => ({ row: 0, column: 0 }),
  insert: (text) => { code += text; },
  moveCursorTo: () => {},
  clearSelection: () => { selection = { start: { row: 0, column: 0 }, end: { row: 0, column: 0 } }; },
  focus: () => { focused = true; }
};

const listeners = new Map();
const posted = [];
const windowMock = {
  addEventListener(type, handler) { listeners.set(type, handler); },
  postMessage(message) { posted.push(message); }
};
const documentMock = {
  title: "Mock Script - Earth Engine Code Editor",
  querySelector(selector) {
    return selector === ".ace_editor" ? { env: { editor } } : null;
  }
};

const context = vm.createContext({
  window: windowMock,
  document: documentMock,
  setTimeout,
  clearTimeout,
  Promise,
  Math,
  Date,
  String,
  Error
});
vm.runInContext(fs.readFileSync(new URL("../page-bridge.js", import.meta.url), "utf8"), context);

async function request(action, payload = {}) {
  posted.length = 0;
  await listeners.get("message")({
    source: windowMock,
    data: { channel: "gee-ai-assistant", type: "GEE_AI_BRIDGE_REQUEST", id: "test", action, payload }
  });
  return posted.at(-1);
}

const state = await request("GET_STATE");
assert.equal(state.ok, true);
assert.equal(state.result.code, code);
assert.match(state.result.revision, /^[0-9a-f]{8}$/);

const stale = await request("APPLY_CODE", { code: "bad", mode: "replace_all", expectedRevision: "deadbeef" });
assert.equal(stale.ok, false);
assert.match(stale.error, /已经发生变化/);

const applied = await request("APPLY_CODE", {
  code: "var y = 2;\nprint(y);",
  mode: "replace_all",
  expectedRevision: state.result.revision
});
assert.equal(applied.ok, true);
assert.equal(code, "var y = 2;\nprint(y);");
assert.equal(focused, true);

console.log("Bridge tests passed.");

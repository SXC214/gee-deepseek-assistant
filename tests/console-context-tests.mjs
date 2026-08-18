import assert from "node:assert/strict";
import {
  createConsoleContextSection,
  createConsoleDiagnostic,
  getConsoleUiState,
  isNewConsoleDiagnostic,
  normalizeConsoleRead
} from "../lib/console.js";

const screenshotError = "Layer error: Image.select: Band pattern 'elevation' did not match any bands. Available bands: [DEM, EDM, FLM, HEM, WBM]";

assert.deepEqual(
  normalizeConsoleRead(screenshotError, { status: "empty", source: "legacy_selector", reason: null }),
  { status: "captured", source: "legacy_selector", reason: null }
);
assert.deepEqual(
  normalizeConsoleRead("", { status: "empty", source: "aria_tabpanel", reason: null }),
  { status: "empty", source: "aria_tabpanel", reason: null }
);
assert.deepEqual(
  normalizeConsoleRead("", null),
  { status: "unavailable", source: null, reason: "container_not_found" }
);

const capturedContext = createConsoleContextSection({
  consoleText: screenshotError,
  consoleRead: { status: "captured", source: "aria_tabpanel", reason: null }
}, true);
assert.match(capturedContext, /Band pattern 'elevation'/);
assert.match(capturedContext, /\[DEM, EDM, FLM, HEM, WBM\]/);
assert.match(capturedContext, /```text/);

assert.equal(
  createConsoleContextSection({ consoleText: "", consoleRead: { status: "empty" } }, true),
  "Earth Engine Console 状态：已读取，当前无输出。"
);
const unavailableContext = createConsoleContextSection({
  consoleText: "",
  consoleRead: { status: "unavailable", reason: "container_not_found" }
}, true);
assert.match(unavailableContext, /未读取到页面控制台/);
assert.match(unavailableContext, /禁止推测、虚构/);
assert.match(unavailableContext, /粘贴错误原文/);
assert.equal(createConsoleContextSection({ consoleText: screenshotError }, false), "");

assert.deepEqual(getConsoleUiState(false, null, true), {
  state: "idle",
  label: "Console",
  title: "未包含 Earth Engine Console 上下文"
});
assert.equal(getConsoleUiState(true, { status: "captured" }, true).label, "Console · 已读取");
assert.equal(getConsoleUiState(true, { status: "empty" }, true).label, "Console · 无输出");
const unavailableView = getConsoleUiState(true, { status: "unavailable", reason: "read_failed" }, true);
assert.equal(unavailableView.label, "Console · 未读取");
assert.match(unavailableView.title, /读取失败/);
assert.equal(getConsoleUiState(true, null, false).label, "Console");

const diagnostic = createConsoleDiagnostic(screenshotError, {
  status: "captured",
  source: "semantic_fallback"
});
assert.match(diagnostic.signature, /^gee-console:[0-9a-f]{8}$/);
assert.equal(diagnostic.excerpt, screenshotError);
assert.equal(createConsoleDiagnostic("Number: 42", { status: "captured" }), null);
assert.equal(isNewConsoleDiagnostic(null, diagnostic), true);
assert.equal(isNewConsoleDiagnostic(diagnostic, { ...diagnostic, capturedAt: Date.now() + 1 }), false);
assert.equal(isNewConsoleDiagnostic(diagnostic, { ...diagnostic, signature: "gee-console:different" }), true);

console.log("Console context tests passed.");

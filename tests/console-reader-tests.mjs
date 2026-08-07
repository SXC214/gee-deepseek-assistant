import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const source = fs.readFileSync(new URL("../content-script.js", import.meta.url), "utf8");

class FakeElement {
  constructor({ text = "", innerText = text, attributes = {}, tagName = "DIV", hidden = false, children = [], shadowRoot = null, selectors = {} } = {}) {
    this._innerText = innerText;
    this._textContent = text;
    this.attributes = attributes;
    this.tagName = tagName;
    this.hidden = hidden;
    this.children = children;
    this.shadowRoot = shadowRoot;
    this.selectors = selectors;
    this.parentElement = null;
    for (const child of children) child.parentElement = this;
  }

  get innerText() { return this._innerText; }
  get textContent() { return this._textContent; }
  getAttribute(name) { return this.attributes[name] ?? null; }
  checkVisibility() { return !this.hidden; }
  querySelectorAll(selector) { return this.selectors[selector] || []; }
}

class FakeRoot {
  constructor({ text = "", selectors = {} } = {}) {
    this.textContent = text;
    this.innerText = "";
    this.selectors = selectors;
  }

  querySelectorAll(selector) { return this.selectors[selector] || []; }
}

function throwingElement() {
  const element = new FakeElement();
  Object.defineProperty(element, "innerText", { get() { throw new Error("detached node"); } });
  Object.defineProperty(element, "textContent", { get() { throw new Error("detached node"); } });
  return element;
}

function createHarness({ selectors = {}, ids = {} } = {}) {
  let messageHandler;
  const documentMock = {
    querySelectorAll(selector) { return selectors[selector] || []; },
    getElementById(id) { return ids[id] || null; }
  };
  const windowMock = { addEventListener() {}, postMessage() {} };
  const chromeMock = {
    runtime: {
      onMessage: { addListener(handler) { messageHandler = handler; } }
    }
  };
  const context = vm.createContext({
    window: windowMock,
    document: documentMock,
    chrome: chromeMock,
    crypto: { randomUUID: () => "test-id" },
    setTimeout,
    clearTimeout,
    Promise,
    String,
    Error,
    Set
  });
  vm.runInContext(source, context);
  return async function readConsole() {
    let response;
    messageHandler({ type: "EDITOR_GET_CONSOLE" }, {}, (value) => { response = value; });
    await Promise.resolve();
    return structuredClone(response);
  };
}

const screenshotError = "Layer error: Image.select: Band pattern 'elevation' did not match any bands. Available bands: [DEM, EDM, FLM, HEM, WBM]";

{
  const label = new FakeElement({ text: "Number:" });
  const value = new FakeElement({ text: "42" });
  const printed = new FakeElement({
    text: "JSONNumber:42",
    tagName: "EE-CONSOLE-LOG",
    selectors: { ".trivial": [label, value] }
  });
  const error = new FakeElement({ text: screenshotError, tagName: "EE-CONSOLE-LOG" });
  const eeConsole = new FakeElement({
    tagName: "EE-CONSOLE",
    selectors: { "ee-console-log": [printed, error] }
  });
  const response = await createHarness({ selectors: { "ee-console": [eeConsole] } })();
  assert.equal(response.consoleRead.status, "captured");
  assert.equal(response.consoleRead.source, "semantic_fallback");
  assert.match(response.consoleText, /^Number: 42/m);
  assert.doesNotMatch(response.consoleText, /Number:\s*\nNumber:/);
  assert.match(response.consoleText, /Band pattern 'elevation'/);
  assert.doesNotMatch(response.consoleText, /^JSON/m);
}

{
  const log = new FakeElement({ text: screenshotError, tagName: "EE-CONSOLE-LOG" });
  const eeConsole = new FakeElement({
    tagName: "EE-CONSOLE",
    selectors: { "ee-console-log": [log] }
  });
  const shadowRoot = new FakeRoot({ selectors: { "ee-console": [eeConsole] } });
  const host = new FakeElement({ tagName: "EE-TAB", shadowRoot });
  const response = await createHarness({ selectors: { "*": [host] } })();
  assert.equal(response.consoleRead.status, "captured");
  assert.equal(response.consoleRead.source, "semantic_fallback");
  assert.match(response.consoleText, /\[DEM, EDM, FLM, HEM, WBM\]/);
}

{
  const eeConsole = new FakeElement({ tagName: "EE-CONSOLE" });
  const response = await createHarness({ selectors: { "ee-console": [eeConsole] } })();
  assert.equal(response.consoleRead.status, "empty");
  assert.equal(response.consoleRead.source, "semantic_fallback");
}

{
  const repeatedA = new FakeElement({ text: "Repeated output", tagName: "EE-CONSOLE-LOG" });
  const repeatedB = new FakeElement({ text: "Repeated output", tagName: "EE-CONSOLE-LOG" });
  const summary = new FakeElement({ text: "Error", tagName: "EE-CONSOLE-LOG" });
  const details = new FakeElement({ text: "Error details remain visible", tagName: "EE-CONSOLE-LOG" });
  const eeConsole = new FakeElement({
    tagName: "EE-CONSOLE",
    selectors: { "ee-console-log": [repeatedA, repeatedB, summary, details] }
  });
  const response = await createHarness({ selectors: { "ee-console": [eeConsole] } })();
  assert.equal(response.consoleText, [
    "Repeated output",
    "Repeated output",
    "Error",
    "Error details remain visible"
  ].join("\n\n"));
}

{
  const summaryConsole = new FakeElement({
    tagName: "EE-CONSOLE",
    selectors: { "ee-console-log": [new FakeElement({ text: "Error", tagName: "EE-CONSOLE-LOG" })] }
  });
  const detailConsole = new FakeElement({
    tagName: "EE-CONSOLE",
    selectors: { "ee-console-log": [new FakeElement({ text: "Error details from another console", tagName: "EE-CONSOLE-LOG" })] }
  });
  const response = await createHarness({ selectors: { "ee-console": [summaryConsole, detailConsole] } })();
  assert.equal(response.consoleText, "Error\n\nError details from another console");
}

{
  const log = new FakeElement({ text: "Layer error", tagName: "EE-CONSOLE-LOG" });
  const consoleShadow = new FakeRoot({
    selectors: { "ee-console-log": [log], "*": [log] }
  });
  const eeConsole = new FakeElement({ tagName: "EE-CONSOLE", shadowRoot: consoleShadow });
  const response = await createHarness({ selectors: { "ee-console": [eeConsole] } })();
  assert.equal(response.consoleText, "Layer error");
}

{
  const label = new FakeElement({ text: "Result:" });
  const value = new FakeElement({ text: "Dictionary" });
  const logShadow = new FakeRoot({ text: "Result: Dictionary\nmean: 0.42\ncount: 18" });
  const log = new FakeElement({
    text: "JSONResult:Dictionary",
    tagName: "EE-CONSOLE-LOG",
    shadowRoot: logShadow,
    selectors: { ".trivial": [label, value] }
  });
  const eeConsole = new FakeElement({
    tagName: "EE-CONSOLE",
    selectors: { "ee-console-log": [log] }
  });
  const response = await createHarness({ selectors: { "ee-console": [eeConsole] } })();
  assert.match(response.consoleText, /Result: Dictionary/);
  assert.match(response.consoleText, /mean: 0\.42/);
  assert.match(response.consoleText, /count: 18/);
}

{
  const element = new FakeElement({ text: `Console\nTasks\nAsk\nUse print(...) to write to this console.\n${screenshotError}\nTroubleshoot` });
  const response = await createHarness({ selectors: { ".console-entries": [element] } })();
  assert.equal(response.consoleRead.status, "captured");
  assert.equal(response.consoleRead.source, "legacy_selector");
  assert.match(response.consoleText, /Band pattern 'elevation'/);
  assert.match(response.consoleText, /\[DEM, EDM, FLM, HEM, WBM\]/);
  assert.doesNotMatch(response.consoleText, /Use print|Troubleshoot|^Console$/m);
}

{
  const tab = new FakeElement({ text: "Console", attributes: { "aria-controls": "console-panel" }, tagName: "BUTTON" });
  const panel = new FakeElement({ text: screenshotError, hidden: true, innerText: "" });
  const response = await createHarness({
    selectors: { "[aria-controls]": [tab] },
    ids: { "console-panel": panel }
  })();
  assert.equal(response.consoleRead.status, "captured");
  assert.equal(response.consoleRead.source, "aria_tabpanel");
  assert.equal(response.consoleText, screenshotError);
}

{
  const label = new FakeElement({ text: "Console", attributes: { id: "console-tab" } });
  const panel = new FakeElement({ text: screenshotError, attributes: { "aria-labelledby": "console-tab" } });
  const response = await createHarness({
    selectors: { '[role="tabpanel"]': [panel] },
    ids: { "console-tab": label }
  })();
  assert.equal(response.consoleRead.source, "aria_tabpanel");
}

{
  const semantic = new FakeElement({ text: screenshotError, attributes: { id: "output-console" } });
  const response = await createHarness({
    selectors: { '[class*="console" i],[id*="console" i]': [semantic] }
  })();
  assert.equal(response.consoleRead.status, "captured");
  assert.equal(response.consoleRead.source, "semantic_fallback");
}

{
  const errorDiv = new FakeElement({ text: screenshotError });
  const shadowRoot = new FakeRoot({ text: screenshotError, selectors: { div: [errorDiv], "*": [errorDiv] } });
  const consoleTab = new FakeElement({ tagName: "EE-TAB", shadowRoot });
  const exactPath = "body > ee-app-context > div > div:nth-of-type(2) > div:nth-of-type(1) > div > div:nth-of-type(2) > div > ee-tab-panel > ee-tab:nth-of-type(2)";
  const response = await createHarness({ selectors: { [exactPath]: [consoleTab] } })();
  assert.equal(response.consoleRead.status, "captured");
  assert.equal(response.consoleRead.source, "semantic_fallback");
  assert.match(response.consoleText, /Band pattern 'elevation'/);
}

// The loose hardcoded ee-tab path works on its own as the secondary probe.
{
  const errorDiv = new FakeElement({ text: screenshotError });
  const shadowRoot = new FakeRoot({ text: screenshotError, selectors: { div: [errorDiv], "*": [errorDiv] } });
  const consoleTab = new FakeElement({ tagName: "EE-TAB", shadowRoot });
  const response = await createHarness({
    selectors: { "ee-app-context ee-tab-panel > ee-tab:nth-of-type(2)": [consoleTab] }
  })();
  assert.equal(response.consoleRead.status, "captured");
  assert.equal(response.consoleRead.source, "semantic_fallback");
  assert.match(response.consoleText, /Band pattern 'elevation'/);
}

// Strategy priority: `.console-entries` wins over the hardcoded path.
{
  const exactPath = "body > ee-app-context > div > div:nth-of-type(2) > div:nth-of-type(1) > div > div:nth-of-type(2) > div > ee-tab-panel > ee-tab:nth-of-type(2)";
  const legacyElement = new FakeElement({ text: "primary legacy capture" });
  const hardcodedTab = new FakeElement({ tagName: "EE-TAB", text: "hardcoded content" });
  const response = await createHarness({
    selectors: {
      ".console-entries": [legacyElement],
      [exactPath]: [hardcodedTab]
    }
  })();
  assert.equal(response.consoleRead.source, "legacy_selector");
  assert.equal(response.consoleText, "primary legacy capture");
}

// Strategy priority: the hardcoded path beats aria probing.
{
  const exactPath = "body > ee-app-context > div > div:nth-of-type(2) > div:nth-of-type(1) > div > div:nth-of-type(2) > div > ee-tab-panel > ee-tab:nth-of-type(2)";
  const errorDiv = new FakeElement({ text: screenshotError });
  const shadowRoot = new FakeRoot({ text: screenshotError, selectors: { div: [errorDiv], "*": [errorDiv] } });
  const consoleTab = new FakeElement({ tagName: "EE-TAB", shadowRoot });
  const ariaTab = new FakeElement({ text: "Console", attributes: { "aria-controls": "console-panel" }, tagName: "BUTTON" });
  const ariaPanel = new FakeElement({ text: "aria panel text" });
  const response = await createHarness({
    selectors: {
      [exactPath]: [consoleTab],
      "[aria-controls]": [ariaTab]
    },
    ids: { "console-panel": ariaPanel }
  })();
  assert.equal(response.consoleRead.source, "semantic_fallback");
  assert.match(response.consoleText, /Band pattern 'elevation'/);
}

// The loose hardcoded path wins over aria probing as well.
{
  const errorDiv = new FakeElement({ text: screenshotError });
  const shadowRoot = new FakeRoot({ text: screenshotError, selectors: { div: [errorDiv], "*": [errorDiv] } });
  const consoleTab = new FakeElement({ tagName: "EE-TAB", shadowRoot });
  const ariaTab = new FakeElement({ text: "Console", attributes: { "aria-controls": "console-panel" }, tagName: "BUTTON" });
  const ariaPanel = new FakeElement({ text: "aria panel text" });
  const response = await createHarness({
    selectors: {
      "ee-app-context ee-tab-panel > ee-tab:nth-of-type(2)": [consoleTab],
      "[aria-controls]": [ariaTab]
    },
    ids: { "console-panel": ariaPanel }
  })();
  assert.equal(response.consoleRead.source, "semantic_fallback");
  assert.match(response.consoleText, /Band pattern 'elevation'/);
}

{
  const empty = new FakeElement({ text: "Use print(...) to write to this console." });
  const response = await createHarness({ selectors: { ".console-entries": [empty] } })();
  assert.equal(response.consoleRead.status, "empty");
  assert.equal(response.consoleText, "");
}

{
  const response = await createHarness()();
  assert.deepEqual(response.consoleRead, { status: "unavailable", source: null, reason: "container_not_found" });
}

{
  const response = await createHarness({ selectors: { ".console-entries": [throwingElement()] } })();
  assert.equal(response.consoleRead.status, "unavailable");
  assert.equal(response.consoleRead.reason, "read_failed");
}

{
  const child = new FakeElement({ text: screenshotError });
  const parent = new FakeElement({ text: screenshotError, children: [child] });
  const response = await createHarness({ selectors: { ".console-entries": [parent, child] } })();
  assert.equal(response.consoleText, screenshotError);
}

{
  const longText = `${"a".repeat(20050)}TAIL-MARKER`;
  const response = await createHarness({ selectors: { ".console-entries": [new FakeElement({ text: longText })] } })();
  assert.equal(response.consoleText.length, longText.length);
  assert.ok(response.consoleText.startsWith("a".repeat(20050)));
  assert.ok(response.consoleText.endsWith("TAIL-MARKER"));
}

console.log("Console reader tests passed.");

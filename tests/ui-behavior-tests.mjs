import assert from "node:assert/strict";
import {
  createReasoningView,
  getPlanActionState,
  setPlanToolControls,
  setSettingsPanelOpen,
  setThinkingControlEnabled
} from "../lib/ui.js";

class FakeClassList {
  constructor(...values) {
    this.values = new Set(values);
  }

  toggle(value, force) {
    if (force === undefined ? !this.values.has(value) : force) this.values.add(value);
    else this.values.delete(value);
  }

  contains(value) {
    return this.values.has(value);
  }
}

class FakeElement {
  constructor(tagName = "div", classes = []) {
    this.tagName = tagName;
    this.classList = new FakeClassList(...classes);
    this.attributes = new Map();
    this.children = [];
    this.parent = null;
    this.textContent = "";
    this.open = false;
    this.checked = false;
    this.disabled = false;
    this.focused = false;
    this.scrollTop = 0;
    this.scrollHeight = 1;
  }

  set className(value) {
    this.classList = new FakeClassList(...String(value).split(/\s+/).filter(Boolean));
  }

  append(...children) {
    for (const child of children) {
      child.parent = this;
      this.children.push(child);
    }
  }

  appendChild(child) {
    this.append(child);
  }

  querySelector(tagName) {
    return this.children.find((child) => child.tagName === tagName) || null;
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }

  focus() {
    this.focused = true;
  }

  scrollIntoView() {}

  remove() {
    if (!this.parent) return;
    this.parent.children = this.parent.children.filter((child) => child !== this);
    this.parent = null;
  }
}

const settingsPanel = new FakeElement("section", ["hidden"]);
const settingsButton = new FakeElement("button");
const keyInput = new FakeElement("input");
setSettingsPanelOpen({ panel: settingsPanel, button: settingsButton, keyInput }, true, { focusKey: true });
assert.equal(settingsPanel.classList.contains("hidden"), false);
assert.equal(settingsButton.attributes.get("aria-expanded"), "true");
assert.equal(settingsButton.attributes.get("aria-label"), "关闭模型与项目设置");
assert.equal(keyInput.focused, true);
setSettingsPanelOpen({ panel: settingsPanel, button: settingsButton, keyInput }, false);
assert.equal(settingsPanel.classList.contains("hidden"), true);
assert.equal(settingsButton.attributes.get("aria-expanded"), "false");

const effort = new FakeElement("select");
setThinkingControlEnabled(effort, false);
assert.equal(effort.disabled, true);
setThinkingControlEnabled(effort, true);
assert.equal(effort.disabled, false);

const planControls = {
  hint: new FakeElement("p", ["hidden"]),
  panel: new FakeElement("section", ["hidden"]),
  datasetSearch: new FakeElement("input"),
  docsSearch: new FakeElement("input")
};
setPlanToolControls(planControls, {
  enabled: true,
  busy: false,
  savedDatasetSearch: false,
  savedDocsSearch: false
});
assert.equal(planControls.hint.classList.contains("hidden"), false);
assert.equal(planControls.panel.classList.contains("hidden"), false);
assert.equal(planControls.datasetSearch.checked, true);
assert.equal(planControls.docsSearch.checked, true);
assert.equal(planControls.datasetSearch.disabled, true);
assert.equal(planControls.docsSearch.disabled, true);
setPlanToolControls(planControls, {
  enabled: false,
  busy: false,
  savedDatasetSearch: false,
  savedDocsSearch: true
});
assert.equal(planControls.datasetSearch.checked, false);
assert.equal(planControls.docsSearch.checked, true);
assert.equal(planControls.datasetSearch.disabled, false);

assert.deepEqual(getPlanActionState({ hasPlan: true, state: "ready", planStale: false, busy: false }), {
  showActions: true,
  showConfirm: true,
  showContinue: true,
  disabled: false
});
assert.equal(getPlanActionState({ hasPlan: true, state: "ready", planStale: true, busy: false }).showConfirm, false);
assert.equal(getPlanActionState({ hasPlan: true, state: "generating", planStale: false, busy: true }).showContinue, false);

const fakeDocument = { createElement: (tagName) => new FakeElement(tagName) };
const conversation = new FakeElement("section");
const reasoning = createReasoningView(fakeDocument, conversation);
reasoning.append("第一步");
reasoning.append("，第二步");
assert.equal(conversation.children.length, 1);
const details = conversation.children[0];
assert.equal(details.open, true);
assert.equal(details.querySelector("summary").textContent, "正在思考…");
assert.equal(details.querySelector("pre").textContent, "第一步，第二步");
reasoning.complete();
assert.equal(details.open, false);
assert.equal(details.querySelector("summary").textContent, "思考过程（已完成）");
reasoning.remove();
assert.equal(conversation.children.length, 0);

console.log("UI behavior tests passed.");

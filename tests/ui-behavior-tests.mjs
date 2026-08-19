import assert from "node:assert/strict";
import {
  collectPlanAnswerMarkerIds,
  createReasoningView,
  countPlanAnswerBlocks,
  getPlanActionState,
  isNearScrollEnd,
  planAnswerMarkerId,
  resolveStatusState,
  setComposerModeView,
  setPlanToolControls,
  setScrollToLatestVisibility,
  setSettingsPanelOpen,
  setStatusView,
  setThinkingControlEnabled,
  upsertPlanAnswerText
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
    this.clientHeight = 1;
    this.dataset = {};
    this.title = "";
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
assert.equal(settingsPanel.attributes.get("aria-hidden"), "false");
assert.equal(keyInput.focused, true);
setSettingsPanelOpen({ panel: settingsPanel, button: settingsButton, keyInput }, false);
assert.equal(settingsPanel.classList.contains("hidden"), true);
assert.equal(settingsButton.attributes.get("aria-expanded"), "false");
assert.equal(settingsPanel.attributes.get("aria-hidden"), "true");

const directModeButton = new FakeElement("button");
const planModeButton = new FakeElement("button");
const planModeInput = new FakeElement("input");
setComposerModeView({ directModeButton, planModeButton, planMode: planModeInput }, true);
assert.equal(planModeInput.checked, true);
assert.equal(planModeButton.classList.contains("selected"), true);
assert.equal(planModeButton.attributes.get("aria-pressed"), "true");
assert.equal(directModeButton.attributes.get("aria-pressed"), "false");

const latestButton = new FakeElement("button", ["hidden"]);
assert.equal(setScrollToLatestVisibility(latestButton, false, { hasOverflow: true }), true);
assert.equal(latestButton.classList.contains("hidden"), false);
assert.equal(latestButton.attributes.get("aria-hidden"), "false");
assert.equal(setScrollToLatestVisibility(latestButton, true, { hasOverflow: true }), false);
assert.equal(latestButton.classList.contains("hidden"), true);

const effort = new FakeElement("select");
setThinkingControlEnabled(effort, false);
assert.equal(effort.disabled, true);
setThinkingControlEnabled(effort, true);
assert.equal(effort.disabled, false);

const statusView = new FakeElement("span");
assert.equal(setStatusView(statusView, "正在整理分析计划…"), "processing");
assert.equal(statusView.classList.contains("status-processing"), true);
assert.equal(statusView.attributes.get("aria-busy"), "true");
assert.equal(setStatusView(statusView, "代码已生成"), "success");
assert.equal(statusView.classList.contains("status-success"), true);
assert.equal(setStatusView(statusView, "请求失败"), "error");
assert.equal(statusView.classList.contains("status-error"), true);
assert.match(statusView.textContent, /请检查聊天框输出信息/);
assert.equal(resolveStatusState("请求已停止", { busy: false }), "idle");

assert.equal(isNearScrollEnd({ scrollHeight: 500, clientHeight: 300, scrollTop: 160 }, 48), true);
assert.equal(isNearScrollEnd({ scrollHeight: 500, clientHeight: 300, scrollTop: 80 }, 48), false);

const planControls = {
  hint: new FakeElement("p", ["hidden"]),
  panel: new FakeElement("section", ["hidden"]),
  datasetSearch: new FakeElement("input"),
  docsSearch: new FakeElement("input")
};
setPlanToolControls(planControls, {
  enabled: true,
  busy: false,
  panelVisible: true,
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

let answerDraft = upsertPlanAnswerText("", {
  questionId: "time_aggregation",
  prompt: "您希望 NDVI 均值在时间上如何聚合？",
  option: { label: "逐年均值", description: "每年计算一个平均 NDVI" }
});
answerDraft = `${answerDraft}\n\n额外要求：保留年度时间序列。`;
answerDraft = upsertPlanAnswerText(answerDraft, {
  questionId: "spatial_statistic",
  prompt: "您希望 NDVI 均值在空间上如何统计？",
  option: { label: "全州区域平均", description: "计算整个区域的平均 NDVI" }
});
assert.equal(countPlanAnswerBlocks(answerDraft), 2);
assert.match(answerDraft, /逐年均值/);
assert.match(answerDraft, /全州区域平均/);
assert.match(answerDraft, /额外要求：保留年度时间序列/);

answerDraft = upsertPlanAnswerText(answerDraft, {
  questionId: "time_aggregation",
  prompt: "您希望 NDVI 均值在时间上如何聚合？",
  option: { label: "整个时期单一均值", description: "只输出一个数值" }
});
assert.equal(countPlanAnswerBlocks(answerDraft), 2, "reselecting one question must not duplicate its block");
assert.doesNotMatch(answerDraft, /逐年均值/);
assert.match(answerDraft, /整个时期单一均值/);
assert.match(answerDraft, /全州区域平均/);
assert.match(answerDraft, /额外要求：保留年度时间序列/);

// ISS-009: the marker id used to remember a checked option on the plan card
// must be identical to the id inside the injected answer block, and outgoing
// text exposes exactly those ids so submitted answers can be locked.
assert.equal(planAnswerMarkerId({ questionId: "time_aggregation", prompt: "任何问题" }), "time_aggregation");
assert.equal(planAnswerMarkerId({ questionId: "", prompt: "" }), "");
const freeTextPrompt = "您希望输出什么形式的结果？";
const freeTextDraft = upsertPlanAnswerText("", {
  questionId: "",
  prompt: freeTextPrompt,
  option: { label: "年度序列图" }
});
const fallbackId = planAnswerMarkerId({ questionId: "", prompt: freeTextPrompt });
assert.ok(fallbackId, "questions without a model id fall back to a stable prompt hash");
assert.match(freeTextDraft, new RegExp(`【计划问题 ${fallbackId}】`));
assert.deepEqual(
  collectPlanAnswerMarkerIds(`${answerDraft}\n\n${freeTextDraft}`),
  ["time_aggregation", "spatial_statistic", fallbackId],
  "submitted-answer locking must see exactly the blocks inside the outgoing text"
);
assert.equal(collectPlanAnswerMarkerIds("没有答案块的普通文本").length, 0);
assert.equal(collectPlanAnswerMarkerIds("【计划问题结束 x】").length, 0, "end markers are never collected");

const fakeDocument = { createElement: (tagName) => new FakeElement(tagName) };
const conversation = new FakeElement("section");
const reasoning = createReasoningView(fakeDocument, conversation);
reasoning.append("第一步");
reasoning.append("，第二步");
assert.equal(conversation.children.length, 1);
const details = conversation.children[0];
assert.equal(details.open, true);
assert.equal(details.querySelector("summary").textContent, "思考中");
assert.equal(details.querySelector("pre").textContent, "第一步，第二步");
const reasoningOutput = details.querySelector("pre");
reasoningOutput.scrollHeight = 500;
reasoningOutput.clientHeight = 100;
reasoningOutput.scrollTop = 120;
reasoning.append("，停留阅读");
assert.equal(reasoningOutput.scrollTop, 120, "scrolling up must pause reasoning auto-follow");
reasoningOutput.scrollTop = 400;
reasoning.append("，恢复跟随");
assert.equal(reasoningOutput.scrollTop, 500, "returning to the bottom must resume auto-follow");
reasoning.complete();
assert.equal(details.open, false);
assert.equal(details.querySelector("summary").textContent, "思考过程 · 已完成");
assert.equal(details.classList.contains("activity-success"), true);
const nextReasoning = createReasoningView(fakeDocument, conversation);
nextReasoning.append("新的模型阶段");
assert.equal(conversation.children.length, 1, "a new model phase must replace the previous reasoning card");
assert.equal(conversation.children[0].querySelector("pre").textContent, "新的模型阶段");
nextReasoning.remove();
assert.equal(conversation.children.length, 0);

console.log("UI behavior tests passed.");

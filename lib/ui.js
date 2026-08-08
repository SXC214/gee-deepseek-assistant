export function setSettingsPanelOpen({ panel, button, keyInput, backdrop }, open, { focusKey = false } = {}) {
  const isOpen = Boolean(open);
  panel.classList.toggle("hidden", !isOpen);
  backdrop?.classList.toggle("hidden", !isOpen);
  button.setAttribute("aria-expanded", String(isOpen));
  button.setAttribute("aria-label", isOpen ? "关闭模型与项目设置" : "打开模型与项目设置");
  panel.setAttribute("aria-hidden", String(!isOpen));
  if (isOpen && focusKey) keyInput.focus();
  return isOpen;
}

export function setThinkingControlEnabled(select, thinkingEnabled) {
  select.disabled = !thinkingEnabled;
}

export function resolveStatusState(text, { busy = false } = {}) {
  const value = String(text || "").trim();
  if (/已停止|已暂停|就绪|请(?:在|补充|先)|等待需求|审阅方案|队列/.test(value)) return "idle";
  if (/失败|错误|无法|未能|异常|断开|没有可|尚未配置/.test(value)) return "error";
  if (busy || /正在|处理中|请求中/.test(value)) return "processing";
  if (/完成|成功|已生成|已保存|已读取|已连接|已清除|已取消|已替换|已插入|已复制|已点击|已恢复|已找到/.test(value)) {
    return "success";
  }
  return "idle";
}

export function setStatusView(element, text, { state = "", busy = false } = {}) {
  const rawText = String(text || "").trim();
  const resolved = ["idle", "processing", "success", "error"].includes(state)
    ? state
    : resolveStatusState(rawText, { busy });
  for (const name of ["idle", "processing", "success", "error"]) {
    element.classList.toggle(`status-${name}`, name === resolved);
  }
  element.dataset.rawStatusText = rawText;
  element.dataset.statusState = resolved;
  element.textContent = resolved === "error" && !/检查.*(?:聊天|对话)/.test(rawText)
    ? `${rawText} · 请检查聊天框输出信息`
    : rawText;
  element.title = resolved === "error" ? rawText : "";
  element.setAttribute("aria-busy", String(resolved === "processing"));
  return resolved;
}

export function isNearScrollEnd(element, threshold = 48) {
  if (!element) return true;
  const scrollHeight = Math.max(0, Number(element.scrollHeight) || 0);
  const clientHeight = Math.max(0, Number(element.clientHeight) || 0);
  const scrollTop = Math.max(0, Number(element.scrollTop) || 0);
  if (scrollHeight <= clientHeight) return true;
  return scrollHeight - clientHeight - scrollTop <= Math.max(0, Number(threshold) || 0);
}

export function setPlanToolControls({ hint, panel, datasetSearch, docsSearch }, {
  enabled,
  busy,
  panelVisible = enabled,
  savedDatasetSearch = true,
  savedDocsSearch = true
}) {
  hint.classList.toggle("hidden", !enabled);
  panel.classList.toggle("hidden", !panelVisible);
  if (enabled) {
    datasetSearch.checked = true;
    docsSearch.checked = true;
  } else {
    datasetSearch.checked = savedDatasetSearch;
    docsSearch.checked = savedDocsSearch;
  }
  datasetSearch.disabled = enabled || busy;
  docsSearch.disabled = enabled || busy;
}

export function setComposerModeView(controls, planMode) {
  const directButton = controls.directButton || controls.directModeButton;
  const planButton = controls.planButton || controls.planModeButton;
  const planInput = controls.planInput || controls.planMode;
  const enabled = Boolean(planMode);
  planInput.checked = enabled;
  directButton.classList.toggle("selected", !enabled);
  planButton.classList.toggle("selected", enabled);
  directButton.setAttribute("aria-pressed", String(!enabled));
  planButton.setAttribute("aria-pressed", String(enabled));
  return enabled;
}

export function setScrollToLatestVisibility(button, nearEnd, { hasOverflow = true } = {}) {
  const visible = Boolean(hasOverflow) && !nearEnd;
  button.classList.toggle("hidden", !visible);
  button.setAttribute("aria-hidden", String(!visible));
  return visible;
}

export function getPlanActionState({ hasPlan, state, planStale, busy }) {
  const transient = state === "researching" || state === "generating";
  return {
    showActions: Boolean(hasPlan),
    showConfirm: Boolean(hasPlan) && state === "ready" && !planStale,
    showContinue: Boolean(hasPlan) && !transient,
    disabled: Boolean(busy)
  };
}

/**
 * Stable identity of one plan question's answer block. The sidepanel uses it
 * both to inject answer text and to remember which option the user already
 * checked, so re-rendered question cards keep their selection state.
 */
export function planAnswerMarkerId({ questionId, prompt } = {}) {
  const question = oneLine(prompt);
  const id = cleanPlanAnswerId(questionId);
  if (id) return id;
  return question ? fallbackPlanAnswerId(question) : "";
}

/**
 * Adds one structured Plan Mode answer without overwriting answers for other
 * questions. Selecting the same question again replaces only that block.
 */
export function upsertPlanAnswerText(existingText, { questionId, prompt, option } = {}) {
  const question = oneLine(prompt);
  const label = oneLine(option?.label);
  if (!question || !label) return String(existingText || "");

  const id = planAnswerMarkerId({ questionId, prompt: question });
  const startMarker = `【计划问题 ${id}】`;
  const endMarker = `【计划问题结束 ${id}】`;
  const block = [
    startMarker,
    `问题：${question}`,
    `我的选择：${label}`,
    oneLine(option?.description) ? `补充：${oneLine(option.description)}` : "",
    endMarker
  ].filter(Boolean).join("\n");

  const current = String(existingText || "").replace(/\r\n?/g, "\n");
  const start = current.indexOf(startMarker);
  const end = start >= 0 ? current.indexOf(endMarker, start + startMarker.length) : -1;
  if (start >= 0 && end >= 0) {
    return `${current.slice(0, start)}${block}${current.slice(end + endMarker.length)}`.trim();
  }
  return [current.trim(), block].filter(Boolean).join("\n\n");
}

export function countPlanAnswerBlocks(value) {
  return collectPlanAnswerMarkerIds(value).length;
}

/** Lists the marker ids of every plan answer block inside one outgoing text. */
export function collectPlanAnswerMarkerIds(value) {
  return [...String(value || "").matchAll(/^【计划问题 (?!结束 )([^\n]+)】$/gm)].map((match) => match[1]);
}

function oneLine(value) {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
}

function cleanPlanAnswerId(value) {
  return typeof value === "string"
    ? value.trim().replace(/[^A-Za-z0-9_.:-]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 80)
    : "";
}

function fallbackPlanAnswerId(value) {
  let hash = 2166136261;
  for (const character of value) {
    hash ^= character.codePointAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return `question_${(hash >>> 0).toString(36)}`;
}

export function createReasoningView(document, conversation) {
  let details = null;
  let output = null;

  return {
    append(text) {
      if (!text) return;
      if (!details) {
        details = document.createElement("details");
        details.className = "reasoning-message activity-card activity-processing";
        details.open = true;
        const summary = document.createElement("summary");
        summary.textContent = "思考中";
        output = document.createElement("pre");
        output.className = "reasoning-content";
        details.append(summary, output);
        conversation.appendChild(details);
      }
      const followOutput = isNearScrollEnd(output, 32);
      output.textContent += text;
      if (followOutput) output.scrollTop = output.scrollHeight;
    },
    complete() {
      if (!details) return;
      details.open = false;
      details.classList.toggle("activity-processing", false);
      details.classList.toggle("activity-success", true);
      details.querySelector("summary").textContent = "思考过程 · 已完成";
    },
    remove() {
      details?.remove();
      details = null;
      output = null;
    }
  };
}

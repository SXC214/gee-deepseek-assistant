export function setSettingsPanelOpen({ panel, button, keyInput }, open, { focusKey = false } = {}) {
  const isOpen = Boolean(open);
  panel.classList.toggle("hidden", !isOpen);
  button.setAttribute("aria-expanded", String(isOpen));
  button.setAttribute("aria-label", isOpen ? "关闭模型与项目设置" : "打开模型与项目设置");
  if (isOpen && focusKey) keyInput.focus();
  return isOpen;
}

export function setThinkingControlEnabled(select, thinkingEnabled) {
  select.disabled = !thinkingEnabled;
}

export function setPlanToolControls({ hint, panel, datasetSearch, docsSearch }, {
  enabled,
  busy,
  savedDatasetSearch = true,
  savedDocsSearch = true
}) {
  hint.classList.toggle("hidden", !enabled);
  panel.classList.toggle("hidden", !enabled);
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

export function getPlanActionState({ hasPlan, state, planStale, busy }) {
  const transient = state === "researching" || state === "generating";
  return {
    showActions: Boolean(hasPlan),
    showConfirm: Boolean(hasPlan) && state === "ready" && !planStale,
    showContinue: Boolean(hasPlan) && !transient,
    disabled: Boolean(busy)
  };
}

export function createReasoningView(document, conversation) {
  let details = null;
  let output = null;

  return {
    append(text) {
      if (!text) return;
      if (!details) {
        details = document.createElement("details");
        details.className = "reasoning-message";
        details.open = true;
        const summary = document.createElement("summary");
        summary.textContent = "正在思考…";
        output = document.createElement("pre");
        output.className = "reasoning-content";
        details.append(summary, output);
        conversation.appendChild(details);
        details.scrollIntoView({ behavior: "smooth", block: "nearest" });
      }
      output.textContent += text;
      output.scrollTop = output.scrollHeight;
    },
    complete() {
      if (!details) return;
      details.open = false;
      details.querySelector("summary").textContent = "思考过程（已完成）";
    },
    remove() {
      details?.remove();
      details = null;
      output = null;
    }
  };
}

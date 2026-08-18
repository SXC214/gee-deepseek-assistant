const PASSES = new Set(["fast", "full", "loop"]);

const CODE_CHANGE_PATTERN = /(?:修改|修复|重构|优化|生成|编写|完整脚本|代码|报错|错误|console|fix|debug|refactor|implement|generate|script)/i;
const OFFICIAL_FACT_PATTERN = /(?:数据集|波段|比例因子|云掩膜|覆盖期|分辨率|dataset|band|scale factor|cloud mask|coverage)/i;
const LOOP_PATTERN = /(?:多轮|逐步|反复|运行并|运行后|完整流程|长期|复杂|多个文件|继续修复|loop|long[- ]?running)/i;
const CONSOLE_ERROR_PATTERN = /(?:error|exception|failed|invalid|too many pixels|did not match|错误|异常|失败|无效|未匹配)/i;

export function isReasoningPass(value) {
  return PASSES.has(String(value || "").toLowerCase());
}

/**
 * A deterministic gate avoids spending an extra model call merely to decide
 * how much orchestration a turn needs. Explicit user selection wins, Plan
 * Mode always opens the persistent loop, and observable runtime signals can
 * only escalate a turn.
 */
export function selectReasoningPass({
  requestedPass = "auto",
  planMode = false,
  prompt = "",
  editorState = null,
  previousFailures = [],
  contextOptions = {}
} = {}) {
  const requested = String(requestedPass || "auto").toLowerCase();
  if (isReasoningPass(requested)) return requested;
  if (planMode) return "loop";
  if (Array.isArray(previousFailures) && previousFailures.length) return "loop";

  const text = String(prompt || "");
  const consoleText = contextOptions.includeConsole && editorState?.consoleRead?.status === "captured"
    ? String(editorState.consoleText || "")
    : "";
  if ((consoleText && CONSOLE_ERROR_PATTERN.test(consoleText)) || LOOP_PATTERN.test(text)) return "loop";

  const codeLength = contextOptions.includeCode ? String(editorState?.code || "").length : 0;
  const hasSelectedCode = contextOptions.includeSelection && Boolean(String(editorState?.selection || "").trim());
  const requiresSearch = Boolean(contextOptions.datasetSearch || contextOptions.docsSearch)
    || OFFICIAL_FACT_PATTERN.test(text);
  if (codeLength > 0 || hasSelectedCode || requiresSearch || CODE_CHANGE_PATTERN.test(text)) return "full";
  return "fast";
}

export function escalateReasoningPass(currentPass, targetPass) {
  const rank = { fast: 0, full: 1, loop: 2 };
  const current = isReasoningPass(currentPass) ? currentPass : "fast";
  const target = isReasoningPass(targetPass) ? targetPass : current;
  return rank[target] > rank[current] ? target : current;
}

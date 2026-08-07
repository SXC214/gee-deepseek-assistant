const CONSOLE_STATUSES = new Set(["captured", "empty", "unavailable"]);
const CONSOLE_SOURCES = new Set(["legacy_selector", "aria_tabpanel", "semantic_fallback"]);
const CONSOLE_REASONS = new Set(["container_not_found", "read_failed"]);

export function normalizeConsoleRead(consoleText, value) {
  const text = typeof consoleText === "string" ? consoleText.trim() : "";
  if (text) {
    return {
      status: "captured",
      source: CONSOLE_SOURCES.has(value?.source) ? value.source : null,
      reason: null
    };
  }

  const status = CONSOLE_STATUSES.has(value?.status) ? value.status : "unavailable";
  return {
    status: status === "captured" ? "unavailable" : status,
    source: CONSOLE_SOURCES.has(value?.source) ? value.source : null,
    reason: status === "empty"
      ? null
      : (CONSOLE_REASONS.has(value?.reason) ? value.reason : "container_not_found")
  };
}

export function createConsoleContextSection(state, enabled) {
  if (!enabled || !state) return "";
  const text = typeof state.consoleText === "string" ? state.consoleText.trim() : "";
  const consoleRead = normalizeConsoleRead(text, state.consoleRead);
  if (consoleRead.status === "captured") {
    return `Earth Engine Console 输出：\n\`\`\`text\n${text}\n\`\`\``;
  }
  if (consoleRead.status === "empty") {
    return "Earth Engine Console 状态：已读取，当前无输出。";
  }
  return [
    "Earth Engine Console 状态：未读取到页面控制台。",
    "禁止推测、虚构或把代码分析当作真实 Console 错误；应明确提示用户重新点击“读取”或粘贴错误原文。"
  ].join("\n");
}

export function getConsoleUiState(enabled, consoleRead, attempted = false) {
  if (!enabled || !attempted) {
    return {
      state: "idle",
      label: "Console",
      title: enabled ? "发送前会重新读取 Earth Engine Console" : "未包含 Earth Engine Console 上下文"
    };
  }

  if (consoleRead?.status === "captured") {
    return { state: "captured", label: "Console · 已读取", title: "已读取 Earth Engine Console 输出" };
  }
  const normalized = normalizeConsoleRead("", consoleRead);
  if (normalized.status === "empty") {
    return { state: "empty", label: "Console · 无输出", title: "已找到 Console 面板，当前没有输出" };
  }
  const title = normalized.reason === "read_failed"
    ? "Console 内容读取失败；请重新点击“读取”，或将错误原文粘贴到输入框"
    : "未定位到 Console 面板；请确认 GEE Code Editor 已打开，或将错误原文粘贴到输入框";
  return { state: "unavailable", label: "Console · 未读取", title };
}

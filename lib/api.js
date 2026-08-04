const OFFICIAL_DEEPSEEK_HOST = "api.deepseek.com";
const DEEPSEEK_V4_MODELS = new Set(["deepseek-v4-flash", "deepseek-v4-pro"]);
const REASONING_EFFORTS = new Set(["high", "max"]);
const JSON_PLAN_PURPOSES = new Set(["plan_research", "plan_clarify"]);

/**
 * True only for the hosted DeepSeek V4 endpoints that support the thinking
 * request fields. Compatible OpenAI endpoints deliberately return false.
 */
export function isOfficialDeepSeekV4(baseUrl, model) {
  try {
    const url = new URL(String(baseUrl || "").trim());
    return url.hostname.toLowerCase() === OFFICIAL_DEEPSEEK_HOST
      && DEEPSEEK_V4_MODELS.has(String(model || "").trim().toLowerCase());
  } catch {
    return false;
  }
}

/**
 * Creates the OpenAI-compatible chat body without mutating caller input.
 * DeepSeek-only thinking and streaming fields are intentionally restricted to
 * DeepSeek's official V4 endpoint, so third-party compatibility endpoints keep
 * the old non-streaming request shape.
 */
export function buildChatRequestBody({ model, messages, settings = {}, purpose = "direct", stream } = {}) {
  const normalizedModel = String(model || "").trim();
  if (!normalizedModel) throw new Error("模型名称不能为空");
  if (!Array.isArray(messages) || messages.length === 0) throw new Error("缺少对话内容");

  const body = {
    model: normalizedModel,
    messages: messages.map((message) => ({
      role: ["system", "user", "assistant"].includes(message?.role) ? message.role : "user",
      content: String(message?.content || "")
    }))
  };

  if (!isOfficialDeepSeekV4(settings.baseUrl, normalizedModel)) {
    body.stream = false;
    return body;
  }

  if (JSON_PLAN_PURPOSES.has(String(purpose))) {
    body.response_format = { type: "json_object" };
  }

  const thinkingEnabled = settings.thinkingEnabled !== false;
  body.thinking = { type: thinkingEnabled ? "enabled" : "disabled" };
  if (thinkingEnabled) {
    const effort = String(settings.reasoningEffort || "high").toLowerCase();
    body.reasoning_effort = REASONING_EFFORTS.has(effort) ? effort : "high";
  }
  // The stream option is retained for a clear public API, but official V4
  // requests always stream so reasoning can be rendered incrementally.
  void stream;
  body.stream = true;
  body.stream_options = { include_usage: true };
  return body;
}

export function isValidReasoningEffort(value) {
  return REASONING_EFFORTS.has(String(value || "").toLowerCase());
}

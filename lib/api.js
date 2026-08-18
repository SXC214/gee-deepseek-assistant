const OFFICIAL_DEEPSEEK_HOST = "api.deepseek.com";
const DEEPSEEK_V4_MODEL_BASES = ["deepseek-v4-flash", "deepseek-v4-pro"];
const DEEPSEEK_V4_FLASH_BASE = "deepseek-v4-flash";
const REASONING_EFFORTS = new Set(["high", "max"]);
const JSON_PLAN_PURPOSES = new Set(["plan_research", "plan_clarify"]);

function normalizedModelName(model) {
  return String(model || "").trim().toLowerCase();
}

/**
 * Matches an exact base name or the base followed by a "-" separator and a
 * suffix (e.g. deepseek-v4-flash-latest), so look-alike names such as
 * deepseek-v4-flashback are never treated as V4 models.
 */
function matchesModelBase(name, base) {
  return name === base || name.startsWith(`${base}-`);
}

function isDeepSeekV4ModelName(model) {
  const name = normalizedModelName(model);
  return DEEPSEEK_V4_MODEL_BASES.some((base) => matchesModelBase(name, base));
}

/**
 * True only for the hosted DeepSeek V4 endpoints that support the thinking
 * request fields. Compatible OpenAI endpoints deliberately return false.
 */
export function isOfficialDeepSeekV4(baseUrl, model) {
  try {
    const url = new URL(String(baseUrl || "").trim());
    return url.hostname.toLowerCase() === OFFICIAL_DEEPSEEK_HOST
      && isDeepSeekV4ModelName(model);
  } catch {
    return false;
  }
}

/** True only for the official DeepSeek V4 Flash model. */
export function isOfficialDeepSeekV4Flash(baseUrl, model) {
  return isOfficialDeepSeekV4(baseUrl, model)
    && matchesModelBase(normalizedModelName(model), DEEPSEEK_V4_FLASH_BASE);
}

/**
 * Creates the OpenAI-compatible chat body without mutating caller input.
 * DeepSeek-only thinking and streaming fields are intentionally restricted to
 * DeepSeek's official V4 endpoint; third-party compatibility endpoints keep
 * the old non-streaming request shape unless the compatibleStreaming opt-in
 * is enabled, in which case only a plain stream flag is sent.
 */
export function buildChatRequestBody({
  model,
  messages,
  settings = {},
  purpose = "direct",
  stream,
  tools = [],
  toolChoice = "auto"
} = {}) {
  const normalizedModel = String(model || "").trim();
  if (!normalizedModel) throw new Error("模型名称不能为空");
  if (!Array.isArray(messages) || messages.length === 0) throw new Error("缺少对话内容");

  const body = {
    model: normalizedModel,
    messages: normalizeChatMessages(messages)
  };

  if (!isOfficialDeepSeekV4(settings.baseUrl, normalizedModel)) {
    body.stream = stream === true && settings.compatibleStreaming === true;
    return body;
  }

  const normalizedTools = normalizeTools(tools);
  if (normalizedTools.length) {
    body.tools = normalizedTools;
    // DeepSeek's own V4 agent integration notes that thinking-mode requests
    // may reject tool_choice. `auto` is already the server default whenever
    // tools are present, so only the explicit opt-out needs to be serialized.
    if (toolChoice === "none") body.tool_choice = "none";
  }

  // Tool-call turns may legitimately have empty content. The planning prompt
  // still requires strict JSON for the final answer, but response_format is
  // omitted while tools are resident because some compatible gateways reject
  // the combination. The final content remains schema-validated by plan.js.
  if (!normalizedTools.length && JSON_PLAN_PURPOSES.has(String(purpose))) {
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

export function normalizeChatMessages(messages) {
  if (!Array.isArray(messages) || messages.length === 0) throw new Error("缺少对话内容");
  return messages.map(normalizeChatMessage);
}

function normalizeChatMessage(message) {
  const role = ["system", "user", "assistant", "tool"].includes(message?.role)
    ? message.role
    : "user";
  const normalized = {
    role,
    content: typeof message?.content === "string" ? message.content : ""
  };
  if (role === "assistant") {
    if (typeof message?.reasoning_content === "string") {
      normalized.reasoning_content = message.reasoning_content;
    }
    const toolCalls = normalizeToolCalls(message?.tool_calls);
    if (toolCalls.length) normalized.tool_calls = toolCalls;
  }
  if (role === "tool") {
    const toolCallId = cleanIdentifier(message?.tool_call_id, 200);
    if (!toolCallId) throw new Error("工具结果缺少 tool_call_id");
    normalized.tool_call_id = toolCallId;
  }
  return normalized;
}

function normalizeToolCalls(value) {
  if (!Array.isArray(value)) return [];
  return value.map((call) => {
    const id = cleanIdentifier(call?.id, 200);
    const name = cleanIdentifier(call?.function?.name, 120);
    if (!id || !name) return null;
    return {
      id,
      type: "function",
      function: {
        name,
        arguments: typeof call?.function?.arguments === "string" ? call.function.arguments : "{}"
      }
    };
  }).filter(Boolean);
}

function normalizeTools(value) {
  if (!Array.isArray(value)) return [];
  return value.map((tool) => {
    const name = cleanIdentifier(tool?.function?.name, 64);
    if (!name) return null;
    const parameters = tool?.function?.parameters;
    return {
      type: "function",
      function: {
        name,
        description: String(tool?.function?.description || "").trim().slice(0, 1000),
        parameters: parameters && typeof parameters === "object" && !Array.isArray(parameters)
          ? parameters
          : { type: "object", properties: {} }
      }
    };
  }).filter(Boolean).slice(0, 12);
}

function cleanIdentifier(value, limit) {
  return typeof value === "string" ? value.trim().replace(/[^A-Za-z0-9_.:-]/g, "_").slice(0, limit) : "";
}

export function isValidReasoningEffort(value) {
  return REASONING_EFFORTS.has(String(value || "").toLowerCase());
}

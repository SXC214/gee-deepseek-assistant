// 模型服务商预设表。只负责「API 地址 + 默认模型名」的便捷填充，
// 不参与请求体构造、流式判定或任何模型行为逻辑（那些仍在
// lib/api.js / service-worker.js 中，按官方 DeepSeek 前缀匹配）。
// 新增/调整服务商只需维护 PROVIDER_PRESETS，无需改动 UI 逻辑。

export const CUSTOM_PROVIDER_ID = "custom";

// baseUrl 与默认模型名以各服务商 OpenAI 兼容端点公开文档为准
// （DeepSeek api.deepseek.com；智谱 open.bigmodel.cn/api/paas/v4；
// Moonshot api.moonshot.cn/v1；阿里百炼 dashscope.aliyuncs.com
// compatible-mode）。模型名取各系列当前通用型号，字段始终可编辑。
export const PROVIDER_PRESETS = Object.freeze([
  Object.freeze({
    id: "deepseek",
    label: "DeepSeek 官方",
    baseUrl: "https://api.deepseek.com",
    defaultModel: "deepseek-v4-flash"
  }),
  Object.freeze({
    id: "zhipu",
    label: "智谱 GLM",
    baseUrl: "https://open.bigmodel.cn/api/paas/v4",
    defaultModel: "glm-5.2"
  }),
  Object.freeze({
    id: "moonshot",
    label: "Moonshot Kimi",
    baseUrl: "https://api.moonshot.cn/v1",
    defaultModel: "kimi-k3"
  }),
  Object.freeze({
    id: "qwen",
    label: "阿里通义 Qwen",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    defaultModel: "qwen3.8-max"
  }),
  // 本地桥接走 http 回环地址，允许空 API Key（见 service-worker.js 豁免）。
  Object.freeze({
    id: "local-qoder",
    label: "本地 Qoder CLI 桥接",
    baseUrl: "http://127.0.0.1:3000/v1",
    defaultModel: "qoder-cli"
  })
]);

export function findProviderPreset(id) {
  return PROVIDER_PRESETS.find((preset) => preset.id === id) || null;
}

function normalizeBaseUrlForMatch(value) {
  return String(value || "").trim().replace(/\/+$/, "");
}

// 按当前已保存的 baseUrl / model 反查命中的预设；都不命中返回 null
// （UI 回显为「自定义」）。baseUrl 容忍末尾斜杠差异。
export function matchProviderPreset(baseUrl, model) {
  const base = normalizeBaseUrlForMatch(baseUrl);
  const target = String(model || "").trim();
  const preset = PROVIDER_PRESETS.find((entry) => (
    normalizeBaseUrlForMatch(entry.baseUrl) === base && entry.defaultModel === target
  ));
  return preset ? preset.id : null;
}

const VALIDATION_SCHEMA_VERSION = 1;
const CHECK_STATUSES = new Set(["passed", "warning", "failed"]);
const MAX_CHECKS = 20;
const MAX_DETAIL = 2000;
const MAX_IDS = 80;

/**
 * Deterministic preflight for a generated Earth Engine JavaScript candidate.
 * This is intentionally not presented as a GEE runtime test: server-side
 * dataset permissions, reducers and task quotas still require the real Code
 * Editor Console.
 */
export function validateGeeCandidate({ code = "", plan = null, sources = [] } = {}) {
  const source = String(code || "").replace(/\r\n?/g, "\n");
  const datasetIds = extractGeeDatasetIds(source);
  const checks = [];

  const structureIssues = [];
  if (/```/.test(source)) structureIssues.push("候选中仍包含 Markdown 代码围栏");
  const lexical = scanJavaScriptStructure(source);
  if (!lexical.ok) structureIssues.push(lexical.error);
  checks.push(check(
    "javascript_structure",
    "JavaScript 结构",
    structureIssues.length ? "failed" : "passed",
    structureIssues.length ? structureIssues.join("；") : "括号、字符串、注释与正则边界预检通过"
  ));

  const forbidden = findForbiddenRuntimeUses(source);
  checks.push(check(
    "gee_runtime_surface",
    "GEE 运行环境",
    forbidden.length ? "failed" : "passed",
    forbidden.length
      ? `Code Editor 不应使用或自动执行：${forbidden.join("、")}`
      : "未发现浏览器 DOM、Node.js、动态执行或删除资产 API"
  ));

  const secrets = findEmbeddedSecrets(source);
  checks.push(check(
    "secret_exposure",
    "敏感信息",
    secrets.length ? "failed" : "passed",
    secrets.length ? `疑似在脚本中嵌入：${secrets.join("、")}` : "未发现常见 API Key 或私钥模式"
  ));

  const surfaceSymbols = source.match(/\b(?:ee|Map|ui|Export|print)\b/g) || [];
  checks.push(check(
    "gee_symbols",
    "Earth Engine 对象",
    surfaceSymbols.length ? "passed" : "warning",
    surfaceSymbols.length
      ? `检测到 ${[...new Set(surfaceSymbols)].join("、")}`
      : "未检测到 ee、Map、ui、Export 或 print；请确认这确实是 GEE 脚本"
  ));

  const evidence = evaluateDatasetEvidence(datasetIds, sources);
  checks.push(check("dataset_evidence", "数据集来源", evidence.status, evidence.detail));

  const alignment = evaluatePlanAlignment(source, datasetIds, plan);
  checks.push(check("plan_alignment", "确认计划一致性", alignment.status, alignment.detail));

  const status = checks.some((item) => item.status === "failed")
    ? "failed"
    : checks.some((item) => item.status === "warning") ? "warning" : "passed";
  return sanitizeGeeValidation({
    schemaVersion: VALIDATION_SCHEMA_VERSION,
    status,
    summary: summarize(status, checks),
    checks,
    datasetIds,
    createdAt: Date.now()
  });
}

export function sanitizeGeeValidation(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const checks = (Array.isArray(value.checks) ? value.checks : [])
    .map((item) => check(item?.id, item?.label, item?.status, item?.detail))
    .filter((item) => item.id && item.label)
    .slice(0, MAX_CHECKS);
  if (!checks.length) return null;
  const derivedStatus = checks.some((item) => item.status === "failed")
    ? "failed"
    : checks.some((item) => item.status === "warning") ? "warning" : "passed";
  return {
    schemaVersion: VALIDATION_SCHEMA_VERSION,
    status: CHECK_STATUSES.has(value.status) && value.status === derivedStatus ? value.status : derivedStatus,
    summary: cleanText(value.summary) || summarize(derivedStatus, checks),
    checks,
    datasetIds: cleanStrings(value.datasetIds).slice(0, MAX_IDS),
    createdAt: normalizeTimestamp(value.createdAt)
  };
}

export function formatValidationRepairPrompt(validation) {
  const value = sanitizeGeeValidation(validation);
  const failures = value?.checks.filter((item) => item.status === "failed") || [];
  if (!failures.length) return "";
  return [
    "上一个候选脚本未通过本地确定性预检。请只修复下列阻断项，并保持原任务、已确认计划、数据集选择、用户资产变量和无关代码不变。",
    ...failures.map((item) => `- ${item.label}：${item.detail}`),
    "返回简短说明，并在一个 ```javascript 代码块中给出修正后的完整 GEE Code Editor 脚本。不要返回补丁。",
    "这次是唯一一次自动修复；不要重复原样输出。"
  ].join("\n");
}

export function extractGeeDatasetIds(code) {
  const ids = [];
  const pattern = /\bee\.(?:ImageCollection|Image|FeatureCollection)\s*\(\s*(["'`])([^"'`\r\n]+)\1/g;
  for (const match of String(code || "").matchAll(pattern)) {
    const id = match[2].trim();
    if (id && !ids.includes(id)) ids.push(id);
  }
  return ids.slice(0, MAX_IDS);
}

export function scanJavaScriptStructure(code) {
  const source = String(code || "");
  const stack = [];
  let state = "normal";
  let regexClass = false;
  const pairs = { "(": ")", "[": "]", "{": "}" };
  const closing = new Set(Object.values(pairs));

  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    const next = source[index + 1];
    if (state === "line_comment") {
      if (char === "\n") state = "normal";
      continue;
    }
    if (state === "block_comment") {
      if (char === "*" && next === "/") {
        state = "normal";
        index += 1;
      }
      continue;
    }
    if (["single", "double", "template"].includes(state)) {
      const delimiter = state === "single" ? "'" : state === "double" ? '"' : "`";
      if (char === "\\") {
        index += 1;
        continue;
      }
      if (char === delimiter) state = "normal";
      else if (char === "\n" && state !== "template") {
        return scanFailure(source, index, "字符串在换行前未闭合");
      }
      continue;
    }
    if (state === "regex") {
      if (char === "\\") {
        index += 1;
        continue;
      }
      if (char === "[" && !regexClass) regexClass = true;
      else if (char === "]" && regexClass) regexClass = false;
      else if (char === "/" && !regexClass) state = "normal";
      else if (char === "\n") return scanFailure(source, index, "正则表达式在换行前未闭合");
      continue;
    }

    if (char === "/" && next === "/") {
      state = "line_comment";
      index += 1;
    } else if (char === "/" && next === "*") {
      state = "block_comment";
      index += 1;
    } else if (char === "'") state = "single";
    else if (char === '"') state = "double";
    else if (char === "`") state = "template";
    else if (char === "/" && beginsRegex(source, index)) {
      state = "regex";
      regexClass = false;
    } else if (pairs[char]) stack.push({ char, index });
    else if (closing.has(char)) {
      const open = stack.pop();
      if (!open || pairs[open.char] !== char) {
        return scanFailure(source, index, `括号不匹配：${open?.char || "无起始符"} → ${char}`);
      }
    }
  }

  if (state === "block_comment") return scanFailure(source, source.length, "块注释未闭合");
  if (["single", "double", "template"].includes(state)) return scanFailure(source, source.length, "字符串未闭合");
  if (state === "regex") return scanFailure(source, source.length, "正则表达式未闭合");
  const open = stack.at(-1);
  if (open) return scanFailure(source, open.index, `括号未闭合：${open.char}`);
  return { ok: true, error: "" };
}

function findForbiddenRuntimeUses(code) {
  const executable = maskNonCode(String(code || "").replace(/```(?:javascript)?/gi, ""));
  const patterns = [
    ["document DOM", /\bdocument\s*[.[]/],
    ["window DOM", /\bwindow\s*[.[]/],
    ["Node.js process", /\bprocess\s*[.[]/],
    ["CommonJS module.exports", /\bmodule\s*\.\s*exports\b/],
    ["localStorage/sessionStorage", /\b(?:localStorage|sessionStorage)\b/],
    ["fetch/XMLHttpRequest", /\b(?:fetch\s*\(|XMLHttpRequest\b)/],
    ["动态 eval/Function", /\b(?:eval\s*\(|new\s+Function\s*\()/],
    ["删除 Earth Engine 资产", /\bee\.data\.(?:deleteAsset|cancelOperation)\s*\(/]
  ];
  return patterns.filter(([, pattern]) => pattern.test(executable)).map(([label]) => label);
}

function findEmbeddedSecrets(code) {
  const patterns = [
    ["Google API Key", /\bAIza[0-9A-Za-z_-]{30,}\b/],
    ["通用 sk API Key", /\bsk-[0-9A-Za-z_-]{16,}\b/],
    ["私钥 PEM", /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/]
  ];
  return patterns.filter(([, pattern]) => pattern.test(code)).map(([label]) => label);
}

function evaluateDatasetEvidence(datasetIds, sources) {
  if (!datasetIds.length) {
    return { status: "warning", detail: "未检测到字符串形式的 ee.Image/ImageCollection/FeatureCollection 数据集 ID" };
  }
  const verified = new Set((Array.isArray(sources) ? sources : [])
    .map((source) => String(source?.datasetId || "").trim())
    .filter(Boolean));
  const publicIds = datasetIds.filter((id) => !isUserAsset(id));
  const unverified = publicIds.filter((id) => !verified.has(id));
  if (!publicIds.length) {
    return { status: "passed", detail: `检测到 ${datasetIds.length} 个用户/项目资产；其权限和内容需在 GEE 中验证` };
  }
  if (unverified.length) {
    return {
      status: "warning",
      detail: `以下公开数据集未与本轮官方来源快照精确匹配：${unverified.join("、")}`
    };
  }
  return { status: "passed", detail: `${publicIds.length} 个公开数据集 ID 均与本轮官方目录快照精确匹配` };
}

function evaluatePlanAlignment(code, datasetIds, plan) {
  if (!plan || typeof plan !== "object") return { status: "passed", detail: "本轮没有已确认计划约束" };
  const planIds = (Array.isArray(plan.datasets) ? plan.datasets : [])
    .map((item) => String(item?.datasetId || "").trim())
    .filter(Boolean);
  const issues = [];
  if (planIds.length && !datasetIds.some((id) => planIds.includes(id))) {
    issues.push(`代码未使用计划列出的数据集（${planIds.join("、")}）`);
  }
  const timeText = typeof plan.requirements?.timeRange === "string"
    ? plan.requirements.timeRange
    : JSON.stringify(plan.requirements?.timeRange || "");
  const years = [...new Set(timeText.match(/\b(?:19|20)\d{2}\b/g) || [])];
  const missingYears = years.filter((year) => !code.includes(year));
  if (missingYears.length) issues.push(`代码中未找到计划时间范围年份：${missingYears.join("、")}`);
  return issues.length
    ? { status: "warning", detail: issues.join("；") }
    : { status: "passed", detail: "数据集和显式时间范围与计划未发现冲突" };
}

function beginsRegex(source, index) {
  const prefix = source.slice(0, index).replace(/\s+$/, "");
  if (!prefix) return true;
  const previous = prefix.at(-1);
  if (/[(\[{,:;=!?&|+\-*%^~<>]/.test(previous)) return true;
  const word = prefix.match(/([A-Za-z_$][\w$]*)$/)?.[1];
  return /^(?:return|case|throw|typeof|instanceof|in|of|delete|void|new|yield|await)$/.test(word || "");
}

function maskNonCode(code) {
  const source = String(code || "");
  let output = "";
  let state = "normal";
  let regexClass = false;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    const next = source[index + 1];
    if (state === "normal") {
      if (char === "/" && next === "/") {
        state = "line_comment";
        output += "  ";
        index += 1;
      } else if (char === "/" && next === "*") {
        state = "block_comment";
        output += "  ";
        index += 1;
      } else if (char === "'") {
        state = "single";
        output += " ";
      } else if (char === '"') {
        state = "double";
        output += " ";
      } else if (char === "`") {
        state = "template";
        output += " ";
      } else if (char === "/" && beginsRegex(source, index)) {
        state = "regex";
        regexClass = false;
        output += " ";
      } else output += char;
      continue;
    }
    if (char === "\n") {
      output += "\n";
      if (state === "line_comment") state = "normal";
      continue;
    }
    output += " ";
    if (state === "block_comment" && char === "*" && next === "/") {
      output += " ";
      index += 1;
      state = "normal";
    } else if (["single", "double", "template"].includes(state)) {
      const delimiter = state === "single" ? "'" : state === "double" ? '"' : "`";
      if (char === "\\") {
        output += " ";
        index += 1;
      } else if (char === delimiter) state = "normal";
    } else if (state === "regex") {
      if (char === "\\") {
        output += " ";
        index += 1;
      } else if (char === "[" && !regexClass) regexClass = true;
      else if (char === "]" && regexClass) regexClass = false;
      else if (char === "/" && !regexClass) state = "normal";
    }
  }
  return output;
}

function scanFailure(source, index, message) {
  const prefix = source.slice(0, Math.max(0, index));
  const line = prefix.split("\n").length;
  const column = prefix.length - prefix.lastIndexOf("\n");
  return { ok: false, error: `${message}（第 ${line} 行，第 ${column} 列附近）` };
}

function isUserAsset(id) {
  return /^(?:users\/|projects\/|projects\/earthengine-legacy\/assets\/)/.test(id);
}

function check(id, label, status, detail) {
  return {
    id: cleanId(id),
    label: cleanText(label),
    status: CHECK_STATUSES.has(status) ? status : "warning",
    detail: cleanText(detail)
  };
}

function summarize(status, checks) {
  const passed = checks.filter((item) => item.status === "passed").length;
  const warnings = checks.filter((item) => item.status === "warning").length;
  const failed = checks.filter((item) => item.status === "failed").length;
  if (status === "failed") return `预检未通过：${failed} 项阻断，${warnings} 项提醒，${passed} 项通过`;
  if (status === "warning") return `预检通过但需核验：${warnings} 项提醒，${passed} 项通过`;
  return `预检通过：${passed} 项检查均通过`;
}

function cleanStrings(value) {
  return Array.isArray(value) ? value.map((item) => cleanText(item)).filter(Boolean) : [];
}

function cleanText(value) {
  return String(value || "").replace(/\r\n?/g, "\n").trim().slice(0, MAX_DETAIL);
}

function cleanId(value) {
  return typeof value === "string" ? value.trim().replace(/[^A-Za-z0-9_.:-]/g, "_").slice(0, 120) : "";
}

function normalizeTimestamp(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : Date.now();
}

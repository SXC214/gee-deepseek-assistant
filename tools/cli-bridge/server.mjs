// tools/cli-bridge/server.mjs
// 本地桥接服务：把 Qoder CLI 包装为 OpenAI 兼容端点，供扩展以
// baseUrl http://127.0.0.1:3000/v1 接入。
// 单文件、零 npm 依赖（仅 node: 内置模块），仅监听回环地址。
//
// 运行方式：node tools/cli-bridge/server.mjs
// 环境变量：BRIDGE_PORT / BRIDGE_CLI / BRIDGE_CLI_ARGS / PROXY_API_KEY / BRIDGE_TIMEOUT_MS

import http from "node:http";
import { spawn } from "node:child_process";
import { timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

const MODEL_ID = "qoder-cli";
const DEFAULT_PORT = 3000;
const DEFAULT_TIMEOUT_MS = 300000;
const MAX_BODY_BYTES = 10 * 1024 * 1024;
const STDERR_TAIL_LENGTH = 500;

// ---------------------------------------------------------------------------
// 纯函数（便于单元测试）
// ---------------------------------------------------------------------------

// 三态授权：key 未配置 → 直接放行（启动时已打 stderr 警告）；
// 否则要求 Authorization: Bearer <key> 精确匹配。
export function isAuthorized(headers, key) {
  if (!key) return true;
  const entries = Object.entries(headers || {});
  const header = entries.find(([name]) => name.toLowerCase() === "authorization");
  if (!header || typeof header[1] !== "string") return false;
  const match = /^Bearer\s+(.+)$/i.exec(header[1].trim());
  if (!match) return false;
  const provided = Buffer.from(match[1].trim(), "utf8");
  const expected = Buffer.from(String(key), "utf8");
  if (provided.length !== expected.length) return false;
  return timingSafeEqual(provided, expected);
}

function extractMessageText(content) {
  if (typeof content === "string") return content.trim();
  if (Array.isArray(content)) {
    return content
      .filter((part) => part && typeof part === "object" && typeof part.text === "string")
      .map((part) => part.text)
      .join("\n")
      .trim();
  }
  return "";
}

// 把 messages（system/user/assistant）按 role 分段拼为单一 prompt。
// 空数组 / 非法输入 → 返回空字符串，由调用方决定 400。
export function buildPromptFromMessages(messages) {
  if (!Array.isArray(messages)) return "";
  const segments = [];
  for (const message of messages) {
    if (!message || typeof message !== "object") continue;
    const role = typeof message.role === "string" && message.role.trim()
      ? message.role.trim().toLowerCase()
      : "user";
    const text = extractMessageText(message.content);
    if (!text) continue;
    segments.push(`[${role}]\n${text}`);
  }
  return segments.join("\n\n");
}

// 解析 CLI stream-json 的一行 JSONL，返回 { kind, text }：
// kind = "delta"（流式增量）| "assistant"（整块消息）| "result"（最终结果）
//      | "other"（非文本行）| "invalid"（坏行 / 空行 / 非字符串）。
export function parseStreamJsonLine(line) {
  if (typeof line !== "string") return { kind: "invalid", text: "" };
  const trimmed = line.trim();
  if (!trimmed) return { kind: "invalid", text: "" };
  let obj;
  try {
    obj = JSON.parse(trimmed);
  } catch {
    return { kind: "invalid", text: "" };
  }
  if (!obj || typeof obj !== "object") return { kind: "other", text: "" };
  if (obj.type === "stream_event") {
    const event = obj.event;
    if (
      event && event.type === "content_block_delta" &&
      event.delta && typeof event.delta.text === "string" && event.delta.text
    ) {
      return { kind: "delta", text: event.delta.text };
    }
    return { kind: "other", text: "" };
  }
  if (obj.type === "assistant" && obj.message && Array.isArray(obj.message.content)) {
    const text = obj.message.content
      .filter((block) => block && block.type === "text" && typeof block.text === "string")
      .map((block) => block.text)
      .join("");
    return text ? { kind: "assistant", text } : { kind: "other", text: "" };
  }
  if (obj.type === "result" && typeof obj.result === "string" && obj.result) {
    return { kind: "result", text: obj.result };
  }
  return { kind: "other", text: "" };
}

function sseChunk(payload) {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

// 把一行 stream-json 转成 OpenAI SSE 增量帧；非文本行 / 坏行 → null。
export function streamJsonLineToSse(line) {
  const parsed = parseStreamJsonLine(line);
  if (!parsed.text) return null;
  return sseChunk({
    choices: [{ index: 0, delta: { content: parsed.text }, finish_reason: null }]
  });
}

// ---------------------------------------------------------------------------
// 服务端配置（全部来自环境变量，禁止从 HTTP 请求注入）
// ---------------------------------------------------------------------------

export function loadConfig(env) {
  return {
    port: Number.parseInt(env.BRIDGE_PORT || "", 10) || DEFAULT_PORT,
    cli: env.BRIDGE_CLI || "qoderclicn",
    extraArgs: String(env.BRIDGE_CLI_ARGS || "").split(/\s+/).filter(Boolean),
    proxyApiKey: env.PROXY_API_KEY || "",
    timeoutMs: Number.parseInt(env.BRIDGE_TIMEOUT_MS || "", 10) || DEFAULT_TIMEOUT_MS
  };
}

// ---------------------------------------------------------------------------
// HTTP 辅助
// ---------------------------------------------------------------------------

function errorPayload(message, type) {
  return { error: { message, type } };
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body)
  });
  res.end(body);
}

function setCorsHeaders(res) {
  // 扩展页面（chrome-extension:// 源）通过 fetch 访问回环端点时需要 CORS 放行。
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("request body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      try {
        resolve(JSON.parse(raw || "{}"));
      } catch {
        reject(new Error("invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

// ---------------------------------------------------------------------------
// CLI 调用
// ---------------------------------------------------------------------------

function buildCliArgs(config, prompt) {
  // CLI 命令与固定参数全部来自服务端配置，prompt 是唯一的动态部分。
  return ["-q", "-p", prompt, "--output-format", "stream-json", "--max-turns=1", ...config.extraArgs];
}

// 解析 CLI 命令到实际可执行文件（Windows 下补 PATHEXT 后缀搜索）。
function resolveCommand(cli) {
  const name = String(cli || "");
  if (!name) return null;
  if (path.isAbsolute(name) || name.includes("/") || name.includes(path.sep)) {
    const absolute = path.resolve(name);
    return fs.existsSync(absolute) ? absolute : null;
  }
  const extensions = ["", ...(process.env.PATHEXT || ".CMD;.EXE;.BAT").split(";").filter(Boolean)];
  for (const dir of (process.env.PATH || "").split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of extensions) {
      const candidate = path.join(dir, name + ext.toLowerCase());
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  return null;
}

// npm 在 Windows 上生成的 .cmd 垫片内含真实 JS 入口，提取出来直接用 node 跑，
// 避免经 cmd.exe 中转（prompt 含换行/引号会被 cmd 破坏）。
function extractShimScript(shimPath) {
  let text;
  try {
    text = fs.readFileSync(shimPath, "utf8");
  } catch {
    return null;
  }
  const match = /"%_prog%"\s+"([^"]+\.js)"/i.exec(text) ||
    /\bnode(?:\.exe)?"?\s+"([^"]+\.js)"/i.exec(text);
  if (!match) return null;
  const script = match[1].replace(/%dp0%\\?/gi, "");
  return path.resolve(path.dirname(shimPath), script);
}

function spawnCli(config, args) {
  const resolved = resolveCommand(config.cli);
  if (resolved && /\.(mjs|cjs|js)$/i.test(resolved)) {
    return spawn(process.execPath, [resolved, ...args], { windowsHide: true });
  }
  if (process.platform === "win32" && resolved && resolved.toLowerCase().endsWith(".cmd")) {
    const script = extractShimScript(resolved);
    if (script && fs.existsSync(script)) {
      return spawn(process.execPath, [script, ...args], { windowsHide: true });
    }
  }
  return spawn(config.cli, args);
}

function makeCompletionMeta(model) {
  return {
    id: `chatcmpl-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`,
    created: Math.floor(Date.now() / 1000),
    model: typeof model === "string" && model ? model : MODEL_ID
  };
}

function stderrTail(text) {
  const trimmed = String(text || "").trim();
  return trimmed ? ` stderr: ${trimmed.slice(-STDERR_TAIL_LENGTH)}` : "";
}

function handleChatCompletions(req, res, config) {
  if (!isAuthorized(req.headers, config.proxyApiKey)) {
    sendJson(res, 401, errorPayload("Invalid API key for local bridge.", "invalid_request_error"));
    return;
  }
  let body;
  readJsonBody(req)
    .then((parsed) => {
      body = parsed;
      const prompt = buildPromptFromMessages(body.messages);
      if (!prompt) {
        sendJson(res, 400, errorPayload("messages must contain non-empty text content.", "invalid_request_error"));
        return;
      }
      runCli(res, config, body, prompt);
    })
    .catch((err) => {
      sendJson(res, 400, errorPayload(err.message, "invalid_request_error"));
    });
}

function runCli(res, config, body, prompt) {
  const wantsStream = body.stream === true;
  const args = buildCliArgs(config, prompt);
  const meta = makeCompletionMeta(body.model);

  let child;
  try {
    child = spawnCli(config, args);
  } catch (err) {
    sendJson(res, 502, errorPayload(`Failed to start CLI "${config.cli}": ${err.message}`, "bridge_error"));
    return;
  }

  const state = {
    headersSent: false,
    timedOut: false,
    sawDelta: false,
    accumulated: "",
    assistantText: "",
    resultText: "",
    stderrText: "",
    stdoutBuffer: ""
  };
  const timer = setTimeout(() => {
    state.timedOut = true;
    child.kill("SIGTERM");
  }, config.timeoutMs);

  const emitSse = (payload) => {
    if (!state.headersSent) {
      state.headersSent = true;
      res.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no"
      });
      res.write(sseChunk({
        ...meta,
        object: "chat.completion.chunk",
        choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }]
      }));
    }
    res.write(sseChunk(payload));
  };

  const emitText = (text) => {
    if (wantsStream) emitSse({ choices: [{ index: 0, delta: { content: text }, finish_reason: null }] });
  };

  const handleLine = (rawLine) => {
    const parsed = parseStreamJsonLine(rawLine);
    if (parsed.kind === "delta") {
      state.sawDelta = true;
      state.accumulated += parsed.text;
      emitText(parsed.text);
    } else if (parsed.kind === "assistant") {
      state.assistantText = state.assistantText ? `${state.assistantText}\n${parsed.text}` : parsed.text;
      // 已有逐字增量时跳过整块消息，避免内容重复。
      if (!state.sawDelta) emitText(parsed.text);
    } else if (parsed.kind === "result") {
      state.resultText = parsed.text;
      // 既无增量也无整块消息时才输出 result 行，避免重复。
      if (!state.sawDelta && !state.assistantText) emitText(parsed.text);
    }
  };

  const finishStream = (ok) => {
    if (!state.headersSent) {
      // 一个增量都没发出过（例如 CLI 无输出）：也按空回复收尾。
      emitText("");
    }
    if (ok) {
      res.write(sseChunk({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }));
      res.write("data: [DONE]\n\n");
    }
    res.end();
  };

  const finalText = () => state.resultText || state.assistantText || state.accumulated;

  const sendCompletion = () => {
    sendJson(res, 200, {
      ...meta,
      object: "chat.completion",
      choices: [{
        index: 0,
        message: { role: "assistant", content: finalText() },
        finish_reason: "stop"
      }],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
    });
  };

  child.stdout.on("data", (chunk) => {
    state.stdoutBuffer += chunk.toString("utf8");
    let idx = state.stdoutBuffer.indexOf("\n");
    while (idx >= 0) {
      const line = state.stdoutBuffer.slice(0, idx);
      state.stdoutBuffer = state.stdoutBuffer.slice(idx + 1);
      handleLine(line);
      idx = state.stdoutBuffer.indexOf("\n");
    }
  });

  child.stderr.on("data", (chunk) => {
    state.stderrText += chunk.toString("utf8");
  });

  child.on("error", (err) => {
    clearTimeout(timer);
    if (!state.headersSent) {
      const hint = err.code === "ENOENT"
        ? ` Is "${config.cli}" installed and on PATH?`
        : "";
      sendJson(res, 502, errorPayload(`Failed to start CLI "${config.cli}": ${err.message}.${hint}`, "bridge_error"));
    } else {
      finishStream(false);
    }
  });

  child.on("close", (code) => {
    clearTimeout(timer);
    if (state.stdoutBuffer.trim()) {
      handleLine(state.stdoutBuffer);
      state.stdoutBuffer = "";
    }
    if (state.timedOut) {
      if (!state.headersSent) {
        sendJson(res, 504, errorPayload(`CLI timed out after ${config.timeoutMs} ms.`, "bridge_timeout"));
      } else {
        finishStream(false);
      }
      return;
    }
    if (code !== 0) {
      if (!state.headersSent) {
        sendJson(res, 502, errorPayload(
          `CLI exited with code ${code}.${stderrTail(state.stderrText)}`,
          "bridge_error"
        ));
      } else {
        finishStream(false);
      }
      return;
    }
    if (wantsStream) {
      finishStream(true);
    } else {
      sendCompletion();
    }
  });

  // 客户端断开时回收 CLI 子进程，避免挂尸。
  res.on("close", () => {
    clearTimeout(timer);
    if (child.exitCode === null) child.kill("SIGTERM");
  });
}

// ---------------------------------------------------------------------------
// 路由与启动
// ---------------------------------------------------------------------------

export function createBridgeServer(config) {
  return http.createServer((req, res) => {
    setCorsHeaders(res);
    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }
    let pathname = req.url || "/";
    try {
      pathname = new URL(req.url, "http://127.0.0.1").pathname;
    } catch {
      // 保持原始 url，走 404。
    }
    if (req.method === "GET" && pathname === "/v1/models") {
      sendJson(res, 200, {
        object: "list",
        data: [{ id: MODEL_ID, object: "model", owned_by: "cli-bridge" }]
      });
      return;
    }
    if (req.method === "POST" && pathname === "/v1/chat/completions") {
      handleChatCompletions(req, res, config);
      return;
    }
    sendJson(res, 404, errorPayload(`Unknown route: ${req.method} ${pathname}`, "invalid_request_error"));
  });
}

export function startServer(config) {
  const server = createBridgeServer(config);
  server.listen(config.port, "127.0.0.1", () => {
    console.log(`[cli-bridge] listening on http://127.0.0.1:${config.port}/v1 (CLI: ${config.cli})`);
    if (!config.proxyApiKey) {
      console.error("[cli-bridge] 警告：未设置 PROXY_API_KEY，已跳过 Bearer 鉴权（仅限回环访问时方可接受）。");
    }
  });
  return server;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  startServer(loadConfig(process.env));
}

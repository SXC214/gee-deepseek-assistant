function readableError(payload) {
  const detail = payload?.error?.message || payload?.message || payload?.error;
  if (typeof detail === "string" && detail.trim()) return detail.trim();
  return "流式接口返回了未知错误";
}

function jsonParseError(data) {
  const preview = data.length > 160 ? `${data.slice(0, 157)}...` : data;
  return new Error(`无法解析模型流式响应 JSON：${preview}`);
}

/**
 * Incrementally parses an SSE response. `push` accepts strings or Uint8Array
 * chunks; `flush` processes a final event even when the terminating blank line
 * was lost during a disconnect.
 */
export function createSseParser({ onEvent = () => {} } = {}) {
  if (typeof onEvent !== "function") throw new Error("onEvent 必须是函数");

  const decoder = new TextDecoder();
  let buffer = "";
  let done = false;
  let finishReason = null;
  let usage = null;

  const emit = (event) => onEvent(event);
  const emitDone = () => {
    if (done) return;
    done = true;
    emit({ type: "DONE", finishReason, usage });
  };

  const processFrame = (frame) => {
    const dataLines = frame
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).replace(/^ /, ""));
    if (!dataLines.length) return;

    const data = dataLines.join("\n").trim();
    if (data === "[DONE]") {
      emitDone();
      return;
    }

    let payload;
    try {
      payload = JSON.parse(data);
    } catch {
      throw jsonParseError(data);
    }
    if (payload?.error) throw new Error(`模型流式请求失败：${readableError(payload)}`);

    if (payload?.usage) {
      usage = payload.usage;
      emit({ type: "USAGE", usage });
    }

    for (const choice of Array.isArray(payload?.choices) ? payload.choices : []) {
      const delta = choice?.delta || {};
      if (typeof delta.reasoning_content === "string" && delta.reasoning_content) {
        emit({ type: "REASONING_DELTA", delta: delta.reasoning_content });
      }
      if (typeof delta.content === "string" && delta.content) {
        emit({ type: "CONTENT_DELTA", delta: delta.content });
      }
      if (choice?.finish_reason != null) finishReason = choice.finish_reason;
    }
  };

  const drain = () => {
    while (true) {
      const delimiter = /\r?\n\r?\n/.exec(buffer);
      if (!delimiter) return;
      const frame = buffer.slice(0, delimiter.index);
      buffer = buffer.slice(delimiter.index + delimiter[0].length);
      processFrame(frame);
    }
  };

  return {
    push(chunk) {
      if (chunk == null || done) return;
      buffer += typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true });
      drain();
    },
    flush() {
      if (done) return;
      buffer += decoder.decode();
      if (buffer.trim()) processFrame(buffer);
      buffer = "";
      // A well-formed OpenAI stream ends with [DONE]. A network-disconnected
      // response that already supplied a finish reason is still complete.
      if (finishReason != null) emitDone();
    },
    getState() {
      return { done, finishReason, usage };
    }
  };
}

/** Convenience helper for tests and small callers with an already-read body. */
export function parseSseChunks(chunks) {
  const events = [];
  const parser = createSseParser({ onEvent: (event) => events.push(event) });
  for (const chunk of chunks) parser.push(chunk);
  parser.flush();
  return events;
}

/**
 * Reads a fetch Response body with the incremental parser. Keeping this here
 * makes HTTP error handling identical for every Runtime Port request.
 */
export async function consumeSseResponse(response, { onEvent, signal } = {}) {
  if (!response?.ok) {
    const raw = await response?.text?.() || "";
    let payload = null;
    try {
      payload = raw ? JSON.parse(raw) : null;
    } catch {
      // The body is included only as a short diagnostic when it is not JSON.
    }
    const detail = payload ? readableError(payload) : (raw.trim() || `HTTP ${response?.status || "未知"}`);
    throw new Error(`模型流式请求失败：${detail}`);
  }
  if (!response.body?.getReader) throw new Error("模型流式响应没有可读取的正文");

  const parser = createSseParser({ onEvent });
  const reader = response.body.getReader();
  const abort = () => {
    Promise.resolve(reader.cancel()).catch(() => {});
  };
  if (signal?.aborted) abort();
  else signal?.addEventListener("abort", abort, { once: true });
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      parser.push(value);
    }
    parser.flush();
    return parser.getState();
  } finally {
    signal?.removeEventListener("abort", abort);
    reader.releaseLock?.();
  }
}

(() => {
  "use strict";

  const CHANNEL = "gee-ai-assistant";
  const REQUEST = "GEE_AI_BRIDGE_REQUEST";
  const RESPONSE = "GEE_AI_BRIDGE_RESPONSE";
  const pending = new Map();

  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    const message = event.data;
    if (!message || message.channel !== CHANNEL || message.type !== RESPONSE) return;
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    clearTimeout(request.timeout);
    if (message.ok) request.resolve(message.result);
    else request.reject(new Error(message.error || "编辑器桥接失败"));
  });

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message || typeof message.type !== "string") return false;

    if (message.type === "EDITOR_GET_STATE") {
      requestBridge("GET_STATE").then(
        (state) => sendResponse({ ok: true, state, consoleText: readConsole() }),
        (error) => sendResponse({ ok: false, error: safeError(error) })
      );
      return true;
    }

    if (message.type === "EDITOR_APPLY_CODE") {
      requestBridge("APPLY_CODE", message.payload || {}).then(
        (result) => sendResponse({ ok: true, result }),
        (error) => sendResponse({ ok: false, error: safeError(error) })
      );
      return true;
    }

    if (message.type === "EDITOR_RUN") {
      try {
        const button = document.querySelector("button.run-button, .run-button");
        if (!button) throw new Error("未找到 Run 按钮；页面结构可能已经更新");
        button.click();
        sendResponse({ ok: true });
      } catch (error) {
        sendResponse({ ok: false, error: safeError(error) });
      }
      return false;
    }

    if (message.type === "EDITOR_GET_CONSOLE") {
      sendResponse({ ok: true, consoleText: readConsole() });
      return false;
    }

    return false;
  });

  function requestBridge(action, payload = {}, timeoutMs = 10000) {
    const id = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        pending.delete(id);
        reject(new Error("连接 Earth Engine 编辑器超时"));
      }, timeoutMs);
      pending.set(id, { resolve, reject, timeout });
      window.postMessage({ channel: CHANNEL, type: REQUEST, id, action, payload }, "*");
    });
  }

  function readConsole() {
    const container = document.querySelector(".console-entries");
    if (!container) return "";
    return (container.innerText || "").trim().slice(-20000);
  }

  function safeError(error) {
    return error instanceof Error ? error.message : String(error);
  }
})();

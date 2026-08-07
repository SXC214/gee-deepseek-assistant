(() => {
  "use strict";

  const CHANNEL = "gee-ai-assistant";
  const REQUEST = "GEE_AI_BRIDGE_REQUEST";
  const RESPONSE = "GEE_AI_BRIDGE_RESPONSE";

  window.addEventListener("message", async (event) => {
    if (event.source !== window) return;
    const message = event.data;
    if (!message || message.channel !== CHANNEL || message.type !== REQUEST) return;

    try {
      const result = await handle(message.action, message.payload || {});
      reply(message.id, { ok: true, result });
    } catch (error) {
      reply(message.id, { ok: false, error: safeError(error) });
    }
  });

  async function handle(action, payload) {
    const editor = await waitForEditor();

    if (action === "GET_STATE") return getState(editor);
    if (action === "APPLY_CODE") return applyCode(editor, payload);
    if (action === "FOCUS") {
      editor.focus();
      return { focused: true };
    }
    throw new Error(`未知编辑器操作：${action}`);
  }

  function findEditor() {
    const container = document.querySelector(".ace_editor");
    if (!container) return null;

    if (container.env?.editor) return container.env.editor;
    if (window.ace?.edit) {
      try {
        return window.ace.edit(container);
      } catch {
        return null;
      }
    }
    return null;
  }

  async function waitForEditor(timeoutMs = 8000) {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      const editor = findEditor();
      if (editor?.session?.getValue) return editor;
      await new Promise((resolve) => setTimeout(resolve, 120));
    }
    throw new Error("未找到 Earth Engine 的 Ace 编辑器实例；页面可能尚未加载或结构已更新");
  }

  function getState(editor) {
    const code = editor.session.getValue();
    const range = editor.getSelectionRange();
    const selection = editor.session.getTextRange(range);
    return {
      code,
      selection,
      selectionRange: plainRange(range),
      cursor: { row: editor.getCursorPosition().row, column: editor.getCursorPosition().column },
      revision: hash(code),
      title: document.title || "Earth Engine Script"
    };
  }

  function applyCode(editor, payload) {
    const current = editor.session.getValue();
    if (payload.expectedRevision && payload.expectedRevision !== hash(current)) {
      throw new Error("编辑器代码已经发生变化。请重新读取并生成修改，避免覆盖新内容");
    }

    const text = String(payload.code ?? "");
    const mode = payload.mode || "replace_all";
    if (mode === "replace_selection") {
      editor.session.replace(editor.getSelectionRange(), text);
    } else if (mode === "insert") {
      editor.insert(text);
    } else if (mode === "replace_all") {
      const lines = current.split("\n");
      const end = { row: lines.length - 1, column: lines.at(-1).length };
      const range = createEditorRange(editor, { row: 0, column: 0 }, end);
      if (range) {
        editor.session.replace(range, text);
      } else if (typeof editor.setValue === "function") {
        editor.setValue(text, -1);
      } else if (typeof editor.session.setValue === "function") {
        editor.session.setValue(text);
      } else {
        throw new Error("当前 Earth Engine 编辑器不支持完整脚本替换，请刷新页面后重试");
      }
      editor.moveCursorTo(0, 0);
      editor.clearSelection();
    } else {
      throw new Error(`不支持的写入方式：${mode}`);
    }

    editor.focus();
    const updated = editor.session.getValue();
    return { revision: hash(updated), length: updated.length };
  }

  function createEditorRange(editor, start, end) {
    const range = editor.getSelectionRange?.();
    if (!range || typeof range.isEmpty !== "function") return null;

    if (typeof range.setStart === "function" && typeof range.setEnd === "function") {
      range.setStart(start.row, start.column);
      range.setEnd(end.row, end.column);
    } else {
      range.start = { row: start.row, column: start.column };
      range.end = { row: end.row, column: end.column };
    }
    return range;
  }

  function plainRange(range) {
    return {
      start: { row: range.start.row, column: range.start.column },
      end: { row: range.end.row, column: range.end.column }
    };
  }

  function hash(text) {
    let value = 0x811c9dc5;
    for (let index = 0; index < text.length; index += 1) {
      value ^= text.charCodeAt(index);
      value = Math.imul(value, 0x01000193);
    }
    return (value >>> 0).toString(16).padStart(8, "0");
  }

  function reply(id, payload) {
    window.postMessage({ channel: CHANNEL, type: RESPONSE, id, ...payload }, "*");
  }

  function safeError(error) {
    return error instanceof Error ? error.message : String(error);
  }
})();

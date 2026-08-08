(() => {
  "use strict";

  const CHANNEL = "gee-ai-assistant";
  const REQUEST = "GEE_AI_BRIDGE_REQUEST";
  const RESPONSE = "GEE_AI_BRIDGE_RESPONSE";
  const EDITOR_HOSTNAME = "code.earthengine.google.com";

  // In-memory XSRF cache, mirroring the page's own behaviour (TTL × 0.9).
  let xsrfCache = null; // { token, expiresAt }

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
    if (action === "SHP_GET_UPLOAD_URL") return getShapefileUploadUrl();
    if (action === "SHP_UPLOAD_BLOB") return uploadShapefileBytes(payload);

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

  // ---------- Shapefile byte-upload channel (page-session based) ----------
  // The blobstore byte-upload leg only accepts the Code Editor page session
  // (cookies); the extension's own OAuth token is rejected there. These
  // actions therefore run same-origin fetches with credentials: "include".

  function assertEditorOrigin() {
    if (window.location?.hostname !== EDITOR_HOSTNAME) {
      throw new Error("该功能只能在 Earth Engine Code Editor（code.earthengine.google.com）页面中使用，请先打开该页面");
    }
  }

  function stripGoogleEnvelope(text) {
    // Google internal endpoints may prefix JSON with an anti-XSSI )]}' envelope.
    return String(text).replace(/^\)\]\}'\n?/, "");
  }

  function sessionHttpError(status) {
    const error = (status === 401 || status === 403)
      ? new Error(`页面会话无效或未登录，请在 Code Editor 页面刷新后重试（HTTP ${status}）`)
      : new Error(`请求失败（HTTP error ${status}），请稍后重试`);
    error.status = status;
    return error;
  }

  async function fetchPageJson(url, options) {
    let response;
    try {
      response = await fetch(url, options);
    } catch (error) {
      throw new Error(`网络请求失败：${safeError(error)}，请检查网络连接后重试`);
    }
    if (!response.ok) throw sessionHttpError(response.status);
    try {
      return JSON.parse(stripGoogleEnvelope(await response.text()));
    } catch {
      throw new Error("页面会话响应无法解析，请在 Code Editor 页面刷新后重试");
    }
  }

  async function getXsrfToken() {
    if (xsrfCache && Date.now() < xsrfCache.expiresAt) return xsrfCache.token;
    const data = await fetchPageJson("/xsrf/refresh", { credentials: "include" });
    if (!data?.xsrfToken) {
      throw new Error("页面会话令牌缺失，请在 Code Editor 页面刷新后重试");
    }
    const ttl = Number(data.xsrfTokenExpiresInMs);
    xsrfCache = Number.isFinite(ttl) && ttl > 0
      ? { token: data.xsrfToken, expiresAt: Date.now() + Math.floor(ttl * 0.9) }
      : { token: data.xsrfToken, expiresAt: 0 };
    return xsrfCache.token;
  }

  async function getShapefileUploadUrl() {
    assertEditorOrigin();
    const token = await getXsrfToken();
    try {
      const data = await fetchPageJson("/assets/upload/geturl", {
        credentials: "include",
        headers: { "x-xsrf-token": token }
      });
      if (!data?.url) {
        throw new Error("服务端未返回上传地址，请在 Code Editor 页面刷新后重试");
      }
      return { url: data.url };
    } catch (error) {
      // A rejected session invalidates the cached token as well.
      if (error.status === 401 || error.status === 403) xsrfCache = null;
      throw error;
    }
  }

  async function uploadShapefileBytes(payload) {
    assertEditorOrigin();
    const uploadUrl = typeof payload?.uploadUrl === "string" ? payload.uploadUrl.trim() : "";
    if (!uploadUrl) throw new Error("缺少上传地址（uploadUrl），请先通过 SHP_GET_UPLOAD_URL 获取");
    const entries = Array.isArray(payload?.files) ? payload.files : [];
    if (!entries.length) throw new Error("没有可上传的文件字节（files 为空）");

    const names = [];
    const formData = new FormData();
    for (const entry of entries) {
      const name = String(entry?.name || "file");
      if (entry?.buffer === null || entry?.buffer === undefined) throw new Error(`文件「${name}」缺少字节内容（buffer）`);
      // The official client hardcodes the part field name to "file".
      formData.append("file", new Blob([entry.buffer]), name);
      names.push(name);
    }

    let response;
    try {
      // Blobstore leg: cookie auth only, no XSRF header required.
      response = await fetch(uploadUrl, { method: "POST", credentials: "include", body: formData });
    } catch (error) {
      throw new Error(`字节上传失败：网络请求失败（${safeError(error)}），请检查网络连接后重试`);
    }
    if (!response.ok) {
      throw new Error(`字节上传失败（HTTP error ${response.status}），请重新获取上传地址后重试`);
    }
    let uris;
    try {
      uris = JSON.parse(stripGoogleEnvelope(await response.text()));
    } catch {
      throw new Error("上传响应无法解析，请重试");
    }
    if (!Array.isArray(uris)) throw new Error("上传响应不是资源引用列表，请重试");
    if (uris.length !== names.length) {
      throw new Error(`上传结果数量不匹配：期望 ${names.length} 个，实际 ${uris.length} 个`);
    }
    return { uris, files: names.map((name, index) => ({ name, uri: uris[index] })) };
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

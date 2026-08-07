(() => {
  "use strict";

  const CHANNEL = "gee-ai-assistant";
  const REQUEST = "GEE_AI_BRIDGE_REQUEST";
  const RESPONSE = "GEE_AI_BRIDGE_RESPONSE";
  const CONSOLE_SOURCES = ["legacy_selector", "aria_tabpanel", "semantic_fallback"];
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
        (state) => {
          const consoleResult = readConsole();
          sendResponse({
            ok: true,
            state,
            consoleText: consoleResult.text,
            consoleRead: consoleReadMetadata(consoleResult)
          });
        },
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
      const consoleResult = readConsole();
      sendResponse({
        ok: true,
        consoleText: consoleResult.text,
        consoleRead: consoleReadMetadata(consoleResult)
      });
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
    try {
      let foundContainer = false;
      let firstSource = null;
      let readFailed = false;

      const directEeConsoles = findElementsInOpenShadowRoots("ee-console");
      if (directEeConsoles.length) {
        foundContainer = true;
        firstSource = "semantic_fallback";
        const directTexts = [];
        for (const eeConsole of directEeConsoles) {
          try {
            const text = extractConsoleText(eeConsole);
            if (text) directTexts.push(text);
          } catch {
            readFailed = true;
          }
        }
        const directText = [...new Set(directTexts)].join("\n\n").trim();
        if (directText) {
          return {
            text: directText,
            status: "captured",
            source: "semantic_fallback",
            reason: null
          };
        }
      }

      for (const source of CONSOLE_SOURCES) {
        const candidates = findConsoleCandidates(source);
        if (!candidates.length) continue;
        foundContainer = true;
        firstSource ||= source;

        const texts = [];
        for (const candidate of preferVisible(candidates)) {
          try {
            const text = extractConsoleText(candidate);
            if (text) texts.push(text);
          } catch {
            readFailed = true;
          }
        }

        const merged = mergeConsoleTexts(texts);
        if (merged) {
          return {
            text: merged,
            status: "captured",
            source,
            reason: null
          };
        }
      }

      if (foundContainer && !readFailed) {
        return { text: "", status: "empty", source: firstSource, reason: null };
      }
      return {
        text: "",
        status: "unavailable",
        source: firstSource,
        reason: readFailed ? "read_failed" : "container_not_found"
      };
    } catch {
      return { text: "", status: "unavailable", source: null, reason: "read_failed" };
    }
  }

  function findConsoleCandidates(source) {
    if (source === "legacy_selector") {
      return uniqueElements(safeQueryAll(".console-entries"));
    }
    if (source === "aria_tabpanel") {
      return findAriaConsolePanels();
    }
    return findSemanticConsoleCandidates();
  }

  function findAriaConsolePanels() {
    const candidates = [];
    for (const control of safeQueryAll("[aria-controls]")) {
      if (!isConsoleLabel(control)) continue;
      const ids = String(control.getAttribute?.("aria-controls") || "").split(/\s+/).filter(Boolean);
      for (const id of ids) {
        const panel = document.getElementById?.(id);
        if (panel) candidates.push(panel);
      }
    }

    for (const panel of safeQueryAll('[role="tabpanel"]')) {
      const ownLabel = `${panel.getAttribute?.("aria-label") || ""} ${panel.getAttribute?.("data-title") || ""}`;
      const labelledBy = panel.getAttribute?.("aria-labelledby");
      const label = labelledBy ? document.getElementById?.(labelledBy) : null;
      if (/\bconsole\b/i.test(`${ownLabel} ${elementLabel(label)}`)) candidates.push(panel);
    }
    return uniqueElements(candidates);
  }

  function findSemanticConsoleCandidates() {
    const candidates = findElementsInOpenShadowRoots("ee-console");
    candidates.push(...safeQueryAll([
      '[class*="console" i]',
      '[id*="console" i]'
    ].join(",")));
    candidates.push(...findGeeConsoleTabCandidates());

    for (const label of safeQueryAll('button,[role="tab"],div,span')) {
      if (!isConsoleLabel(label)) continue;
      const parent = label.parentElement;
      if (!parent) continue;
      for (const sibling of elementChildren(parent.parentElement)) {
        if (sibling !== parent && hasConsoleSignal(rawElementText(sibling))) candidates.push(sibling);
      }
    }

    for (const errorNode of safeQueryAll('[role="alert"],[class*="error" i]')) {
      if (hasConsoleSignal(rawElementText(errorNode))) candidates.push(errorNode);
    }

    return uniqueElements(candidates).filter((element) => {
      const tag = String(element?.tagName || "").toLowerCase();
      const role = String(element?.getAttribute?.("role") || "").toLowerCase();
      return !["button", "input", "label"].includes(tag) && role !== "tab";
    });
  }

  function findGeeConsoleTabCandidates() {
    const exactPath = "body > ee-app-context > div > div:nth-of-type(2) > div:nth-of-type(1) > div > div:nth-of-type(2) > div > ee-tab-panel > ee-tab:nth-of-type(2)";
    const tabs = uniqueElements([
      ...safeQueryAll(exactPath),
      ...safeQueryAll("ee-app-context ee-tab-panel > ee-tab:nth-of-type(2)")
    ]);
    const candidates = [];
    for (const tab of tabs) {
      candidates.push(tab, ...findOpenShadowContents(tab));
    }
    return uniqueElements(candidates);
  }

  function findOpenShadowContents(host) {
    const candidates = [];
    const roots = [];
    if (host?.shadowRoot) roots.push(host.shadowRoot);
    for (const root of roots) {
      candidates.push(root, ...safeQueryAllFrom(root, "div"));
      for (const element of safeQueryAllFrom(root, "*")) {
        if (element.shadowRoot && !roots.includes(element.shadowRoot)) roots.push(element.shadowRoot);
      }
    }
    return candidates;
  }

  function findElementsInOpenShadowRoots(selector, root = document, visited = new Set()) {
    if (!root || visited.has(root)) return [];
    visited.add(root);
    const matches = safeQueryAllFrom(root, selector);
    if (isOpenShadowRoot(root.shadowRoot)) {
      matches.push(...findElementsInOpenShadowRoots(selector, root.shadowRoot, visited));
    }
    for (const host of safeQueryAllFrom(root, "*")) {
      if (isOpenShadowRoot(host.shadowRoot)) {
        matches.push(...findElementsInOpenShadowRoots(selector, host.shadowRoot, visited));
      }
    }
    return uniqueElements(matches);
  }

  function isOpenShadowRoot(root) {
    return Boolean(root && (root.mode === "open" || root.mode == null));
  }

  function safeQueryAll(selector) {
    try {
      return [...(document.querySelectorAll?.(selector) || [])];
    } catch {
      return [];
    }
  }

  function safeQueryAllFrom(root, selector) {
    try {
      return [...(root?.querySelectorAll?.(selector) || [])];
    } catch {
      return [];
    }
  }

  function uniqueElements(elements) {
    return [...new Set(elements.filter(Boolean))];
  }

  function preferVisible(elements) {
    return [...elements].sort((left, right) => Number(isElementVisible(right)) - Number(isElementVisible(left)));
  }

  function isElementVisible(element) {
    if (!element || element.hidden || element.getAttribute?.("aria-hidden") === "true") return false;
    try {
      if (typeof element.checkVisibility === "function") return element.checkVisibility();
    } catch {
      return false;
    }
    return true;
  }

  function extractConsoleText(element) {
    if (String(element?.tagName || "").toLowerCase() === "ee-console") {
      return extractEeConsoleText(element);
    }
    return preferredElementText(element);
  }

  function preferredElementText(element) {
    const visibleText = normalizeConsoleText(element?.innerText || "");
    const fallbackText = normalizeConsoleText(element?.textContent || "");
    return fallbackText.length > visibleText.length ? fallbackText : visibleText;
  }

  function extractEeConsoleText(eeConsole) {
    const logs = findElementsInOpenShadowRoots("ee-console-log", eeConsole);
    if (!logs.length) return deepElementText(eeConsole);
    return logs
      .map(extractEeConsoleLogText)
      .filter(Boolean)
      .join("\n\n")
      .trim();
  }

  function extractEeConsoleLogText(logElement) {
    const trivialTexts = findElementsInOpenShadowRoots(".trivial", logElement)
      .map(deepElementText)
      .filter(Boolean);
    const structuredText = trivialTexts.join(" ").trim();
    const leafText = collectLeafConsoleText(logElement);
    const completeText = leafText || deepElementText(logElement);
    let message = chooseCompleteConsoleEntry(completeText, structuredText);
    message = message.replace(/^JSON\s*/i, "").trim();

    const hasVisualContent = findElementsInOpenShadowRoots(
      'canvas,svg,img,iframe,[class*="chart" i]',
      logElement
    ).length > 0;
    if (hasVisualContent && !/可视化|visualization detected/i.test(message)) {
      message = `${message}${message ? " " : ""}[图表或可视化内容，请使用截图查看]`;
    }
    return message;
  }

  function chooseCompleteConsoleEntry(completeText, structuredText) {
    const complete = normalizeConsoleText(completeText).replace(/^JSON\s*/i, "").trim();
    const structured = normalizeConsoleText(structuredText).replace(/^JSON\s*/i, "").trim();
    if (!complete) return structured;
    if (!structured) return complete;
    const compactComplete = complete.replace(/\s+/g, "");
    const compactStructured = structured.replace(/\s+/g, "");
    if (compactComplete === compactStructured) return structured;
    if (compactComplete.includes(compactStructured)) return complete;
    return `${structured}\n${complete}`;
  }

  function deepElementText(element) {
    const texts = [];
    const ownText = preferredElementText(element);
    if (ownText) texts.push(ownText);
    for (const root of collectOpenShadowRoots(element)) {
      const text = preferredElementText(root);
      if (text) texts.push(text);
    }
    return mergeConsoleTexts(texts);
  }

  function collectOpenShadowRoots(root, visited = new Set()) {
    if (!root || visited.has(root)) return [];
    visited.add(root);
    const roots = [];
    if (isOpenShadowRoot(root.shadowRoot)) {
      roots.push(root.shadowRoot, ...collectOpenShadowRoots(root.shadowRoot, visited));
    }
    for (const element of safeQueryAllFrom(root, "*")) {
      if (isOpenShadowRoot(element.shadowRoot)) {
        roots.push(element.shadowRoot, ...collectOpenShadowRoots(element.shadowRoot, visited));
      }
    }
    return uniqueElements(roots);
  }

  function collectLeafConsoleText(root) {
    const segments = [];
    const visited = new Set();

    function visit(node) {
      if (!node || visited.has(node)) return;
      visited.add(node);
      if (node.nodeType === 3) {
        const value = String(node.nodeValue || "").replace(/\s+/g, " ").trim();
        if (value) segments.push(value);
        return;
      }
      const tag = String(node.tagName || "").toLowerCase();
      if (["button", "script", "style"].includes(tag) || node.getAttribute?.("aria-hidden") === "true") return;
      for (const child of [...(node.childNodes || [])]) visit(child);
      if (isOpenShadowRoot(node.shadowRoot)) visit(node.shadowRoot);
    }

    visit(root);
    return normalizeConsoleText(segments.join(" "));
  }

  function rawElementText(element) {
    try {
      return `${element?.innerText || ""}\n${element?.textContent || ""}`;
    } catch {
      return "";
    }
  }

  function normalizeConsoleText(value) {
    const removable = /^(?:console|tasks|ask|troubleshoot|use\s+print\(\.\.\.\)\s+to\s+write\s+to\s+this\s+console\.?\s*)$/i;
    return String(value || "")
      .replace(/\u00a0/g, " ")
      .replace(/\r\n?/g, "\n")
      .split("\n")
      .map((line) => line.replace(/[\t ]+/g, " ").trim())
      .filter((line) => line && !removable.test(line))
      .join("\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }

  function mergeConsoleTexts(texts) {
    const unique = [...new Set(texts.filter(Boolean))];
    return unique
      .filter((text, index) => !unique.some((other, otherIndex) => otherIndex !== index && other.length > text.length && other.includes(text)))
      .join("\n\n")
      .trim();
  }

  function elementLabel(element) {
    if (!element) return "";
    return `${element.getAttribute?.("aria-label") || ""} ${element.textContent || ""}`.trim();
  }

  function isConsoleLabel(element) {
    return /\bconsole\b/i.test(elementLabel(element));
  }

  function elementChildren(element) {
    return element?.children ? [...element.children] : [];
  }

  function hasConsoleSignal(value) {
    return /\b(?:layer\s+error|error|exception|traceback)\b|did not match any bands|use\s+print\(\.\.\.\)/i.test(String(value || ""));
  }

  function consoleReadMetadata(result) {
    return { status: result.status, source: result.source, reason: result.reason };
  }

  function safeError(error) {
    return error instanceof Error ? error.message : String(error);
  }
})();

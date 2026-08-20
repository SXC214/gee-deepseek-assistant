import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const EXTENSION_DIR = path.resolve(SCRIPT_DIR, "..");
const DEFAULT_OUTPUT_DIR = path.join(EXTENSION_DIR, "artifacts", "playwright");
const SAFE_STORAGE_KEYS = [
  "activePlanV1",
  "chatHistoryV1",
  "messageQueueV1",
  "reasoningSessionV1"
];
const DEFAULT_WAIT_MS = 4_000;
const MAX_WAIT_MS = 10 * 60_000;
const ATTACHED_WORKERS = new WeakSet();
const GUANGZHOU_NDVI_PROMPT = [
  "请为广州市设计 2010—2025 年 NDVI 分析方案。",
  "请比较适合该时段的 Earth Engine 官方数据集，明确覆盖期、空间与时间分辨率、云与质量控制、年度合成、区域统计和输出，",
  "并在形成代码前提出必要的澄清问题。"
].join("");
const runtimeSecretValues = [];

const options = parseArgs(process.argv.slice(2));
if (options.help) {
  printHelp();
  process.exit(0);
}

const report = {
  schemaVersion: 1,
  startedAt: new Date().toISOString(),
  environment: {
    extensionDir: EXTENSION_DIR,
    playwrightVersion: "",
    browserExecutable: chromium.executablePath(),
    headed: options.headed,
    waitMs: options.waitMs,
    profileDir: options.profileDir
  },
  extension: null,
  geePage: null,
  sidepanel: null,
  storedRecords: null,
  scenario: null,
  events: [],
  findings: [],
  artifacts: {},
  completedAt: null
};

let context = null;
let reportPath = "";
let intentionalShutdown = false;

try {
  report.environment.playwrightVersion = await installedPlaywrightVersion();
  await fs.mkdir(options.profileDir, { recursive: true });
  await fs.mkdir(options.outputDir, { recursive: true });

  context = await chromium.launchPersistentContext(options.profileDir, {
    channel: "chromium",
    headless: !options.headed,
    viewport: { width: 1440, height: 1000 },
    args: [
      `--disable-extensions-except=${EXTENSION_DIR}`,
      `--load-extension=${EXTENSION_DIR}`
    ]
  });
  attachContextDiagnostics(context, report.events);
  if (options.mockTodoRecovery) installMockRoutes(context, report);

  const serviceWorker = context.serviceWorkers()[0]
    || await context.waitForEvent("serviceworker", { timeout: 20_000 });
  attachWorkerDiagnostics(serviceWorker, report.events);
  const extensionId = new URL(serviceWorker.url()).hostname;
  report.extension = {
    id: extensionId,
    serviceWorkerUrl: serviceWorker.url()
  };

  const geePage = await context.newPage();
  attachPageDiagnostics(geePage, "gee_page", report.events);
  await navigateWithDiagnostics(geePage, "https://code.earthengine.google.com/", "gee_page", report.events);

  const sidepanel = await context.newPage();
  attachPageDiagnostics(sidepanel, "sidepanel", report.events);
  if (options.mockTodoRecovery) {
    await sidepanel.setViewportSize({ width: 460, height: 885 });
  }
  await navigateWithDiagnostics(
    sidepanel,
    `chrome-extension://${extensionId}/sidepanel.html`,
    "sidepanel",
    report.events
  );

  await sidepanel.waitForLoadState("domcontentloaded", { timeout: 15_000 }).catch((error) => {
    pushEvent(report.events, "sidepanel", "load_wait_error", error.message, "error");
  });
  await sidepanel.waitForTimeout(options.waitMs);

  if (options.mockTodoRecovery) {
    await runMockTodoRecovery(sidepanel, report);
  } else if (options.liveGuangzhouNdvi) {
    await runLiveGuangzhouNdvi(sidepanel, report);
  } else if (options.auditGuangzhouNdvi) {
    await auditExistingGuangzhouNdvi(sidepanel, report);
  }

  report.extension = {
    ...report.extension,
    ...(await readExtensionIdentity(sidepanel))
  };
  report.sidepanel = await readSidepanelSnapshot(sidepanel);
  report.storedRecords = await readSafeStoredRecords(sidepanel);
  report.geePage = await readGeePageSnapshot(geePage);

  const timestamp = fileTimestamp();
  const sidepanelScreenshot = path.join(options.outputDir, `sidepanel-${timestamp}.png`);
  const geeScreenshot = path.join(options.outputDir, `gee-page-${timestamp}.png`);
  await sidepanel.screenshot({ path: sidepanelScreenshot, fullPage: true });
  await geePage.screenshot({ path: geeScreenshot, fullPage: false });
  report.artifacts = {
    sidepanelScreenshot,
    geeScreenshot
  };
  report.findings = buildFindings(report);
} catch (error) {
  pushEvent(report.events, "diagnostic", "fatal", error?.stack || error?.message || String(error), "error");
  report.findings = buildFindings(report);
  process.exitCode = 1;
} finally {
  report.completedAt = new Date().toISOString();
  intentionalShutdown = true;
  if (context) await context.close().catch(() => undefined);
  await fs.mkdir(options.outputDir, { recursive: true });
  reportPath = path.join(options.outputDir, `extension-diagnostic-${fileTimestamp()}.json`);
  const safeReport = sanitizeForReport(report);
  await fs.writeFile(reportPath, `${JSON.stringify(safeReport, null, 2)}\n`, "utf8");
  process.stdout.write(`${formatSummary(safeReport, reportPath)}\n`);
}

function parseArgs(args) {
  const parsed = {
    headed: false,
    help: false,
    apiKeyFile: "",
    auditGuangzhouNdvi: false,
    liveGuangzhouNdvi: false,
    mockTodoRecovery: false,
    waitMs: DEFAULT_WAIT_MS,
    outputDir: DEFAULT_OUTPUT_DIR,
    profileDir: ""
  };
  for (const arg of args) {
    if (arg === "--headed") parsed.headed = true;
    else if (arg === "--audit-guangzhou-ndvi") parsed.auditGuangzhouNdvi = true;
    else if (arg === "--live-guangzhou-ndvi") parsed.liveGuangzhouNdvi = true;
    else if (arg === "--mock-todo-recovery") parsed.mockTodoRecovery = true;
    else if (arg === "--help" || arg === "-h") parsed.help = true;
    else if (arg.startsWith("--wait-ms=")) {
      parsed.waitMs = boundedInteger(arg.slice("--wait-ms=".length), DEFAULT_WAIT_MS, 0, MAX_WAIT_MS);
    } else if (arg.startsWith("--output-dir=")) {
      parsed.outputDir = path.resolve(EXTENSION_DIR, arg.slice("--output-dir=".length));
    } else if (arg.startsWith("--profile-dir=")) {
      parsed.profileDir = path.resolve(EXTENSION_DIR, arg.slice("--profile-dir=".length));
    } else if (arg.startsWith("--api-key-file=")) {
      parsed.apiKeyFile = path.resolve(EXTENSION_DIR, arg.slice("--api-key-file=".length));
    } else {
      throw new TypeError(`未知参数：${arg}`);
    }
  }
  if ([parsed.mockTodoRecovery, parsed.liveGuangzhouNdvi, parsed.auditGuangzhouNdvi].filter(Boolean).length > 1) {
    throw new TypeError("mock、真实任务与现有方案审计模式不能同时使用");
  }
  if (!parsed.profileDir) {
    const scenarioProfile = parsed.liveGuangzhouNdvi || parsed.auditGuangzhouNdvi
      ? "diagnostic-profile-live-guangzhou-ndvi"
      : (parsed.mockTodoRecovery ? "diagnostic-profile-mock-todo-recovery" : "diagnostic-profile-boot");
    parsed.profileDir = path.join(EXTENSION_DIR, ".playwright", scenarioProfile);
  }
  return parsed;
}

function printHelp() {
  process.stdout.write([
    "GEE AI Assistant Playwright 诊断器",
    "",
    "用法：npm run diagnose:extension -- [选项]",
    "",
    "选项：",
    "  --headed             显示隔离 Chromium，便于手动复现",
    "  --mock-todo-recovery  本地模拟两次非法 TODO，验证自动修复与兜底",
    "  --live-guangzhou-ndvi 使用真实模型设计广州 2010–2025 年 NDVI 方案",
    "  --audit-guangzhou-ndvi 只审计已保存的广州方案，不读取密钥或调用 API",
    "  --api-key-file=PATH   从本地文件读取密钥；否则读取 DEEPSEEK_API_KEY",
    "  --wait-ms=N           收集日志的等待时间，默认 4000，最大 600000",
    "  --profile-dir=PATH    隔离浏览器配置目录",
    "  --output-dir=PATH     JSON 报告和截图目录",
    "  --help                显示帮助",
    "",
    "普通诊断不会读取 apiKey、OAuth token、Cookie 或完整候选代码。",
    "真实方案测试只在内存与 chrome.storage.session 中暂存密钥，报告会强制脱敏。"
  ].join("\n"));
}

function installMockRoutes(browserContext, currentReport) {
  currentReport.scenario = {
    name: "mock_todo_recovery",
    startedAtMs: Date.now(),
    apiCalls: 0,
    status: "configured",
    finalStatus: "",
    passed: false
  };
  browserContext.route("https://api.deepseek.com/**", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    currentReport.scenario.apiCalls += 1;
    const taskCount = currentReport.scenario.apiCalls === 1 ? 2 : 3;
    const content = createMockTodoPlan(taskCount);
    pushEvent(
      currentReport.events,
      "mock_api",
      "response",
      `返回 ${taskCount} 项 TODO 的本地 SSE 响应（第 ${currentReport.scenario.apiCalls} 次）`,
      "info"
    );
    await route.fulfill({
      status: 200,
      contentType: "text/event-stream; charset=utf-8",
      headers: { "cache-control": "no-store" },
      body: createMockSse(content, 11)
    });
  });
  browserContext.route("https://developers.google.com/earth-engine/**", async (route) => {
    const url = new URL(route.request().url());
    let body;
    if (/\/earth-engine\/datasets\/catalog\/?$/.test(url.pathname)) body = createMockDatasetIndex();
    else if (/\/earth-engine\/apidocs\/?$/.test(url.pathname)) body = createMockDocsIndex();
    else body = createMockOfficialDetail(url.pathname);
    await route.fulfill({
      status: 200,
      contentType: "text/html; charset=utf-8",
      headers: { "cache-control": "no-store" },
      body
    });
  });
}

async function runMockTodoRecovery(page, currentReport) {
  currentReport.scenario.status = "running";
  await resetConversation(page);
  await page.evaluate(async () => {
    await new Promise((resolve) => chrome.storage.local.remove([
      "activePlanV1",
      "chatHistoryV1",
      "codeCandidateV1",
      "messageQueueV1",
      "reasoningSessionV1"
    ], resolve));
    await new Promise((resolve) => chrome.storage.local.remove("apiKey", resolve));
    await new Promise((resolve) => chrome.storage.session.set({
      apiKey: "playwright-diagnostic-placeholder-key"
    }, resolve));
    await new Promise((resolve) => chrome.runtime.sendMessage({
      type: "SETTINGS_SAVE",
      payload: {
        baseUrl: "https://api.deepseek.com",
        model: "deepseek-v4-flash",
        projectId: "",
        geeClientId: "",
        apiKey: "",
        rememberApiKey: false,
        thinkingEnabled: true,
        reasoningEffort: "high",
        compatibleStreaming: false
      }
    }, resolve));
  });
  const settingsClose = page.locator("#closeSettingsButton");
  if (await settingsClose.isVisible()) await settingsClose.click();
  await page.locator("#planModeButton").click();
  await page.locator("#prompt").fill("Playwright 本地诊断：验证 TODO 数量本地校正");
  await page.locator("#sendButton").click();
  currentReport.scenario.finalStatus = await waitForPlanTurnCompletion(page, 75_000);
  const snapshot = await readSidepanelSnapshot(page);
  currentReport.scenario.historyAudit = await auditHistoryWindow(page);
  currentReport.scenario.passed = currentReport.scenario.apiCalls === 2
    && /等待需求澄清/.test(currentReport.scenario.finalStatus)
    && /本地完成结构校正/.test(snapshot.conversation)
    && /模拟任务 1/.test(snapshot.plan)
    && snapshot.timelineLiveCardCount === 0
    && snapshot.liveWorkspaceOrder.join(",") === "reasoningStreamSlot,reasoningControl,toolResults,planPanel,candidatePanel"
    && currentReport.scenario.historyAudit.passed;
  currentReport.scenario.status = currentReport.scenario.passed ? "passed" : "failed";
}

async function runLiveGuangzhouNdvi(page, currentReport) {
  const credential = await loadLiveApiKey();
  runtimeSecretValues.push(credential.apiKey);
  currentReport.scenario = {
    name: "live_guangzhou_ndvi_plan",
    startedAtMs: Date.now(),
    task: GUANGZHOU_NDVI_PROMPT,
    credentialSource: credential.source,
    status: "running",
    finalStatus: "",
    planStatus: "",
    todoCount: 0,
    questionCount: 0,
    datasetCount: 0,
    hasCandidateCode: false,
    passed: false
  };

  await preparePlanScenario(page, credential.apiKey);
  await page.locator("#prompt").fill(GUANGZHOU_NDVI_PROMPT);
  await page.locator("#sendButton").click();
  currentReport.scenario.finalStatus = await waitForPlanTurnCompletion(page, 8 * 60_000);

  const observed = await readStoredPlanObservation(page);
  Object.assign(currentReport.scenario, observed);
  currentReport.scenario.passed = /等待需求澄清|方案待审阅/.test(currentReport.scenario.finalStatus)
    && currentReport.scenario.todoCount >= 4
    && currentReport.scenario.todoCount <= 8
    && !currentReport.scenario.hasCandidateCode;
  currentReport.scenario.status = currentReport.scenario.passed ? "passed" : "failed";
}

async function auditExistingGuangzhouNdvi(page, currentReport) {
  const settingsClose = page.locator("#closeSettingsButton");
  if (await settingsClose.isVisible()) await settingsClose.click();
  const planPanel = page.locator("#planPanel");
  if (await planPanel.isVisible()) await planPanel.scrollIntoViewIfNeeded();
  const observed = await readStoredPlanObservation(page);
  const sidepanel = await readSidepanelSnapshot(page);
  currentReport.scenario = {
    name: "audit_guangzhou_ndvi_plan",
    startedAtMs: Date.now(),
    task: GUANGZHOU_NDVI_PROMPT,
    credentialSource: "not_accessed",
    status: "failed",
    finalStatus: sidepanel.status,
    ...observed,
    passed: /clarifying|reviewing/.test(observed.planStatus)
      && observed.todoCount >= 4
      && observed.todoCount <= 8
      && !observed.hasCandidateCode
  };
  currentReport.scenario.status = currentReport.scenario.passed ? "passed" : "failed";
}

async function readStoredPlanObservation(page) {
  return page.evaluate(async () => {
    const stored = await new Promise((resolve) => chrome.storage.local.get([
      "activePlanV1",
      "codeCandidateV1"
    ], resolve));
    const session = stored.activePlanV1 || {};
    const plan = session.plan || session;
    return {
      planStatus: String(session.state || plan.status || ""),
      todoCount: Array.isArray(plan.todoList) ? plan.todoList.length : 0,
      questionCount: Array.isArray(plan.questions) ? plan.questions.length : 0,
      datasetCount: Array.isArray(plan.datasets) ? plan.datasets.length : 0,
      hasCandidateCode: Boolean(stored.codeCandidateV1)
    };
  });
}

async function preparePlanScenario(page, apiKey) {
  await resetConversation(page);
  await page.evaluate(async ({ transientApiKey }) => {
    await new Promise((resolve) => chrome.storage.local.remove([
      "activePlanV1",
      "chatHistoryV1",
      "codeCandidateV1",
      "messageQueueV1",
      "reasoningSessionV1"
    ], resolve));
    await new Promise((resolve) => chrome.storage.local.remove("apiKey", resolve));
    await new Promise((resolve) => chrome.storage.session.set({ apiKey: transientApiKey }, resolve));
    await new Promise((resolve) => chrome.runtime.sendMessage({
      type: "SETTINGS_SAVE",
      payload: {
        baseUrl: "https://api.deepseek.com",
        model: "deepseek-v4-flash",
        projectId: "",
        geeClientId: "",
        apiKey: "",
        rememberApiKey: false,
        thinkingEnabled: true,
        reasoningEffort: "high",
        compatibleStreaming: false
      }
    }, resolve));
  }, { transientApiKey: apiKey });
  const settingsClose = page.locator("#closeSettingsButton");
  if (await settingsClose.isVisible()) await settingsClose.click();
  await page.locator("#planModeButton").click();
}

async function resetConversation(page) {
  const acceptDialog = (dialog) => dialog.accept().catch(() => undefined);
  page.on("dialog", acceptDialog);
  try {
    await page.locator("#clearChatButton").click();
    await page.waitForFunction(() => document.querySelector("#statusText")?.textContent?.includes("新对话已就绪"), null, {
      timeout: 10_000
    });
  } finally {
    page.off("dialog", acceptDialog);
  }
}

async function loadLiveApiKey() {
  if (options.apiKeyFile) {
    const fileContents = await fs.readFile(options.apiKeyFile, "utf8");
    return { apiKey: extractApiKey(fileContents), source: "local_file" };
  }
  return {
    apiKey: validateApiKey(process.env.DEEPSEEK_API_KEY || ""),
    source: "environment"
  };
}

function extractApiKey(contents) {
  const text = String(contents || "").trim();
  if (!text) throw new Error("本地密钥文件为空");
  try {
    const parsed = JSON.parse(text);
    const candidate = parsed?.DEEPSEEK_API_KEY || parsed?.deepseekApiKey || parsed?.apiKey;
    if (candidate) return validateApiKey(candidate);
  } catch {
    // 继续兼容 .env 和纯文本格式。
  }
  const envLine = text.split(/\r?\n/).find((line) => (
    /^(?:export\s+)?(?:DEEPSEEK_API_KEY|API_KEY)\s*=/.test(line.trim())
  ));
  if (envLine) {
    const value = envLine.slice(envLine.indexOf("=") + 1).trim().replace(/^(['"])(.*)\1$/, "$2");
    return validateApiKey(value);
  }
  return validateApiKey(text.split(/\r?\n/).find((line) => line.trim()) || "");
}

function validateApiKey(value) {
  const normalized = String(value || "").trim();
  if (normalized.length < 16 || normalized.length > 512 || /\s/.test(normalized)) {
    throw new Error("DeepSeek API Key 缺失或格式无效");
  }
  return normalized;
}

async function waitForPlanTurnCompletion(page, timeoutMs) {
  const started = Date.now();
  let stableSignature = "";
  let stableReads = 0;
  while (Date.now() - started < timeoutMs) {
    const observation = await page.evaluate(async () => {
      const status = document.querySelector("#statusText")?.textContent?.trim() || "";
      const turnState = document.querySelector("#turnStateBadge")?.textContent?.trim() || "";
      const stored = await new Promise((resolve) => chrome.storage.local.get("activePlanV1", resolve));
      const session = stored.activePlanV1 || {};
      return {
        status,
        turnState,
        planRevision: Number(session.planRevision || 0),
        planState: String(session.state || ""),
        todoCount: Array.isArray(session.plan?.todoList) ? session.plan.todoList.length : 0
      };
    }).catch(() => ({ status: "", turnState: "", planRevision: 0, planState: "", todoCount: 0 }));
    const failed = /计划请求失败|请求失败/.test(observation.status);
    const succeeded = /等待需求澄清|方案待审阅/.test(observation.status)
      && /clarifying|ready/.test(observation.planState)
      && observation.planRevision > 0
      && observation.todoCount >= 4;
    if (observation.turnState === "就绪" && (failed || succeeded)) {
      const signature = JSON.stringify(observation);
      stableReads = signature === stableSignature ? stableReads + 1 : 1;
      stableSignature = signature;
      if (stableReads >= 2) return observation.status;
    } else {
      stableReads = 0;
      stableSignature = "";
    }
    await page.waitForTimeout(250);
  }
  throw new Error(`模拟计划请求在 ${timeoutMs}ms 内没有结束`);
}

async function auditHistoryWindow(page) {
  const originalHistory = await page.evaluate(async () => {
    const stored = await new Promise((resolve) => chrome.storage.local.get("chatHistoryV1", resolve));
    const original = Array.isArray(stored.chatHistoryV1) ? stored.chatHistoryV1 : [];
    const baseTime = Date.now() - 75_000;
    const synthetic = Array.from({ length: 75 }, (_, index) => ({
      schemaVersion: 1,
      id: `history-audit-${index}`,
      role: index % 2 === 0 ? "user" : "assistant",
      purpose: "direct",
      text: `历史性能测试 ${index} ${"x".repeat(2000)}`,
      createdAt: baseTime + index
    }));
    await new Promise((resolve) => chrome.storage.local.set({ chatHistoryV1: synthetic }, resolve));
    return original;
  });

  try {
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.locator("#conversationTimeline").waitFor({ state: "attached" });
    await page.waitForFunction(() => (
      document.querySelector("#sendButton")?.disabled === false
      && document.querySelector("#turnStateBadge")?.textContent?.trim() === "就绪"
    ));
    await page.waitForFunction(() => document.querySelectorAll("#conversationTimeline [data-chat-id]").length === 30);
    const initial = await page.evaluate(() => ({
      count: document.querySelectorAll("#conversationTimeline [data-chat-id]").length,
      firstId: document.querySelector("#conversationTimeline [data-chat-id]")?.dataset.chatId || "",
      loaderVisible: !document.querySelector("#historyLoadOlderButton")?.classList.contains("hidden"),
      timelineLiveCardCount: document.querySelectorAll("#conversationTimeline #reasoningControl, #conversationTimeline #toolResults, #conversationTimeline #planPanel, #conversationTimeline #candidatePanel").length
    }));
    await page.evaluate(() => { document.querySelector("#conversation").scrollTop = 200; });
    const beforeTop = await page.locator("#conversation").evaluate((element) => element.scrollTop);
    await page.evaluate(() => document.querySelector("#historyLoadOlderButton")?.click());
    await page.waitForFunction(() => document.querySelectorAll("#conversationTimeline [data-chat-id]").length === 60);
    await page.waitForTimeout(100);
    const expanded = await page.evaluate(() => ({
      count: document.querySelectorAll("#conversationTimeline [data-chat-id]").length,
      firstId: document.querySelector("#conversationTimeline [data-chat-id]")?.dataset.chatId || "",
      scrollTop: document.querySelector("#conversation")?.scrollTop || 0
    }));
    const narrowLayout = await auditNarrowTimelineLayout(page);
    return {
      passed: initial.count === 30
        && initial.firstId === "history-audit-45"
        && initial.loaderVisible
        && initial.timelineLiveCardCount === 0
        && expanded.count === 60
        && expanded.firstId === "history-audit-15"
        && expanded.scrollTop >= beforeTop
        && narrowLayout.passed,
      initial,
      expanded,
      beforeTop,
      narrowLayout
    };
  } finally {
    await page.evaluate(async (history) => {
      await new Promise((resolve) => chrome.storage.local.set({ chatHistoryV1: history }, resolve));
    }, originalHistory);
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.locator("#conversationTimeline").waitFor({ state: "attached" });
    await page.waitForFunction(() => document.querySelector("#sendButton")?.disabled === false);
  }
}

async function auditNarrowTimelineLayout(page) {
  return page.evaluate(async () => {
    const conversation = document.querySelector("#conversation");
    const lastMessage = document.querySelector("#conversationTimeline [data-chat-id]:last-of-type");
    const candidate = document.querySelector("#candidatePanel");
    const diff = document.querySelector("#diffView");
    if (!conversation || !lastMessage || !candidate || !diff) {
      return { passed: false, reason: "layout probe elements unavailable" };
    }
    candidate.classList.remove("hidden");
    diff.textContent = Array.from(
      { length: 80 },
      (_, index) => `${index + 1}: var syntheticLongLine = ee.ImageCollection('SYNTHETIC/LONG/DATASET/IDENTIFIER');`
    ).join("\n");
    conversation.scrollTop = conversation.scrollHeight;
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const messageRect = lastMessage.getBoundingClientRect();
    const candidateRect = candidate.getBoundingClientRect();
    const overlap = Math.max(0, messageRect.bottom - candidateRect.top);
    const contentVisibility = getComputedStyle(lastMessage).contentVisibility;
    const horizontalOverflow = conversation.scrollWidth > conversation.clientWidth + 1;
    return {
      passed: window.innerWidth <= 480
        && contentVisibility === "visible"
        && overlap <= 1
        && !horizontalOverflow,
      viewportWidth: window.innerWidth,
      contentVisibility,
      messageBottom: Math.round(messageRect.bottom),
      candidateTop: Math.round(candidateRect.top),
      overlap: Math.round(overlap),
      horizontalOverflow,
      conversationClientWidth: conversation.clientWidth,
      conversationScrollWidth: conversation.scrollWidth
    };
  });
}

function createMockTodoPlan(taskCount) {
  const todoList = Array.from({ length: taskCount }, (_, index) => ({
    id: `todo_${index + 1}`,
    title: `模拟任务 ${index + 1}`,
    objective: `完成第 ${index + 1} 项模拟规划任务`,
    evidenceNeeded: [index === 0 ? "模拟用户需求" : "模拟官方资料"],
    status: index === 0 ? "in_progress" : "pending",
    result: ""
  }));
  return JSON.stringify({
    status: "needs_clarification",
    phase: "clarifying",
    todoList,
    completedThisTurn: [],
    currentTodoId: "todo_1",
    nextTodoId: taskCount > 1 ? "todo_2" : "",
    goal: "验证 TODO 数量恢复流程",
    researchSummary: "本地模拟响应，不包含真实研究结论。",
    datasets: [],
    requirements: {
      area: "",
      timeRange: "",
      temporalAggregation: "",
      spatialStatistic: "",
      qualityControl: ""
    },
    method: [],
    outputs: [],
    assumptions: [],
    risks: [],
    revisionSummary: [],
    questions: [{
      id: "mock_question",
      prompt: "是否继续本地模拟流程？",
      options: [
        { id: "continue", label: "继续", description: "继续模拟", recommended: true },
        { id: "stop", label: "停止", description: "停止模拟", recommended: false }
      ],
      allowFreeText: true
    }]
  });
}

function createMockSse(content, totalTokens) {
  const events = [
    { choices: [{ delta: { reasoning_content: "本地结构诊断" }, finish_reason: null }] },
    { choices: [{ delta: { content }, finish_reason: null }] },
    {
      choices: [{ delta: {}, finish_reason: "stop" }],
      usage: { prompt_tokens: 5, completion_tokens: totalTokens - 5, total_tokens: totalTokens }
    }
  ];
  return `${events.map((event) => `data: ${JSON.stringify(event)}`).join("\n\n")}\n\ndata: [DONE]\n\n`;
}

function createMockDatasetIndex() {
  const items = Array.from({ length: 120 }, (_, index) => (
    `<li><a href="/earth-engine/datasets/catalog/MOCK_NDVI_${index}">Mock NDVI Dataset ${index}</a>`
      + `<p>Official diagnostic fixture for vegetation index ${index}</p></li>`
  ));
  return `<html><body><ul>${items.join("")}</ul></body></html>`;
}

function createMockDocsIndex() {
  const items = Array.from({ length: 40 }, (_, index) => (
    `<a href="/earth-engine/apidocs/mock-ndvi-method-${index}">Mock NDVI Method ${index}</a>`
  ));
  return `<html><body>${items.join("")}</body></html>`;
}

function createMockOfficialDetail(pathname) {
  return [
    "<html><head><title>Mock Earth Engine Reference</title></head><body><main>",
    `<h1>${pathname}</h1>`,
    "<p>Local Playwright diagnostic fixture for NDVI coverage, bands, quality control and reduceRegion.</p>",
    "</main></body></html>"
  ].join("");
}

function attachContextDiagnostics(browserContext, events) {
  browserContext.on("weberror", (webError) => {
    const pageUrl = webError.page()?.url() || "";
    pushEvent(events, pageUrl || "browser", "weberror", webError.error()?.message || String(webError.error()), "error");
  });
  browserContext.on("requestfailed", (request) => {
    if (!isRelevantUrl(request.url())) return;
    const failureText = request.failure()?.errorText || "request failed";
    const level = /ERR_ABORTED/i.test(failureText)
      ? "info"
      : (/^https:\/\/developers\.google\.com\/earth-engine/i.test(request.url()) ? "warning" : "error");
    pushEvent(
      events,
      request.url(),
      "requestfailed",
      `${request.method()} ${failureText}`,
      level
    );
  });
  browserContext.on("response", (response) => {
    if (response.status() < 400 || !isRelevantUrl(response.url())) return;
    const level = /^https:\/\/developers\.google\.com\/earth-engine/i.test(response.url())
      ? "warning"
      : "error";
    pushEvent(events, response.url(), "http_error", `HTTP ${response.status()} ${response.request().method()}`, level);
  });
  browserContext.on("serviceworker", (worker) => attachWorkerDiagnostics(worker, events));
}

function attachWorkerDiagnostics(worker, events) {
  if (ATTACHED_WORKERS.has(worker)) return;
  ATTACHED_WORKERS.add(worker);
  worker.on("console", (message) => {
    pushEvent(events, "service_worker", `console.${message.type()}`, message.text(), normalizeLevel(message.type()));
  });
  worker.on("close", () => {
    if (intentionalShutdown) return;
    pushEvent(events, "service_worker", "closed", "MV3 Service Worker 已停止或重启", "info");
  });
}

function attachPageDiagnostics(page, scope, events) {
  page.on("console", (message) => {
    const location = message.location();
    const suffix = location?.url ? ` (${location.url}:${location.lineNumber || 0})` : "";
    pushEvent(events, scope, `console.${message.type()}`, `${message.text()}${suffix}`, normalizeLevel(message.type()));
  });
  page.on("pageerror", (error) => {
    pushEvent(events, scope, "pageerror", error?.stack || error?.message || String(error), "error");
  });
  page.on("crash", () => {
    pushEvent(events, scope, "crash", "页面渲染进程崩溃", "error");
  });
}

async function navigateWithDiagnostics(page, url, scope, events) {
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45_000 });
  } catch (error) {
    pushEvent(events, scope, "navigation_error", error.message, "error");
  }
}

async function readExtensionIdentity(page) {
  return page.evaluate(async () => {
    const manifest = chrome.runtime.getManifest();
    const response = await new Promise((resolve) => {
      chrome.runtime.sendMessage({ type: "SETTINGS_GET" }, resolve);
    });
    const settings = response?.settings || {};
    return {
      name: manifest.name,
      version: manifest.version,
      runtimeId: chrome.runtime.id,
      settings: {
        baseUrl: settings.baseUrl || "",
        model: settings.model || "",
        projectConfigured: Boolean(settings.projectId),
        geeClientConfigured: Boolean(settings.geeClientId),
        rememberApiKey: Boolean(settings.rememberApiKey),
        thinkingEnabled: settings.thinkingEnabled !== false,
        reasoningEffort: settings.reasoningEffort || "",
        compatibleStreaming: Boolean(settings.compatibleStreaming),
        hasApiKey: Boolean(settings.hasApiKey),
        supportsThinking: Boolean(settings.supportsThinking)
      }
    };
  });
}

async function readSidepanelSnapshot(page) {
  return page.evaluate(() => {
    const text = (selector) => document.querySelector(selector)?.textContent?.trim() || "";
    const visible = (selector) => {
      const element = document.querySelector(selector);
      return Boolean(element && !element.classList.contains("hidden"));
    };
    return {
      url: location.href,
      title: document.title,
      status: text("#statusText"),
      connection: text("#connectionBadge"),
      turnState: text("#turnStateBadge"),
      keyStatus: text("#keyStatus"),
      conversation: text("#conversation").slice(-30_000),
      renderedChatCount: document.querySelectorAll("#conversationTimeline [data-chat-id]").length,
      hasHistoryLoader: visible("#historyLoadOlderButton"),
      timelineLiveCardCount: document.querySelectorAll("#conversationTimeline #reasoningControl, #conversationTimeline #toolResults, #conversationTimeline #planPanel, #conversationTimeline #candidatePanel").length,
      liveWorkspaceOrder: [...document.querySelectorAll("#liveWorkspace > [id]")].map((element) => element.id),
      planVisible: visible("#planPanel"),
      plan: text("#planPanel").slice(-20_000),
      candidateVisible: visible("#candidatePanel"),
      candidateValidation: text("#candidateValidation").slice(-5_000),
      toolWarnings: text("#toolWarnings").slice(-5_000),
      bodyTail: document.body.innerText.slice(-30_000)
    };
  });
}

async function readSafeStoredRecords(page) {
  return page.evaluate(async (keys) => {
    const stored = await new Promise((resolve) => chrome.storage.local.get(keys, resolve));
    const chat = Array.isArray(stored.chatHistoryV1) ? stored.chatHistoryV1 : [];
    return {
      activePlanV1: stored.activePlanV1 || null,
      messageQueueV1: stored.messageQueueV1 || null,
      reasoningSessionV1: stored.reasoningSessionV1 || null,
      recentChat: chat.slice(-30),
      recentErrors: chat.filter((entry) => entry?.role === "error").slice(-10)
    };
  }, SAFE_STORAGE_KEYS);
}

async function readGeePageSnapshot(page) {
  return page.evaluate(() => ({
    url: location.href,
    title: document.title,
    signedInEditorVisible: Boolean(document.querySelector(".ace_editor")),
    quotaRestricted: /exceeded its noncommercial compute quota|restricted mode/i.test(document.body.innerText),
    visibleText: document.body.innerText.slice(0, 20_000)
  }));
}

function buildFindings(currentReport) {
  const findings = [];
  const errorEvents = currentReport.events.filter((event) => event.level === "error");
  if (currentReport.sidepanel?.timelineLiveCardCount > 0) {
    findings.push({
      severity: "error",
      code: "timeline_contains_live_cards",
      summary: "实时状态卡被插入了历史消息时间线"
    });
  }
  if (errorEvents.length) {
    findings.push({
      severity: "error",
      code: "runtime_errors",
      summary: `捕获到 ${errorEvents.length} 条页面、网络或 Service Worker 错误`,
      evidence: errorEvents.slice(-10)
    });
  }
  const scenarioStartedAt = Number(currentReport.scenario?.startedAtMs || 0);
  const storedErrors = (currentReport.storedRecords?.recentErrors || []).filter((entry) => (
    !scenarioStartedAt || Number(entry?.createdAt || 0) >= scenarioStartedAt
  ));
  if (storedErrors.length) {
    findings.push({
      severity: "error",
      code: "stored_chat_errors",
      summary: `扩展本地记录中有 ${storedErrors.length} 条最近错误`,
      evidence: storedErrors
    });
  }
  if (currentReport.geePage?.quotaRestricted) {
    findings.push({
      severity: "warning",
      code: "gee_quota_restricted",
      summary: "Earth Engine 项目已超过非商业计算配额并进入受限模式"
    });
  }
  if (currentReport.geePage && !currentReport.geePage.signedInEditorVisible) {
    findings.push({
      severity: "warning",
      code: "gee_editor_unavailable",
      summary: `隔离浏览器未进入已登录的 GEE Code Editor：${currentReport.geePage.url}`
    });
  }
  const statusText = `${currentReport.sidepanel?.status || ""} ${currentReport.sidepanel?.conversation || ""}`;
  if (/TODO 任务数量必须为 4.?8 项/i.test(statusText)) {
    findings.push({
      severity: "error",
      code: "todo_count_validation",
      summary: "计划输出的 TODO 数量未通过 4–8 项结构校验"
    });
  }
  if (currentReport.scenario?.name === "mock_todo_recovery") {
    findings.push(currentReport.scenario.passed
      ? {
        severity: "info",
        code: "todo_recovery_passed",
        summary: "工具调研与 JSON 综合已分离，非法 TODO 数量已在本地校正为 4 项"
      }
      : {
        severity: "error",
        code: "todo_recovery_failed",
        summary: `TODO 恢复场景未通过：API 调用 ${currentReport.scenario.apiCalls} 次，状态 ${currentReport.scenario.finalStatus || currentReport.scenario.status}`
      });
    findings.push(currentReport.scenario.historyAudit?.passed
      ? {
        severity: "info",
        code: "history_window_passed",
        summary: "460px 窄侧栏中，75 条长历史分页、滚动锚点及实时卡片边界均保持稳定"
      }
      : {
        severity: "error",
        code: "history_window_failed",
        summary: "长历史分页、时间线隔离或滚动锚点检查未通过"
      });
  }
  if (currentReport.scenario?.name === "live_guangzhou_ndvi_plan") {
    findings.push(currentReport.scenario.passed
      ? {
        severity: "info",
        code: "guangzhou_ndvi_plan_passed",
        summary: `真实模型已生成广州 2010–2025 年 NDVI 方案：${currentReport.scenario.todoCount} 项 TODO、${currentReport.scenario.datasetCount} 个候选数据集、${currentReport.scenario.questionCount} 个澄清问题`
      }
      : {
        severity: "error",
        code: "guangzhou_ndvi_plan_failed",
        summary: `广州 NDVI 方案测试未通过：状态 ${currentReport.scenario.finalStatus || currentReport.scenario.status}，TODO ${currentReport.scenario.todoCount} 项`
      });
  }
  if (currentReport.scenario?.name === "audit_guangzhou_ndvi_plan") {
    findings.push(currentReport.scenario.passed
      ? {
        severity: "info",
        code: "guangzhou_ndvi_plan_audit_passed",
        summary: `已保存的广州 NDVI 方案审计通过：${currentReport.scenario.todoCount} 项 TODO、${currentReport.scenario.datasetCount} 个候选数据集、${currentReport.scenario.questionCount} 个澄清问题，且尚未生成候选代码`
      }
      : {
        severity: "error",
        code: "guangzhou_ndvi_plan_audit_failed",
        summary: `已保存的广州 NDVI 方案审计未通过：状态 ${currentReport.scenario.planStatus || "缺失"}，TODO ${currentReport.scenario.todoCount} 项`
      });
  }
  if (!findings.length) {
    findings.push({
      severity: "info",
      code: "no_boot_errors",
      summary: "扩展启动、Service Worker 和侧边栏初始化未捕获阻断错误"
    });
  }
  return findings;
}

function pushEvent(events, scope, type, message, level = "info") {
  events.push({
    timestamp: new Date().toISOString(),
    scope: String(scope || "unknown"),
    type: String(type || "event"),
    level: normalizeLevel(level),
    message: String(message || "").slice(0, 20_000)
  });
}

function normalizeLevel(value) {
  return ["error", "warning", "warn"].includes(String(value))
    ? (String(value) === "error" ? "error" : "warning")
    : "info";
}

function isRelevantUrl(value) {
  return /^(?:chrome-extension:|https:\/\/(?:api\.deepseek\.com|code\.earthengine\.google\.com|earthengine\.googleapis\.com|developers\.google\.com\/earth-engine))/i.test(String(value || ""));
}

function sanitizeForReport(value) {
  const serialized = JSON.stringify(value);
  return JSON.parse(redactSecrets(serialized));
}

function redactSecrets(value) {
  let redacted = String(value);
  for (const secret of runtimeSecretValues) {
    if (secret) redacted = redacted.split(secret).join("[已隐藏 API Key]");
  }
  return redacted
    .replace(/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/gi, "[已隐藏私钥]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/gi, "Bearer [已隐藏令牌]")
    .replace(/\bsk-[A-Za-z0-9_-]{16,}\b/g, "[已隐藏 API Key]")
    .replace(/\bAIza[A-Za-z0-9_-]{20,}\b/g, "[已隐藏 Google API Key]")
    .replace(/([?&][A-Za-z0-9_.~-]{1,80}=)[^&\s"']+/g, "$1[已隐藏]")
    .replace(/([?&](?:key|api_key|access_token)=)[^&\s"']+/gi, "$1[已隐藏]")
    .replace(/("?(?:authorization|cookie|set-cookie)"?\s*:\s*")[^"]+/gi, "$1[已隐藏]");
}

async function installedPlaywrightVersion() {
  const packageJson = JSON.parse(await fs.readFile(path.join(EXTENSION_DIR, "node_modules", "playwright", "package.json"), "utf8"));
  return packageJson.version;
}

function formatSummary(safeReport, outputPath) {
  const lines = [
    `扩展诊断完成：${outputPath}`,
    `扩展：${safeReport.extension?.name || "未识别"} ${safeReport.extension?.version || ""}`.trim(),
    `事件：${safeReport.events.length}；结论：${safeReport.findings.length}`
  ];
  for (const finding of safeReport.findings) {
    lines.push(`- [${finding.severity}] ${finding.code}: ${finding.summary}`);
  }
  return lines.join("\n");
}

function boundedInteger(value, fallback, minimum, maximum) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(minimum, Math.min(maximum, Math.floor(parsed)));
}

function fileTimestamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

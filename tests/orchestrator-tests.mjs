import assert from "node:assert/strict";
import { createOrchestrator } from "../lib/orchestrator.js";

// Mock deps + chrome runtime for the orchestrator. The direct (non-streaming)
// request path is exercised by keeping supportsThinking false.
function createHarness({
  settingsOverride = {},
  editorState = null,
  streamAnswer = "流式回答",
  streamResponses = null,
  aiAnswer = "最终回答",
  aiAnswers = null,
  contextOptionsOverride = {},
  toolSearchResponse = null
} = {}) {
  const calls = {
    appended: [],
    statuses: [],
    busy: [],
    aiChats: [],
    candidates: [],
    composerModes: [],
    connects: [],
    portPosts: [],
    portDisconnects: [],
    toolSearches: []
  };
  const streamQueue = Array.isArray(streamResponses) ? [...streamResponses] : null;
  const aiQueue = Array.isArray(aiAnswers) ? [...aiAnswers] : null;
  const settings = {
    hasApiKey: true,
    apiKey: "sk-test",
    baseUrl: "https://api.deepseek.com",
    model: "deepseek-chat",
    supportsThinking: false,
    ...settingsOverride
  };
  const deps = {
    runtime: {
      lastError: null,
      async sendMessage(message) {
        if (message.type === "SETTINGS_GET") return { ok: true, settings };
        if (message.type === "TOOLS_SEARCH") {
          calls.toolSearches.push(message.payload);
          return toolSearchResponse || { ok: true, context: "", sources: [], warnings: [] };
        }
        if (message.type === "AI_CHAT") {
          calls.aiChats.push(message.payload);
          return {
            ok: true,
            content: aiQueue?.shift() ?? aiAnswer,
            finishReason: "stop",
            usage: { total_tokens: 7 }
          };
        }
        return { ok: true };
      },
      connect({ name } = {}) {
        calls.connects.push(name);
        const messageListeners = [];
        const port = {
          name,
          onMessage: { addListener: (listener) => messageListeners.push(listener) },
          onDisconnect: { addListener: () => {} },
          postMessage(message) {
            calls.portPosts.push(message);
            if (message?.type === "START") {
              const queuedResponse = streamQueue?.shift();
              queueMicrotask(() => {
                for (const listener of messageListeners) {
                  listener({
                    type: "DONE",
                    requestId: message.payload?.requestId,
                    content: streamAnswer,
                    usage: { total_tokens: 9 },
                    finishReason: "stop",
                    reasoningContent: "",
                    toolCalls: [],
                    ...(queuedResponse || {})
                  });
                }
              });
            }
          },
          disconnect() {
            calls.portDisconnects.push(name);
          }
        };
        return port;
      }
    },
    appendMessage: (role, text, options) => { calls.appended.push({ role, text, ...options }); },
    showCandidate: (code, state, planRevision, validation) => {
      calls.candidates.push({ code, state, planRevision, validation });
    },
    setBusy: (value) => { calls.busy.push(value); },
    setStatus: (text, state = "") => { calls.statuses.push({ text, state }); },
    showError: (error) => { calls.statuses.push({ text: String(error && error.message || error) }); },
    scrollConversationToEnd: () => {},
    updateScrollFollower: () => {},
    syncConversationEmptyState: () => {},
    readEditor: async () => editorState,
    openSettings: () => {},
    selectComposerMode: (planMode, options) => { calls.composerModes.push({ planMode, options }); },
    renderMessageQueue: () => {},
    renderPlan: () => {},
    persistMessageQueue: async () => {},
    persistActivePlan: async (plan) => plan ?? null,
    onSettingsLoaded: () => {},
    renderToolSources: () => {},
    setToolActivityState: () => {},
    completeToolActivity: () => {},
    hideToolResults: () => {},
    createConsoleContextSection: () => "",
    createReasoningView: () => ({ append() {}, complete() {}, remove() {} }),
    contextOptions: () => ({
      includeSelection: true,
      includeCode: true,
      includeConsole: false,
      datasetSearch: false,
      docsSearch: false,
      ...contextOptionsOverride
    }),
    requiresEditorContext: () => false,
    isNearScrollEnd: () => true,
    isInitialized: () => true,
    isBusy: () => false
  };
  return { deps, calls, orchestrator: createOrchestrator(deps) };
}

function lastAiChat(calls) {
  return calls.aiChats.at(-1);
}

function createTodoPlanAnswer(taskCount) {
  const todoList = Array.from({ length: taskCount }, (_, index) => ({
    id: `todo_${index + 1}`,
    title: `任务 ${index + 1}`,
    objective: `完成第 ${index + 1} 项可验证规划任务`,
    evidenceNeeded: [index === 0 ? "用户需求" : "前序结果与官方资料"],
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
    goal: "计算广州市 NDVI",
    researchSummary: "等待确认统计口径。",
    datasets: [],
    requirements: {
      area: "广州市",
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
      id: "time_range",
      prompt: "请选择分析时间范围。",
      options: [
        { id: "recent", label: "近五年", description: "分析最近五个完整年份", recommended: true },
        { id: "custom", label: "自定义", description: "由用户提供起止年份", recommended: false }
      ],
      allowFreeText: true
    }]
  });
}

// runDirectTurn assembles system + conversation window + user content.
{
  const editorState = { code: "var a = 1;", selection: "", consoleRead: { status: "empty" } };
  const { calls, orchestrator } = createHarness({ editorState });
  orchestrator.setDirectConversation([
    { role: "user", content: "上一轮问题" },
    { role: "assistant", content: "上一轮回答" }
  ]);

  await orchestrator.executePrompt("请修改脚本", false);

  assert.equal(calls.aiChats.length, 1);
  const payload = lastAiChat(calls);
  assert.equal(payload.purpose, "direct");
  assert.ok(payload.requestId);
  const messages = payload.messages;
  assert.equal(messages[0].role, "system");
  assert.match(messages[0].content, /Google Earth Engine JavaScript 专家/);
  assert.deepEqual(messages[1], { role: "user", content: "上一轮问题" });
  assert.deepEqual(messages[2], { role: "assistant", content: "上一轮回答" });
  const userMessage = messages.at(-1);
  assert.equal(userMessage.role, "user");
  assert.match(userMessage.content, /用户任务：\n请修改脚本/);
  assert.match(userMessage.content, /当前完整脚本：/);
  assert.match(userMessage.content, /var a = 1;/);

  // Conversation window: user turn first, assistant answer appended.
  assert.deepEqual(calls.appended.map((entry) => entry.role), ["user", "assistant"]);
  assert.equal(calls.appended[0].purpose, "direct");
  assert.deepEqual(orchestrator.getDirectConversation(), [
    { role: "user", content: "上一轮问题" },
    { role: "assistant", content: "上一轮回答" },
    { role: "user", content: "请修改脚本" },
    { role: "assistant", content: "最终回答" }
  ]);
  assert.deepEqual(calls.busy, [true, false]);
  assert.ok(calls.statuses.some((status) => status.text.includes("完成 · 7 tokens")));
  await orchestrator.recordObservedFailure("gee-console:deadbeef Layer error", "gee_console");
  assert.match(orchestrator.getReasoningSession().failures.at(-1).signature, /gee_console:gee-console:deadbeef/);
}

// A blocking deterministic preflight triggers exactly one diagnostic repair.
// The repaired candidate is the only version shown and the usage is summed.
{
  const { calls, orchestrator } = createHarness({
    aiAnswers: [
      "初稿：\n```javascript\nvar node = document.querySelector('body');\nMap.addLayer(node);\n```",
      "已修复：\n```javascript\nvar image = ee.Image('projects/demo/assets/image');\nMap.addLayer(image, {}, 'image');\n```"
    ]
  });
  await orchestrator.executePrompt("生成一段 GEE 代码", false);

  assert.equal(calls.aiChats.length, 2, "a failed preflight gets only one automatic repair request");
  assert.equal(calls.aiChats[1].purpose, "direct_repair");
  assert.match(calls.aiChats[1].messages.at(-1).content, /唯一一次自动修复/);
  assert.equal(calls.candidates.length, 1);
  assert.match(calls.candidates[0].code, /projects\/demo\/assets\/image/);
  assert.equal(calls.candidates[0].validation.status, "passed");
  assert.equal(calls.appended.find((entry) => entry.role === "assistant").text, "已修复：\n[代码见下方修改预览]");
  assert.ok(calls.statuses.some((status) => status.text.includes("完成 · 14 tokens")));
}

// Conversation window keeps at most 6 prior messages and stays user-aligned.
{
  const prior = [];
  for (let index = 0; index < 8; index += 1) {
    prior.push({ role: "user", content: `问题 ${index}` }, { role: "assistant", content: `回答 ${index}` });
  }
  const { calls, orchestrator } = createHarness();
  orchestrator.setDirectConversation(prior);
  await orchestrator.executePrompt("新问题", false);

  const payload = lastAiChat(calls);
  // system + last 6 prior messages + current user message
  assert.equal(payload.messages.length, 8);
  assert.deepEqual(payload.messages[1], { role: "user", content: "问题 5" });

  const conversation = orchestrator.getDirectConversation();
  assert.equal(conversation.length, 12, "window capped at 12 messages");
  assert.equal(conversation[0].role, "user", "alignConversationToUser keeps a user turn first");
}

// M3: the final slice(-6) can cut an already-aligned window mid-exchange; the
// sent window must be re-aligned so it never starts with an assistant turn.
// 11 stored messages (the shape left after aligning an assistant-first 12
// window) make slice(-6) start with an assistant answer.
{
  const prior = [];
  for (let index = 0; index < 5; index += 1) {
    prior.push({ role: "user", content: `问题 ${index}` }, { role: "assistant", content: `回答 ${index}` });
  }
  prior.push({ role: "user", content: "问题 5" });
  assert.equal(prior.length, 11);
  assert.equal(prior.slice(-6)[0].role, "assistant", "precondition: last 6 start assistant-first");

  const { calls, orchestrator } = createHarness();
  orchestrator.setDirectConversation(prior);
  await orchestrator.executePrompt("重新对齐", false);

  const payload = lastAiChat(calls);
  // system + re-aligned window (dropping the orphan assistant answer) + user
  assert.equal(payload.messages.length, 7);
  assert.equal(payload.messages[1].role, "user", "sent window must start with a user turn");
  assert.deepEqual(payload.messages[1], { role: "user", content: "问题 3" });
  assert.ok(
    payload.messages.slice(1, -1).every((message, index, window) => {
      const expected = index % 2 === 0 ? "user" : "assistant";
      return message.role === expected && (window.length === 5);
    }),
    "re-aligned window keeps complete user/assistant turns"
  );
}

// compatibleStreaming opt-in: a compatible endpoint routes through the
// streaming Port instead of the AI_CHAT one-shot message (M1).
{
  const { calls, orchestrator } = createHarness({
    settingsOverride: {
      baseUrl: "https://my-openai-compatible.example/v1",
      model: "generic-model",
      supportsThinking: false,
      compatibleStreaming: true
    }
  });
  await orchestrator.executePrompt("兼容流式", false);

  assert.equal(calls.aiChats.length, 0, "compatibleStreaming must bypass AI_CHAT");
  assert.deepEqual(calls.connects, ["AI_CHAT_STREAM"], "opt-in opens the stream Port");
  assert.equal(calls.portPosts.length, 1);
  assert.equal(calls.portPosts[0].type, "START");
  assert.equal(calls.portPosts[0].payload.purpose, "direct");
  const assistant = calls.appended.find((entry) => entry.role === "assistant" && entry.purpose === "direct");
  assert.equal(assistant.text, "流式回答");
  assert.deepEqual(orchestrator.getDirectConversation().at(-1), { role: "assistant", content: "流式回答" });
  assert.ok(calls.statuses.some((status) => status.text.includes("完成 · 9 tokens")));
}

// Opt-in off: the same compatible endpoint keeps the non-streaming AI_CHAT path.
{
  const { calls, orchestrator } = createHarness({
    settingsOverride: {
      baseUrl: "https://my-openai-compatible.example/v1",
      model: "generic-model",
      supportsThinking: false,
      compatibleStreaming: false
    }
  });
  await orchestrator.executePrompt("兼容非流式", false);
  assert.equal(calls.aiChats.length, 1, "opt-in off keeps AI_CHAT");
  assert.equal(calls.connects.length, 0, "opt-in off never opens the stream Port");
  assert.ok(calls.statuses.some((status) => status.text.includes("兼容模式")));
}

// Official V4 full/loop passes may request bounded read-only tools. The
// assistant reasoning/tool-call turn is replayed to the model in memory but
// only the final answer enters the durable conversation window.
{
  const source = {
    type: "dataset",
    title: "Sentinel-2 SR Harmonized",
    url: "https://developers.google.com/earth-engine/datasets/catalog/COPERNICUS_S2_SR_HARMONIZED"
  };
  const { calls, orchestrator } = createHarness({
    settingsOverride: {
      baseUrl: "https://api.deepseek.com/v1",
      model: "deepseek-v4-flash",
      supportsThinking: true
    },
    contextOptionsOverride: {
      includeSelection: false,
      includeCode: false,
      datasetSearch: true,
      docsSearch: false
    },
    toolSearchResponse: {
      ok: true,
      context: "COPERNICUS/S2_SR_HARMONIZED 官方目录快照",
      sources: [source],
      warnings: []
    },
    streamResponses: [
      {
        content: "",
        reasoningContent: "需要核验目录",
        toolCalls: [{
          id: "call_1",
          type: "function",
          function: {
            name: "search_gee_datasets",
            arguments: '{"query":"Sentinel-2 SR harmonized coverage bands"}'
          }
        }],
        finishReason: "tool_calls"
      },
      {
        content: "已根据官方目录完成核验。",
        reasoningContent: "核验完成",
        toolCalls: [],
        finishReason: "stop"
      }
    ]
  });

  await orchestrator.executePrompt("请核验 Sentinel-2 数据集和波段", false);

  assert.equal(calls.portPosts.length, 2, "one tool turn must lead to one follow-up model request");
  assert.deepEqual(
    calls.portPosts[0].payload.tools.map((tool) => tool.function.name),
    ["search_gee_datasets"]
  );
  const replayed = calls.portPosts[1].payload.messages;
  const assistantToolTurn = replayed.find((message) => message.role === "assistant" && message.tool_calls);
  assert.equal(assistantToolTurn.reasoning_content, "需要核验目录");
  assert.equal(replayed.find((message) => message.role === "tool").tool_call_id, "call_1");
  assert.equal(calls.toolSearches.length, 2, "initial retrieval plus model-targeted retrieval");
  assert.deepEqual(orchestrator.getDirectConversation().at(-1), {
    role: "assistant",
    content: "已根据官方目录完成核验。"
  });
  assert.equal(
    orchestrator.getDirectConversation().some((message) => "reasoning_content" in message),
    false,
    "reasoning_content must stay request-local"
  );
}

// Queue drain: messages execute in FIFO order and the queue empties.
{
  const { calls, orchestrator } = createHarness();
  orchestrator.enqueuePrompt("第一条", false);
  orchestrator.enqueuePrompt("第二条", false);
  assert.equal(orchestrator.getQueue().length, 2);

  await orchestrator.drainMessageQueue();
  await new Promise((resolve) => setTimeout(resolve, 10));

  assert.equal(calls.aiChats.length, 2);
  assert.equal(orchestrator.getQueue().length, 0);
  assert.equal(orchestrator.isQueuePaused(), false);
  assert.deepEqual(calls.composerModes.map((entry) => entry.planMode), [false, false]);
  const directTurns = calls.appended.filter((entry) => entry.role === "user");
  assert.deepEqual(directTurns.map((entry) => entry.text), ["第一条", "第二条"]);
  assert.ok(calls.statuses.some((status) => status.text.startsWith("正在发送队列消息")));
}

// Drain guards: paused queue and uninitialized panel never start a turn.
{
  const { calls, orchestrator } = createHarness();
  orchestrator.enqueuePrompt("不会发送", false);
  orchestrator.setQueuePaused(true);
  await orchestrator.drainMessageQueue();
  assert.equal(calls.aiChats.length, 0);
  assert.equal(orchestrator.getQueue().length, 1);
}
{
  const { deps, calls, orchestrator } = createHarness();
  deps.isInitialized = () => false;
  orchestrator.enqueuePrompt("不会发送", false);
  await orchestrator.drainMessageQueue();
  assert.equal(calls.aiChats.length, 0);
}

// Error path: a failed model request surfaces an error message + status.
{
  const { deps, calls, orchestrator } = createHarness();
  deps.runtime.sendMessage = async (message) => {
    if (message.type === "SETTINGS_GET") return { ok: true, settings: { hasApiKey: true, supportsThinking: false } };
    if (message.type === "TOOLS_SEARCH") return { ok: true, context: "", sources: [], warnings: [] };
    throw new Error("模型不可用");
  };
  await orchestrator.executePrompt("会失败", false);

  const errors = calls.appended.filter((entry) => entry.role === "error");
  assert.equal(errors.length, 1);
  assert.equal(errors[0].text, "模型不可用");
  assert.equal(errors[0].purpose, "direct");
  assert.ok(calls.statuses.some((status) => status.text.startsWith("请求失败：模型不可用") && status.state === "error"));
  assert.equal(orchestrator.isBusy(), false);
}

// Missing API key: requireSettings opens settings and aborts the turn.
{
  const { calls, orchestrator } = createHarness({ settingsOverride: { hasApiKey: false } });
  await orchestrator.executePrompt("缺少密钥", false);
  const errors = calls.appended.filter((entry) => entry.role === "error");
  assert.equal(errors.length, 1);
  assert.equal(errors[0].text, "请先在设置中填写 API Key");
}

// Editor context required but unavailable: direct turn aborts early.
{
  const { deps, calls, orchestrator } = createHarness({ editorState: null });
  deps.requiresEditorContext = () => true;
  await orchestrator.executePrompt("需要编辑器", false);
  assert.equal(calls.aiChats.length, 0);
  const errors = calls.appended.filter((entry) => entry.role === "error");
  assert.match(errors.at(-1).text, /无法连接 Earth Engine 编辑器/);
}

// stopRequest without an active request is a no-op.
{
  const { orchestrator } = createHarness();
  const result = orchestrator.stopRequest(() => assert.fail("abort must not be sent"));
  assert.equal(result.stopped, false);
}

// ISS-008: a plan response mixing a valid structured plan with a premature
// fenced code block must degrade gracefully — the plan is applied, the code
// is ignored (never shown as a candidate) and the user is notified.
{
  const mixedPlanAnswer = [
    "先给出方案草案：",
    "```json",
    '{"status":"needs_clarification","goal":"计算广州市 NDVI 均值","questions":["时间聚合采用哪种方式？"]}',
    "```",
    "也可以直接实现：",
    "```javascript",
    "var image = ee.Image('MODIS/061/MOD13Q1');",
    "Map.addLayer(image);",
    "```"
  ].join("\n");
  const { calls, orchestrator } = createHarness({ aiAnswer: mixedPlanAnswer });
  await orchestrator.executePrompt("计算广州市 NDVI 均值", true);

  assert.equal(calls.aiChats.at(-1).purpose, "plan_research");
  assert.equal(calls.candidates.length, 0, "premature plan-stage code must never become a candidate");
  const notice = calls.appended.find((entry) => entry.role === "assistant" && entry.purpose === "plan_action");
  assert.ok(notice, "user must be told the premature code was ignored");
  assert.match(notice.text, /计划阶段提前返回了代码，已忽略未应用/);
  const errors = calls.appended.filter((entry) => entry.role === "error");
  assert.equal(errors.length, 0, "a salvageable plan must not surface as an error");
  assert.equal(orchestrator.getActivePlan().state, "clarifying");
  assert.equal(orchestrator.getActivePlan().plan.questions[0].prompt, "时间聚合采用哪种方式？");
  assert.ok(calls.statuses.some((status) => status.text.startsWith("等待需求澄清")));
}

// Tool-bearing V4 research is followed by a separate no-tools JSON synthesis;
// prose from the tool phase never becomes the final plan payload.
{
  const { calls, orchestrator } = createHarness({
    settingsOverride: {
      baseUrl: "https://api.deepseek.com/v1",
      model: "deepseek-v4-flash",
      supportsThinking: true
    },
    streamResponses: [
      { content: "我已完成调研，下一步将整理为 JSON。" },
      { content: createTodoPlanAnswer(4) }
    ]
  });
  await orchestrator.executePrompt("设计广州 2010-2025 年 NDVI 方案", true);

  assert.deepEqual(
    calls.portPosts.map((entry) => entry.payload.purpose),
    ["plan_research", "plan_research_synthesis"]
  );
  assert.deepEqual(calls.portPosts[1].payload.tools, [], "JSON synthesis must run without tools");
  assert.equal(orchestrator.getActivePlan().plan.todoList.length, 4);
  assert.equal(orchestrator.getActivePlan().state, "clarifying");
  assert.equal(calls.appended.filter((entry) => entry.role === "error").length, 0);
}

// The no-tools synthesis prompt carries a bounded official-source snapshot so
// broad catalog searches cannot duplicate an unbounded amount of tool output.
{
  const oversizedSources = Array.from({ length: 25 }, (_, index) => ({
    type: "dataset",
    title: `Dataset ${index + 1}`,
    datasetId: `TEST/DATASET_${index + 1}`,
    url: `https://developers.google.com/earth-engine/datasets/catalog/TEST_DATASET_${index + 1}`,
    snippet: `snippet-${index + 1}-` + "s".repeat(900),
    summary: `summary-${index + 1}-` + "x".repeat(4000)
  }));
  const { calls, orchestrator } = createHarness({
    settingsOverride: {
      baseUrl: "https://api.deepseek.com/v1",
      model: "deepseek-v4-flash",
      supportsThinking: true
    },
    toolSearchResponse: {
      ok: true,
      context: "官方目录检索完成。",
      sources: oversizedSources,
      warnings: []
    },
    streamResponses: [
      { content: "工具阶段完成。" },
      { content: createTodoPlanAnswer(4) }
    ]
  });
  await orchestrator.executePrompt("设计广州 2010-2025 年 NDVI 方案", true);

  const synthesisPrompt = calls.portPosts[1].payload.messages.at(-1).content;
  assert.equal((synthesisPrompt.match(/\[DATASET \d+\]/g) || []).length, 20);
  assert.match(synthesisPrompt, /TEST\/DATASET_20/);
  assert.doesNotMatch(synthesisPrompt, /TEST\/DATASET_21/);
  assert.ok(synthesisPrompt.length < 45000, `bounded synthesis prompt was ${synthesisPrompt.length} chars`);
}

// If an unparseable answer remains invalid after the single no-tools repair,
// planning must continue with the deterministic local skeleton.
{
  const { calls, orchestrator } = createHarness({
    settingsOverride: {
      baseUrl: "https://api.deepseek.com/v1",
      model: "deepseek-v4-flash",
      supportsThinking: true
    },
    streamResponses: [
      { content: "工具阶段分析完成。" },
      { content: "尚未输出 JSON。" },
      { content: "修复后仍然不是 JSON。" }
    ]
  });
  await orchestrator.executePrompt("设计广州 2010-2025 年 NDVI 方案", true);

  assert.equal(calls.portPosts.length, 3, "unparseable recovery must add at most one repair after synthesis");
  assert.deepEqual(calls.portPosts[1].payload.tools, []);
  assert.deepEqual(calls.portPosts[2].payload.tools, []);
  const recovered = orchestrator.getActivePlan();
  assert.equal(recovered.plan.todoList.length, 4);
  assert.equal(recovered.plan.todoList[0].title, "确认分析目标与边界");
  assert.equal(recovered.state, "clarifying");
  assert.equal(calls.appended.filter((entry) => entry.role === "error").length, 0);
  assert.ok(calls.appended.some((entry) => entry.purpose === "plan_action" && /无法解析且自动结构修复仍未通过/.test(entry.text)));
}

// A currentTodoId that points at a pending task is repaired deterministically
// after strict synthesis without spending another model request.
{
  const pointerMismatch = JSON.parse(createTodoPlanAnswer(4));
  pointerMismatch.currentTodoId = "todo_2";
  const { calls, orchestrator } = createHarness({
    settingsOverride: {
      baseUrl: "https://api.deepseek.com/v1",
      model: "deepseek-v4-flash",
      supportsThinking: true
    },
    streamResponses: [
      { content: "工具阶段完成。" },
      { content: JSON.stringify(pointerMismatch) }
    ]
  });
  await orchestrator.executePrompt("计算广州市 2010-2025 年 NDVI", true);

  assert.deepEqual(
    calls.portPosts.map((entry) => entry.payload.purpose),
    ["plan_research", "plan_research_synthesis"]
  );
  assert.deepEqual(calls.portPosts[1].payload.tools, [], "synthesis must not expose tools");
  assert.equal(orchestrator.getActivePlan().plan.currentTodoId, "todo_1");
  assert.equal(orchestrator.getActivePlan().plan.todoList[0].status, "in_progress");
  assert.equal(calls.appended.filter((entry) => entry.role === "error").length, 0);
  assert.ok(calls.appended.some((entry) => entry.purpose === "plan_action" && /本地完成结构校正/.test(entry.text)));
}

// Repeated pointer mismatches no longer consume a model repair or discard the
// model's factual task content.
{
  const pointerMismatch = JSON.parse(createTodoPlanAnswer(4));
  pointerMismatch.currentTodoId = "todo_2";
  const invalidAnswer = JSON.stringify(pointerMismatch);
  const { calls, orchestrator } = createHarness({
    settingsOverride: {
      baseUrl: "https://api.deepseek.com/v1",
      model: "deepseek-v4-flash",
      supportsThinking: true
    },
    streamResponses: [
      { content: invalidAnswer },
      { content: invalidAnswer }
    ]
  });
  await orchestrator.executePrompt("计算广州市 2010-2025 年 NDVI", true);

  assert.equal(calls.portPosts.length, 2, "pointer recovery must never recurse");
  const recovered = orchestrator.getActivePlan();
  assert.equal(recovered.plan.todoList.length, 4);
  assert.equal(recovered.plan.todoList[0].title, "任务 1");
  assert.equal(recovered.plan.currentTodoId, "todo_1");
  assert.equal(calls.appended.filter((entry) => entry.role === "error").length, 0);
  assert.ok(calls.appended.some((entry) => entry.purpose === "plan_action" && /本地完成结构校正/.test(entry.text)));
}

// Too few TODOs are padded locally after the no-tools synthesis. Both model
// calls count toward usage, but no third structure-repair request is needed.
{
  const { calls, orchestrator } = createHarness({
    settingsOverride: {
      baseUrl: "https://api.deepseek.com/v1",
      model: "deepseek-v4-flash",
      supportsThinking: true
    },
    streamResponses: [
      { content: createTodoPlanAnswer(2) },
      { content: createTodoPlanAnswer(2) }
    ]
  });
  await orchestrator.executePrompt("计算广州市 NDVI", true);

  assert.deepEqual(
    calls.portPosts.map((entry) => entry.payload.purpose),
    ["plan_research", "plan_research_synthesis"]
  );
  assert.deepEqual(calls.portPosts[1].payload.tools, [], "synthesis must not expose tools");
  assert.equal(orchestrator.getActivePlan().plan.todoList.length, 4);
  assert.equal(orchestrator.getActivePlan().state, "clarifying");
  assert.equal(calls.appended.filter((entry) => entry.role === "error").length, 0);
  assert.ok(calls.appended.some((entry) => entry.purpose === "plan_action" && /TODO 不足 4 项/.test(entry.text)));
  assert.ok(calls.statuses.some((status) => status.text.includes("等待需求澄清 · 18 tokens")));
}

// If local canonicalization still leaves semantic ready-state errors and the
// sole model repair also fails, planning uses the deterministic safe skeleton.
{
  const invalidReady = JSON.parse(createTodoPlanAnswer(4));
  invalidReady.status = "ready";
  invalidReady.phase = "reviewing";
  invalidReady.questions = [];
  invalidReady.currentTodoId = "todo_1";
  invalidReady.nextTodoId = "";
  invalidReady.todoList = invalidReady.todoList.map((todo) => ({
    ...todo,
    status: "completed",
    result: "已完成"
  }));
  const { calls, orchestrator } = createHarness({
    settingsOverride: {
      baseUrl: "https://api.deepseek.com/v1",
      model: "deepseek-v4-flash",
      supportsThinking: true
    },
    streamResponses: [
      { content: "工具阶段完成。" },
      { content: JSON.stringify(invalidReady) },
      { content: JSON.stringify(invalidReady) }
    ]
  });
  await orchestrator.executePrompt("计算广州市 NDVI", true);

  assert.equal(calls.portPosts.length, 3, "the structure repair must never recurse");
  const recovered = orchestrator.getActivePlan();
  assert.equal(recovered.plan.todoList.length, 4);
  assert.equal(recovered.plan.todoList[0].title, "确认分析目标与边界");
  assert.equal(recovered.plan.datasets.length, 0);
  assert.equal(recovered.state, "clarifying");
  assert.equal(calls.appended.filter((entry) => entry.role === "error").length, 0);
  assert.ok(calls.appended.some((entry) => entry.purpose === "plan_action" && /本地安全的 4 项 TODO 骨架/.test(entry.text)));
  assert.ok(calls.statuses.some((status) => status.text.includes("等待需求澄清 · 27 tokens")));
}

// ISS-008: a plan response that is only fenced code must not crash, must not
// apply anything, and must surface a clear Chinese retry message while the
// plan session recovers to its last stable state.
{
  const codeOnlyAnswer = "```javascript\nvar image = ee.Image('MODIS/061/MOD13Q1');\nMap.addLayer(image);\n```";
  const { calls, orchestrator } = createHarness({ aiAnswer: codeOnlyAnswer });
  await orchestrator.executePrompt("计算广州市 NDVI 均值", true);

  assert.equal(calls.candidates.length, 0, "plan-stage code must never reach the editor candidate path");
  const errors = calls.appended.filter((entry) => entry.role === "error");
  assert.equal(errors.length, 1);
  assert.equal(errors[0].purpose, "plan");
  assert.match(errors[0].text, /模型在计划阶段提前返回了代码，已忽略未应用/);
  assert.match(errors[0].text, /未形成有效计划/);
  assert.match(errors[0].text, /重新发送需求重试|继续/);
  assert.ok(calls.statuses.some((status) => status.state === "error"));
  assert.equal(orchestrator.isBusy(), false);
  const recovered = orchestrator.getActivePlan();
  assert.equal(recovered.state, recovered.stableState, "plan session must recover to a stable state");
  assert.equal(recovered.plan, null);
}

console.log("Orchestrator tests passed.");

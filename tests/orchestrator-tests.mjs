import assert from "node:assert/strict";
import { createOrchestrator } from "../lib/orchestrator.js";

// Mock deps + chrome runtime for the orchestrator. The direct (non-streaming)
// request path is exercised by keeping supportsThinking false.
function createHarness({ settingsOverride = {}, editorState = null, streamAnswer = "流式回答", aiAnswer = "最终回答" } = {}) {
  const calls = {
    appended: [],
    statuses: [],
    busy: [],
    aiChats: [],
    candidates: [],
    composerModes: [],
    connects: [],
    portPosts: [],
    portDisconnects: []
  };
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
        if (message.type === "TOOLS_SEARCH") return { ok: true, context: "", sources: [], warnings: [] };
        if (message.type === "AI_CHAT") {
          calls.aiChats.push(message.payload);
          return { ok: true, content: aiAnswer, finishReason: "stop", usage: { total_tokens: 7 } };
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
              queueMicrotask(() => {
                for (const listener of messageListeners) {
                  listener({
                    type: "DONE",
                    requestId: message.payload?.requestId,
                    content: streamAnswer,
                    usage: { total_tokens: 9 },
                    finishReason: "stop"
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
    showCandidate: (code, state, planRevision) => { calls.candidates.push({ code, state, planRevision }); },
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
    contextOptions: () => ({ includeSelection: true, includeCode: true, includeConsole: false }),
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

// Local bridge exemption: a loopback baseUrl skips the API key gate (parity
// with the service-worker exemption), while other endpoints still require it.
{
  const { calls, orchestrator } = createHarness({
    settingsOverride: { hasApiKey: false, baseUrl: "http://127.0.0.1:3000/v1" }
  });
  await orchestrator.executePrompt("本地桥接直连", false);
  const errors = calls.appended.filter((entry) => entry.role === "error");
  assert.ok(!errors.some((entry) => entry.text === "请先在设置中填写 API Key"), "loopback baseUrl must not require an API Key");
  assert.ok(calls.aiChats.length >= 1, "the turn must proceed to the model call");
}
{
  const { calls, orchestrator } = createHarness({
    settingsOverride: { hasApiKey: false, baseUrl: "https://api.example.com/v1" }
  });
  await orchestrator.executePrompt("远端缺密钥", false);
  const errors = calls.appended.filter((entry) => entry.role === "error");
  assert.equal(errors.length, 1, "non-loopback endpoints still require an API Key");
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

// Multi-Agent pipeline: with the toggle off (missing or false) the confirmed-
// plan generation must stay byte-for-byte on the legacy single-round path —
// exactly one model call with purpose plan_generate and the same candidate.
const pipelineFencedScript = [
  "```javascript",
  "var image = ee.Image('MODIS/061/MOD13Q1');",
  "var ndvi = image.normalizedDifference(['NDVI', 'EVI']);",
  "Map.addLayer(ndvi, { min: 0, max: 1 }, 'NDVI');",
  "Map.centerObject(image, 6);",
  "print('NDVI ready');",
  "```"
].join("\n");

function readyPlanSession() {
  return {
    schemaVersion: 3,
    workflow: "standard",
    originalRequest: "计算广州市 NDVI 均值",
    userTurns: ["确认推荐方案"],
    sources: [],
    plan: { status: "ready", goal: "计算广州市 NDVI 均值", questions: [] },
    state: "ready",
    stableState: "ready",
    revision: 1,
    planRevision: 1,
    planStale: false
  };
}

for (const settingsOverride of [{}, { multiAgentPipeline: false }]) {
  const { calls, orchestrator } = createHarness({ settingsOverride, aiAnswer: `实现说明：\n${pipelineFencedScript}` });
  orchestrator.updateActivePlan(readyPlanSession());
  await orchestrator.generateFromConfirmedPlan();

  assert.equal(calls.aiChats.length, 1, "toggle off must keep exactly one model call");
  assert.equal(calls.aiChats[0].purpose, "plan_generate", "toggle off must stay on the single-round purpose");
  assert.ok(!calls.aiChats.some((payload) => String(payload.purpose).startsWith("plan_agent_")), "no sub-Agent call may run while the toggle is off");
  assert.equal(calls.candidates.length, 1, "single-round generation must still surface a candidate");
}

// Multi-Agent pipeline: with the toggle on the harness routes model replies
// by purpose (researcher JSON → coder fenced script → reviewer approved JSON)
// and the confirmed-plan generation walks research → coder → review before
// showing the candidate.
{
  const pipelineSettings = {
    hasApiKey: true,
    apiKey: "sk-test",
    baseUrl: "https://api.deepseek.com",
    model: "deepseek-chat",
    supportsThinking: false,
    multiAgentPipeline: true
  };
  const purposes = [];
  const { deps, calls, orchestrator } = createHarness({ settingsOverride: { multiAgentPipeline: true } });
  deps.runtime.sendMessage = async (message) => {
    if (message.type === "SETTINGS_GET") return { ok: true, settings: pipelineSettings };
    if (message.type === "TOOLS_SEARCH") return { ok: true, context: "", sources: [], warnings: [] };
    if (message.type === "AI_CHAT") {
      const purpose = message.payload.purpose;
      purposes.push(purpose);
      if (purpose === "plan_agent_research") {
        return {
          ok: true,
          content: '{"implementationNotes":["使用 MOD13Q1 的 NDVI 波段"],"datasetConstraints":["MODIS/061/MOD13Q1"],"apiUsageRules":[],"riskPoints":[]}',
          finishReason: "stop",
          usage: { total_tokens: 5 }
        };
      }
      if (purpose === "plan_agent_coder") {
        return { ok: true, content: pipelineFencedScript, finishReason: "stop", usage: { total_tokens: 6 } };
      }
      if (purpose === "plan_agent_review") {
        return { ok: true, content: '{"verdict":"approved","findings":[]}', finishReason: "stop", usage: { total_tokens: 4 } };
      }
      return { ok: true, content: pipelineFencedScript, finishReason: "stop", usage: { total_tokens: 6 } };
    }
    return { ok: true };
  };
  orchestrator.updateActivePlan(readyPlanSession());
  await orchestrator.generateFromConfirmedPlan();

  assert.deepEqual(purposes, ["plan_agent_research", "plan_agent_coder", "plan_agent_review"], "pipeline must walk research → coder → review in order");
  assert.equal(calls.candidates.length, 1, "an approved pipeline run must surface the candidate");
  const completion = calls.appended.find((entry) => entry.role === "assistant" && /多 Agent 流水线完成/.test(entry.text || ""));
  assert.ok(completion, "the pipeline must disclose its call count and token usage");
  assert.equal(orchestrator.getActivePlan().state, "ready", "the plan session returns to ready after generation");
}

// Multi-Agent pipeline degradation: a coder that never returns a fenced
// script burns the single revision round, then the run falls back to the
// single-round plan_generate path and still produces a candidate.
{
  const pipelineSettings = {
    hasApiKey: true,
    apiKey: "sk-test",
    baseUrl: "https://api.deepseek.com",
    model: "deepseek-chat",
    supportsThinking: false,
    multiAgentPipeline: true
  };
  const purposes = [];
  const { deps, calls, orchestrator } = createHarness({ settingsOverride: { multiAgentPipeline: true } });
  deps.runtime.sendMessage = async (message) => {
    if (message.type === "SETTINGS_GET") return { ok: true, settings: pipelineSettings };
    if (message.type === "TOOLS_SEARCH") return { ok: true, context: "", sources: [], warnings: [] };
    if (message.type === "AI_CHAT") {
      const purpose = message.payload.purpose;
      purposes.push(purpose);
      if (purpose === "plan_agent_research") {
        return {
          ok: true,
          content: '{"implementationNotes":[],"datasetConstraints":[],"apiUsageRules":[],"riskPoints":[]}',
          finishReason: "stop",
          usage: { total_tokens: 5 }
        };
      }
      if (purpose === "plan_agent_coder") {
        return { ok: true, content: "这里只有说明文字，没有围栏代码块。", finishReason: "stop", usage: { total_tokens: 3 } };
      }
      return { ok: true, content: pipelineFencedScript, finishReason: "stop", usage: { total_tokens: 6 } };
    }
    return { ok: true };
  };
  orchestrator.updateActivePlan(readyPlanSession());
  await orchestrator.generateFromConfirmedPlan();

  assert.deepEqual(
    purposes,
    ["plan_agent_research", "plan_agent_coder", "plan_agent_coder", "plan_generate"],
    "a fence-less coder burns one revision round, then degrades to plan_generate"
  );
  const fallbackNotice = calls.appended.find((entry) => entry.role === "assistant" && /多 Agent 流水线未能完成[\s\S]*已回退到单轮生成/.test(entry.text || ""));
  assert.ok(fallbackNotice, "the fallback must be disclosed to the user");
  assert.equal(calls.candidates.length, 1, "the degraded single-round path must still produce a candidate");
  const errors = calls.appended.filter((entry) => entry.role === "error");
  assert.equal(errors.length, 0, "a successful degradation must not surface an error bubble");
}

console.log("Orchestrator tests passed.");

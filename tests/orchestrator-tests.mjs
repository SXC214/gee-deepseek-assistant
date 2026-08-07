import assert from "node:assert/strict";
import { createOrchestrator } from "../lib/orchestrator.js";

// Mock deps + chrome runtime for the orchestrator. The direct (non-streaming)
// request path is exercised by keeping supportsThinking false.
function createHarness({ settingsOverride = {}, editorState = null } = {}) {
  const calls = {
    appended: [],
    statuses: [],
    busy: [],
    aiChats: [],
    candidates: [],
    composerModes: []
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
          return { ok: true, content: "最终回答", finishReason: "stop", usage: { total_tokens: 7 } };
        }
        return { ok: true };
      },
      connect() {
        throw new Error("streaming not expected in these tests");
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

console.log("Orchestrator tests passed.");

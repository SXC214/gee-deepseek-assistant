import assert from "node:assert/strict";
import fs from "node:fs";
import { CUSTOM_PROVIDER_ID, PROVIDER_PRESETS } from "../lib/provider-presets.js";

const html = fs.readFileSync(new URL("../sidepanel.html", import.meta.url), "utf8");
const script = fs.readFileSync(new URL("../sidepanel.js", import.meta.url), "utf8");
const orchestratorScript = fs.readFileSync(new URL("../lib/orchestrator.js", import.meta.url), "utf8");
const storageScript = fs.readFileSync(new URL("../lib/storage.js", import.meta.url), "utf8");
const styles = fs.readFileSync(new URL("../styles.css", import.meta.url), "utf8");
const manifest = JSON.parse(fs.readFileSync(new URL("../manifest.json", import.meta.url), "utf8"));
const packageJson = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const ids = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]));
const references = new Set([...script.matchAll(/elements\.([A-Za-z][A-Za-z0-9]*)/g)].map((match) => match[1]));

const missing = [...references].filter((id) => !ids.has(id));
assert.deepEqual(missing, [], `sidepanel.js references missing HTML ids: ${missing.join(", ")}`);
assert.equal(ids.size, [...html.matchAll(/\bid="([^"]+)"/g)].length, "HTML ids must be unique");
assert.match(html, /id="settingsButton"[^>]*aria-controls="settingsPanel"[^>]*aria-expanded="false"/);
assert.match(html, /class="settings-card settings-drawer hidden" id="settingsPanel"/);
assert.match(html, /id="thinkingEnabled"[^>]*checked/);
assert.match(html, /id="compatibleStreaming"[^>]*type="checkbox"/);
assert.match(html, /兼容接口启用流式输出（实验性）/);
assert.match(html, /<option value="high">High（默认）<\/option>/);
assert.match(html, /<option value="max">Max（复杂任务）<\/option>/);
assert.match(html, /id="planMode"/);
assert.match(html, /id="directModeButton"[^>]*aria-pressed="true"/);
assert.match(html, /id="planModeButton"[^>]*aria-pressed="false"/);
assert.match(html, /class="chat-card"/);
assert.match(html, /id="conversation"[^>]*role="log"/);
assert.match(html, /id="clearChatButton"/);
assert.match(html, /id="conversationEmpty"/);
assert.match(html, /id="scrollToLatestButton"/);
assert.match(html, /id="queuePanel"/);
assert.match(html, /id="queueList"/);
assert.match(html, /id="resumeQueueButton"/);
assert.match(html, /id="consoleContextChip"/);
assert.match(html, /id="consoleRepairButton"/);
assert.match(html, /id="includeConsole"[^>]*aria-label="包含 Earth Engine Console 上下文"/);
assert.match(html, /id="includeConsoleLabel"[^>]*aria-live="polite"/);
assert.match(html, /id="sendButton"[^>]*disabled/);
assert.match(html, /id="copyButton"/);
assert.match(html, /id="candidateHint"/);
assert.match(html, /id="candidateStatusBadge"/);
assert.match(html, /id="candidateCodeView"/);
assert.match(html, /id="candidateValidation"/);
assert.match(html, /id="candidateValidationChecks"/);
assert.match(html, /关闭代码卡/);
assert.match(html, /id="confirmPlanButton"/);
assert.match(html, /id="continuePlanButton"/);
assert.match(html, /id="cancelPlanButton"/);
assert.match(html, /id="planRevisionBadge"/);
assert.ok(html.indexOf('id="conversation"') < html.indexOf('id="planPanel"'), "plan panel must live inside the chat log");
assert.ok(html.indexOf('id="conversation"') < html.indexOf('id="toolResults"'), "tool results must live inside the chat log");
assert.match(storageScript, /export const ACTIVE_PLAN_KEY = "activePlanV1"/);
assert.match(storageScript, /export const CHAT_HISTORY_KEY = "chatHistoryV1"/);
assert.match(storageScript, /export const CODE_CANDIDATE_KEY = "codeCandidateV1"/);
assert.match(storageScript, /export const MESSAGE_QUEUE_KEY = "messageQueueV1"/);
assert.match(script, /import \{[\s\S]*MESSAGE_QUEUE_KEY,[\s\S]*\} from "\.\/lib\/storage\.js"/);
assert.match(script, /let initialized = false/);
assert.match(orchestratorScript, /async function generateFromConfirmedPlan\(\) \{\s+if \(!deps\.isInitialized\(\)\)/);
assert.match(script, /initialized = true;\s+if \(!busy\) \{\s+setBusy\(false\)/);
assert.match(script, /initialize\(\)\.catch\(handleInitializeFailure\)/);
assert.match(script, /function handleInitializeFailure\(error\)/);
assert.match(script, /function renderInitializeRetry\(error\)/);
assert.match(script, /async function retryInitialize\(\)/);
assert.match(script, /重试初始化/);
assert.match(script, /if \(eventsBound\) return/);
// ISS-007 regression guard: the eventsBound idempotency guard (and any module
// state read by the top-level initialize/bindEvents path) must be initialized
// before the top-level initialize() call, otherwise first load hits a TDZ error.
assert.ok(script.indexOf("let eventsBound = false") > -1, "eventsBound guard must exist");
assert.ok(
  script.indexOf("let eventsBound = false") < script.indexOf("initialize().catch(handleInitializeFailure)"),
  "eventsBound must be initialized before the top-level initialize() call (ISS-007)"
);
assert.match(styles, /\.init-retry-notice\s*\{/);
assert.match(orchestratorScript, /runtime\.connect\(\{ name: "AI_CHAT_STREAM" \}\)/);
assert.match(script, /兼容模式不支持实时思考/);
assert.match(orchestratorScript, /isOfficialDeepSeekV4Flash\(settings\?\.baseUrl, settings\?\.model\)/);
assert.match(orchestratorScript, /第一步必须创建 TODO List/);
assert.match(orchestratorScript, /禁止直接给结论或代码/);
assert.match(script, /function renderPlanTodoList\(plan\)/);
assert.match(script, /plan\.todoList\?\.length/);
assert.match(script, /upsertPlanAnswerText\(elements\.prompt\.value/);
assert.match(script, /已叠加 \$\{answerCount\} 个问题的答案/);
// ISS-009 regression guard: checked plan options persist on the card across
// re-renders, and answers that already left the input are locked so they can
// never be injected (and re-sent) a second time.
assert.match(script, /let planOptionSelections = new Map\(\)/);
assert.match(script, /let submittedPlanAnswerIds = new Set\(\)/);
assert.match(script, /const markerId = planAnswerMarkerId\(\{ questionId: question\?\.id, prompt \}\)/);
assert.match(script, /const answered = Boolean\(markerId\) && submittedPlanAnswerIds\.has\(markerId\)/);
assert.match(script, /button\.classList\.toggle\("selected", selected\);\s+button\.setAttribute\("aria-pressed", String\(selected\)\);\s+button\.disabled = answered;/);
assert.match(script, /planOptionSelections\.set\(markerId, \{ optionId: option\?\.id \|\| "", label: option\?\.label \|\| "" \}\)/);
assert.match(script, /if \(markerId && submittedPlanAnswerIds\.has\(markerId\)\)/);
assert.match(script, /该问题的答案已提交过，未重复注入输入框/);
assert.match(script, /for \(const markerId of collectPlanAnswerMarkerIds\(prompt\)\)/);
assert.match(script, /function resetPlanOptionSelections\(\)/);
assert.match(script, /candidate = null;\s+resetPlanOptionSelections\(\);/);
assert.match(script, /orchestrator\.updateActivePlan\(null\);\s+resetPlanOptionSelections\(\);/);
assert.match(styles, /\.plan-question-card\.plan-question-answered/);
assert.match(styles, /\.plan-answered-hint/);
assert.match(script, /if \(!currentSettings\.hasApiKey\) openSettings\(\{ focusKey: true \}\)/);
assert.match(script, /baseRevision: baseState\?\.revision/);
assert.match(script, /tabId: baseState\?\.tabId/);
assert.doesNotMatch(orchestratorScript, /\[session\.originalRequest, \.\.\.session\.userTurns\]/);
assert.match(orchestratorScript, /session\.userTurns\.at\(-1\)/);
assert.match(orchestratorScript, /formatPlanTranscript\(activePlan\)/);
assert.match(orchestratorScript, /recordSourceSnapshot\(toolResult\)/);
assert.match(orchestratorScript, /const newSession = !activePlan\?\.originalRequest/);
assert.match(orchestratorScript, /const firstResearchRound = !activePlan\?\.plan/);
assert.match(script, /entry\.role === "assistant" && \["source", "plan"\]\.includes\(entry\.purpose\)/);
assert.match(orchestratorScript, /本轮仍会基于你的需求和官方资料制定计划/);
assert.doesNotMatch(script, /throw new Error\("无法连接 Earth Engine 编辑器，请取消代码上下文选项或打开 Code Editor"\)/);
assert.doesNotMatch(script, /无法读取当前 GEE 编辑器上下文/);
assert.match(script, /navigator\.clipboard\.writeText\(candidate\.code\)/);
assert.match(script, /markCodeCandidateApplied\(candidate, mode\)/);
assert.match(script, /candidate\.validation\?\.status === "failed"/);
assert.match(script, /候选代码未通过本地预检，已阻止写入/);
assert.match(script, /function renderCandidateValidation\(validation\)/);
assert.match(styles, /\.candidate-validation-failed/);
assert.match(script, /function renderCandidateCard\(\{ scroll = false \} = \{\}\)/);
assert.match(script, /elements\.candidatePanel\.scrollIntoView/);
assert.match(script, /if \(scroll && follow\)/);
assert.match(script, /function handleConversationScroll\(\)/);
assert.match(script, /function renderConsoleReadStatus\(consoleRead = editorState\?\.consoleRead\)/);
assert.match(script, /async function pollConsoleAfterRun\(before\)/);
assert.match(script, /function requestConsoleRepair\(\)/);
assert.match(script, /orchestrator\.recordObservedFailure/);
assert.match(script, /elements\.includeCode\.checked = true;\s+elements\.includeConsole\.checked = true/);
assert.match(script, /createConsoleContextSection\(state, elements\.includeConsole\.checked\)/);
assert.match(orchestratorScript, /state\?\.consoleRead\?\.status === "captured" && state\.consoleText/);
assert.match(orchestratorScript, /禁止推测、虚构或把代码分析当作真实 Console 错误/);
assert.match(script, /setScrollToLatestVisibility/);
assert.match(orchestratorScript, /function describePlanTurnError\(error, stage\)/);
assert.match(orchestratorScript, /模型最终计划未通过结构校验/);
assert.match(orchestratorScript, /setRequestErrorStatus\(error, \{/);
// ISS-008 regression guard: both planning system prompts forbid premature
// fenced code, and the plan turn degrades gracefully (never crashes, never
// applies code) when a model still returns one.
assert.match(orchestratorScript, /规划与澄清问题阶段严禁输出任何可执行代码或围栏代码块/);
assert.match(orchestratorScript, /代码只能在用户确认计划、进入执行\/生成阶段后产出/);
assert.match(orchestratorScript, /规划、调研与澄清问题阶段严禁输出任何可执行代码或围栏代码块/);
assert.match(orchestratorScript, /const prematureCode = containsFencedCodeBlock\(rawContent\)/);
assert.match(orchestratorScript, /parsePlanResponse\(stripFencedCodeBlocks\(rawContent\)\)/);
assert.match(orchestratorScript, /premature\.prematurePlanCode = true/);
assert.match(orchestratorScript, /模型在计划阶段提前返回了代码，已忽略未应用/);
assert.match(orchestratorScript, /if \(error\?\.prematurePlanCode\)/);
assert.match(styles, /\.status-error\s*\{[\s\S]*?white-space:\s*normal/);
assert.match(styles, /html,[\s\S]*?body\s*\{[\s\S]*?overflow:\s*hidden/);
assert.match(styles, /\.conversation\s*\{[\s\S]*?overflow-y:\s*auto/);
assert.match(styles, /\.context-chip\.console-status-captured:has\(input:checked\)/);
assert.match(styles, /\.context-chip\.console-status-empty:has\(input:checked\)/);
assert.match(styles, /\.context-chip\.console-status-unavailable:has\(input:checked\)/);
assert.match(script, /elements\.conversation\.appendChild\(elements\.candidatePanel\)/);
const applyCandidateStart = script.indexOf("async function applyCandidate");
const copyCandidateStart = script.indexOf("async function copyCandidate");
assert.doesNotMatch(script.slice(applyCandidateStart, copyCandidateStart), /dismissCandidate\(\)/);
const sendPromptStart = script.indexOf("async function sendPrompt");
const executePromptCall = script.indexOf("await orchestrator.executePrompt(prompt, planRequest)");
assert.ok(sendPromptStart >= 0 && executePromptCall > sendPromptStart, "sendPrompt must delegate to the orchestrator");
const sendPromptBody = script.slice(sendPromptStart, executePromptCall);
assert.ok(sendPromptBody.indexOf('elements.prompt.value = ""') > -1, "sent text must leave the input before awaiting a response");
assert.ok(
  orchestratorScript.indexOf("deps.setBusy(true)") < orchestratorScript.indexOf("await runPlanTurn(prompt)"),
  "executePrompt must lock the UI before awaiting a request"
);
assert.match(orchestratorScript, /function drainMessageQueue\(\)/);
assert.match(script, /enqueuePrompt\(prompt, planRequest\)/);
assert.match(orchestratorScript, /queuePaused = true/);
// ISS-010 regression guard: the turn-state badge wording derives from one
// helper that every queue render (remove/edit/priority/clear/restore/drain)
// and every busy toggle shares, so deleting a queued message while idle can
// never leave a stale "N 条待发送" label.
assert.match(script, /function refreshTurnStateBadge\(\)/);
assert.match(
  script,
  /elements\.turnStateBadge\.textContent = busy \? "处理中" : queuedCount \? `\$\{queuedCount\} 条待发送` : "就绪"/
);
const renderMessageQueueBody = script.slice(
  script.indexOf("function renderMessageQueue()"),
  script.indexOf("function handleQueueAction")
);
assert.ok(
  /refreshTurnStateBadge\(\)/.test(renderMessageQueueBody),
  "renderMessageQueue must refresh the turn-state badge on every queue change"
);
const setBusyBody = script.slice(script.indexOf("function setBusy(value)"), script.indexOf("function setStatus("));
assert.ok(/refreshTurnStateBadge\(\)/.test(setBusyBody), "setBusy must reuse the shared badge refresh helper");
assert.doesNotMatch(
  setBusyBody,
  /orchestrator\.getQueue\(\)\.length \?/,
  "setBusy must not inline its own badge wording"
);
assert.equal(manifest.version, "0.4.0");
assert.ok(manifest.permissions.includes("clipboardWrite"));
assert.ok(manifest.permissions.includes("unlimitedStorage"));
assert.match(script, /import \{[\s\S]*setWithQuotaEviction,[\s\S]*\} from "\.\/lib\/storage\.js"/);
assert.match(script, /writeMessageQueueSnapshot\(chrome\.storage\.local/);
assert.match(script, /serializeActivePlan\(chrome\.storage\.local/);
assert.match(script, /function reportPersistFailure\(kind, error\)/);
assert.match(script, /本地保存失败，仅保留在当前会话/);
assert.match(script, /PERSIST_FAILURE_NOTIFY_COOLDOWN_MS = 10000/);
// Eviction outcomes resync every affected in-memory state and never report a
// degraded (metadata-only) candidate as saved (M5).
assert.match(script, /function applyStorageEvictionOutcome\(outcome\)/);
assert.match(script, /function resyncEvictedChatHistory\(entries\)/);
assert.match(script, /outcome\.evictions\.includes\("chat-history-halved"\)/);
assert.match(script, /outcome\.degraded/);
assert.match(script, /代码候选仅保留了元信息，完整代码卡未保存/);
assert.match(script, /error\.persistNotified = true/);
assert.match(script, /if \(error\?\.persistNotified\) return;/);
assert.match(orchestratorScript, /deps\.appendMessage\("user", prompt, \{ purpose: "direct" \}\)/);
assert.match(script, /\.filter\(\(entry\) => entry\.purpose === "direct" && \["user", "assistant"\]\.includes\(entry\.role\)\)/);
assert.match(orchestratorScript, /directConversation = alignConversationToUser\(/);
assert.match(script, /orchestrator\.setDirectConversation\(alignConversationToUser\(/);
assert.match(script, /elements\.compatibleStreaming\.checked = currentSettings\.compatibleStreaming === true/);
assert.match(script, /compatibleStreaming: elements\.compatibleStreaming\.checked/);
// Model provider presets: the dropdown mirrors lib/provider-presets.js and
// only pre-fills baseUrl / model; fields stay editable and custom never
// touches existing values. Presets must not leak into request construction.
assert.match(html, /<select id="providerPreset" name="providerPreset">/);
assert.ok(html.indexOf('id="providerPreset"') < html.indexOf('id="baseUrl"'), "provider dropdown must precede the API address field");
const providerSelectHtml = html.match(/<select id="providerPreset"[\s\S]*?<\/select>/)[0];
const providerOptions = [...providerSelectHtml.matchAll(/<option value="([^"]+)">([^<]+)<\/option>/g)]
  .map((match) => ({ value: match[1], label: match[2] }));
assert.deepEqual(
  providerOptions.map((option) => option.value),
  [...PROVIDER_PRESETS.map((preset) => preset.id), CUSTOM_PROVIDER_ID],
  "provider dropdown options must mirror the preset table plus the custom entry"
);
for (const preset of PROVIDER_PRESETS) {
  const option = providerOptions.find((entry) => entry.value === preset.id);
  assert.ok(option, `option for preset ${preset.id} must exist`);
  assert.equal(option.label, preset.label, `option label for ${preset.id} must match the preset label`);
}
assert.equal(providerOptions.at(-1).label, "自定义");
assert.match(script, /import \{ CUSTOM_PROVIDER_ID, findProviderPreset, matchProviderPreset \} from "\.\/lib\/provider-presets\.js"/);
assert.match(script, /elements\.providerPreset\.addEventListener\("change", applyProviderPreset\)/);
assert.match(script, /function applyProviderPreset\(\) \{\s+const preset = findProviderPreset\(elements\.providerPreset\.value\);\s+if \(!preset\) return;\s+elements\.baseUrl\.value = preset\.baseUrl;\s+elements\.model\.value = preset\.defaultModel;/);
assert.match(script, /elements\.providerPreset\.value = matched \|\| CUSTOM_PROVIDER_ID/);
assert.doesNotMatch(script, /providerPreset: elements\.providerPreset\.value/, "provider choice must never be persisted in settings");
// GEE REST direct connection: settings input, redirect URI helper and panel.
assert.match(html, /id="geeClientId"/);
assert.match(html, /id="geeRedirectUri"/);
assert.match(html, /id="copyRedirectUriButton"[^>]*type="button"/);
assert.match(html, /id="geeRestButton"[^>]*aria-controls="geeRestPanel"[^>]*aria-expanded="false"/);
assert.match(html, /id="geeRestPanel" class="gee-rest-panel hidden"/);
assert.match(html, /id="geeRestRefreshButton"/);
assert.match(html, /id="geeRestCloseButton"/);
assert.match(html, /id="geeRestGuide"/);
assert.match(html, /id="geeRestStatus"/);
assert.match(html, /id="geeAssetList"/);
assert.match(html, /id="geeTaskList"/);
assert.match(html, /id="geeAssetMoreButton"[^>]*hidden/);
assert.match(html, /加载下一页/);
assert.match(html, /id="geeAssetError"/);
assert.match(html, /id="geeTaskError"/);
assert.match(html, /id="geeTaskMoreButton"[^>]*hidden/);
assert.match(html, /加载更多/);
assert.match(script, /elements\.geeClientId\.value = currentSettings\.geeClientId \|\| ""/);
assert.match(script, /geeClientId: elements\.geeClientId\.value/);
assert.match(script, /chrome\.identity\.getRedirectURL\(\)/);
assert.match(script, /type: "GEE_REST_LIST_ASSETS"/);
assert.match(script, /type: "GEE_REST_LIST_TASKS"/);
assert.match(script, /const marker = `资产: \$\{assetId\}`/);
assert.match(script, /elements\.prompt\.value = current \? `\$\{current\}\\n\$\{marker\}` : marker/);
assert.match(script, /async function refreshGeeRest\(\)/);
assert.match(script, /async function loadGeeAssets\(pageToken = ""\)/);
assert.match(script, /async function loadGeeTasks\(pageToken = ""\)/);
assert.match(script, /elements\.geeTaskMoreButton\.addEventListener\("click", \(\) => loadGeeTasks\(geeTaskNextToken\)/);
assert.match(script, /let geeTaskNextToken = "";/);
assert.match(script, /elements\.geeTaskMoreButton\.classList\.toggle\("hidden", !geeTaskNextToken\)/);
// Assets and tasks keep independent loading/error state (m6): separate
// loading flags, per-column error surfaces, and a refresh that clears both.
assert.match(script, /let geeAssetLoading = false;/);
assert.match(script, /let geeTaskLoading = false;/);
assert.match(script, /function setGeeColumnError\(kind, message\)/);
assert.match(script, /setGeeColumnError\("assets", `资产加载失败：\$\{safeError\(error\)\}`\)/);
assert.match(script, /setGeeColumnError\("tasks", `任务加载失败：\$\{safeError\(error\)\}`\)/);
assert.match(script, /setGeeColumnError\("assets", ""\);[\s\S]*setGeeColumnError\("tasks", ""\);[\s\S]*renderGeeAssets\(\);[\s\S]*renderGeeTasks\(\);/);
assert.match(styles, /\.gee-rest-panel\s*\{/);
assert.match(styles, /\.gee-rest-item-type\s*\{/);
assert.match(styles, /\.gee-redirect-uri\s*\{/);
assert.ok(manifest.permissions.includes("identity"), "identity permission backs the independent OAuth flow");
assert.equal(packageJson.version, manifest.version);
// Shapefile upload entry: the button sits next to 刷新 in the panel header
// row and the hidden multi-file input lives inside the panel; both ids must
// be referenced from sidepanel.js (the top-of-file guard already enforces
// the reverse direction and id uniqueness).
assert.match(html, /id="shpUploadButton" class="compact-button" type="button">上传 Shapefile<\/button>/);
assert.match(html, /id="shpFileInput" type="file" multiple accept="\.shp,\.shx,\.dbf,\.prj,\.cpg" class="hidden"/);
assert.ok(html.indexOf('id="geeRestRefreshButton"') < html.indexOf('id="shpUploadButton"'), "upload button must sit after the refresh button");
assert.ok(html.indexOf('id="shpUploadButton"') < html.indexOf('id="geeRestCloseButton"'), "upload button must stay inside the header button row");
assert.ok(references.has("shpUploadButton"), "sidepanel.js must reference elements.shpUploadButton");
assert.ok(references.has("shpFileInput"), "sidepanel.js must reference elements.shpFileInput");
assert.match(script, /elements\.shpUploadButton\.addEventListener\("click", \(\) => elements\.shpFileInput\.click\(\)\)/);
assert.match(script, /elements\.shpFileInput\.addEventListener\("change", \(\) => handleShpUpload\(\)\.catch\(showError\)\)/);
// Upload orchestration: validate → cloud-first (upload URL → byte upload →
// table import → refresh) with a confirmed local parse fallback.
assert.match(script, /import \{[\s\S]*SHP_CLOUD_DIRECT_MAX_BYTES,[\s\S]*validateShapefileSet[\s\S]*\} from "\.\/lib\/shapefile\.js"/);
assert.match(script, /import \{[\s\S]*isQuotaExceededError,[\s\S]*readShpAssets,[\s\S]*writeShpAssets[\s\S]*\} from "\.\/lib\/storage\.js"/);
assert.match(script, /async function handleShpUpload\(\)/);
assert.match(script, /const validation = validateShapefileSet\(entries\)/);
assert.match(script, /setGeeColumnError\("assets", validation\.error\)/);
assert.match(script, /if \(totalBytes > SHP_CLOUD_DIRECT_MAX_BYTES\)/);
assert.match(script, /type: "SHP_GET_UPLOAD_URL"/);
assert.match(script, /type: "SHP_UPLOAD_BLOB"/);
assert.match(script, /files: entries\.map\(\(\{ name, buffer \}\) => \(\{ name, buffer \}\)\)/);
assert.match(script, /type: "GEE_REST_IMPORT_TABLE"/);
assert.match(script, /importResult\?\.code === "ALREADY_EXISTS"/);
assert.match(script, /conflict\.noLocalFallback = true/);
assert.match(script, /正在获取上传地址…/);
assert.match(script, /正在上传文件字节…/);
assert.match(script, /正在入库 Earth Engine…/);
assert.match(script, /await refreshGeeRest\(\);/);
// Local fallback: user confirmation gate, progress feedback, quota-aware
// persistence and a re-render; file input reset keeps repeat selection alive.
assert.match(script, /window\.confirm\(/);
assert.match(script, /parseShapefileToGeoJson\(buffers, \{/);
assert.match(script, /onProgress: \(\{ processed, total, done \}\)/);
assert.match(script, /readShpAssets\(chrome\.storage\.local\)/);
assert.match(script, /writeShpAssets\(chrome\.storage\.local/);
assert.match(script, /if \(isQuotaExceededError\(error\)\)/);
assert.match(script, /input\.value = ""/);
assert.match(script, /elements\.shpUploadButton\.disabled = true/);
// Local SHP section in the asset column: independent of the cloud list,
// with inject-script / inject-prompt / delete actions per row.
assert.match(script, /let localShpAssets = \[\];/);
assert.match(script, /localShpAssets = await readShpAssets\(chrome\.storage\.local\)/);
assert.match(script, /type\.textContent = "SHP·本地"/);
assert.match(script, /scriptButton\.textContent = "注入脚本"/);
assert.match(script, /deleteButton\.textContent = "删除"/);
assert.match(script, /buildFeatureCollectionSnippet\(asset\.name, asset\.geoJson\)/);
assert.match(script, /payload: \{ code: snippet, mode: "insert" \}/);
assert.match(script, /function injectShpAssetIntoPrompt\(asset\)/);
assert.match(script, /资产: \$\{asset\.id\}（\$\{asset\.featureCount\} 个要素，bbox \[\$\{bboxText\}\]，字段: \$\{fieldsText\}）/);
assert.match(script, /async function deleteLocalShpAsset\(assetId\)/);
// Workspace auto-read connection: the connect button and its status slot are
// grouped into one cohesive unit (workspaceConnectGroup) placed right after
// the clear-and-new-conversation button, while the editor action row returns
// to run / asset-task / read. The toggle persists under workspaceAutoReadV1.
// Auto reads reuse the existing read path and are debounced per tab on
// onActivated / onUpdated-complete events.
assert.match(html, /id="workspaceConnectButton" class="compact-button" type="button" aria-pressed="false">接入 New script 工作区<\/button>/);
assert.match(html, /id="workspaceConnectStatus" class="hint workspace-connect-status">未接入<\/p>/);
assert.match(html, /id="workspaceConnectGroup" class="workspace-connect-group" role="group" aria-label="New script 工作区接入"/);
assert.ok(html.indexOf('id="clearChatButton"') < html.indexOf('id="workspaceConnectGroup"'), "workspace connect group must sit right of the new-conversation button");
assert.ok(html.indexOf('id="workspaceConnectGroup"') < html.indexOf('id="workspaceConnectButton"'), "workspace connect group must wrap its button");
assert.ok(html.indexOf('id="workspaceConnectButton"') < html.indexOf('id="workspaceConnectStatus"'), "status text must sit directly beside the connect button");
assert.ok(html.indexOf('id="workspaceConnectStatus"') < html.indexOf('id="connectionBadge"'), "workspace connect group must stay before the connection badge");
assert.ok(html.indexOf('id="workspaceConnectStatus"') < html.indexOf('id="runButton"'), "workspace connect unit must leave the editor action row");
assert.ok(html.indexOf('id="runButton"') < html.indexOf('id="geeRestButton"'), "run button must lead the editor action row");
assert.ok(html.indexOf('id="geeRestButton"') < html.indexOf('id="readButton"'), "read button must end the editor action row");
assert.ok(references.has("workspaceConnectButton"), "sidepanel.js must reference elements.workspaceConnectButton");
assert.ok(references.has("workspaceConnectStatus"), "sidepanel.js must reference elements.workspaceConnectStatus");
assert.match(script, /const WORKSPACE_AUTO_READ_KEY = "workspaceAutoReadV1"/);
assert.match(script, /elements\.workspaceConnectButton\.addEventListener\("click", connectWorkspace\)/);
assert.match(script, /async function restoreWorkspaceConnection\(\)/);
assert.match(script, /await restoreWorkspaceConnection\(\);/);
assert.match(script, /chrome\.tabs\.onActivated\.addListener/);
assert.match(script, /changeInfo\.status !== "complete"/);
assert.match(script, /function autoReadForTab\(tabId\)/);
assert.match(script, /AUTO_READ_DEBOUNCE_MS/);
assert.match(script, /elements\.workspaceConnectButton\.disabled = value/);
// New-conversation entry is a visible text button that keeps the original
// click handler and confirmation flow.
assert.match(html, /id="clearChatButton" class="compact-button" type="button" title="清空并新建对话">清空并新建对话<\/button>/);
assert.match(script, /elements\.clearChatButton\.addEventListener\("click", startNewConversation\)/);

console.log("UI consistency tests passed.");

import assert from "node:assert/strict";
import {
  addPlanAnswer,
  applyPlanResponse,
  canonicalizeTodoPlanStructure,
  containsFencedCodeBlock,
  createPlanSession,
  createSafeTodoFallbackPlan,
  mergeSources,
  parsePlanResponse,
  restorePlanSession,
  sanitizePlanSession,
  serializePlanSession,
  setPlanState,
  stripFencedCodeBlocks,
  validatePlanResponse
} from "../lib/plan.js";

const landsat = {
  type: "dataset",
  title: "Landsat Collection 2 Level 2",
  url: "https://developers.google.com/earth-engine/datasets/catalog/LANDSAT_LT05_C02_T1_L2",
  datasetId: "LANDSAT/LT05/C02/T1_L2"
};
const modis = {
  type: "dataset",
  title: "MODIS Vegetation Indices 16-Day Global 250m",
  url: "https://developers.google.com/earth-engine/datasets/catalog/MODIS_061_MOD13Q1",
  datasetId: "MODIS/061/MOD13Q1",
  summary: "Dataset Availability 2000-02-18T00:00:00Z–2026-07-12T00:00:00Z"
};
const sentinel = {
  type: "dataset",
  title: "Harmonized Sentinel-2 MSI Surface Reflectance",
  url: "https://developers.google.com/earth-engine/datasets/catalog/COPERNICUS_S2_SR_HARMONIZED",
  datasetId: "COPERNICUS/S2_SR_HARMONIZED",
  summary: "Dataset Availability 2017-03-28T00:00:00Z–2026-08-04T00:00:00Z"
};

let session = createPlanSession("计算 2000-2020 年广州市 NDVI 均值变化");
assert.equal(session.state, "idle");
assert.equal(session.revision, 0);
assert.equal(session.planRevision, 0);

const merged = mergeSources([landsat], [
  { ...landsat, url: `${landsat.url}?utm=one`, summary: "Dataset Availability 1984-03-16T00:00:00Z–2012-05-05T00:00:00Z" },
  modis,
  { ...modis, url: "https://developers.google.com/earth-engine/datasets/catalog/MODIS_061_MOD13Q1#top" },
  sentinel
]);
assert.equal(merged.length, 3);
assert.match(merged[0].summary, /Dataset Availability 1984/);

session = { ...session, sources: merged };
const needsClarification = parsePlanResponse(`模型说明\n\`\`\`json
{
  "status": "needs_clarification",
  "goal": "比较广州市 NDVI 的年均变化",
  "datasets": [{ "datasetId": "LANDSAT/LT05/C02/T1_L2", "url": "${landsat.url}", "name": "Landsat" }],
  "requirements": { "area": "广州市行政边界" },
  "method": "待确认传感器拼接策略",
  "outputs": "年度序列图",
  "questions": ["使用哪个行政区边界版本？", "年均值是否按生长季？"]
}
\`\`\``);
assert.equal(needsClarification.status, "needs_clarification");
assert.equal(validatePlanResponse(needsClarification, merged).valid, true);
session = applyPlanResponse(session, needsClarification);
assert.equal(session.state, "clarifying");
assert.equal(session.revision, 1);
assert.equal(session.planRevision, 1);
assert.equal(session.plan.questions[0].prompt, "使用哪个行政区边界版本？");

const incompleteReady = {
  ...needsClarification,
  status: "ready",
  questions: [],
  requirements: { area: "广州市" }
};
const invalid = validatePlanResponse(incompleteReady, merged);
assert.equal(invalid.valid, false);
assert.match(invalid.errors.join("\n"), /timeRange/);

const codeDuringPlanning = structuredClone(needsClarification);
codeDuringPlanning.method = "```javascript\nvar image = ee.Image('x');\n```";
assert.match(validatePlanResponse(codeDuringPlanning, merged).errors.join("\n"), /must not contain executable JavaScript/);

// ISS-008: premature fenced code detection treats ```json plan wrappers as
// ordinary responses but flags executable fences, and stripping keeps the
// plan text intact so parsing can still succeed.
assert.equal(containsFencedCodeBlock("```json\n{\"status\":\"ready\"}\n```"), false);
assert.equal(containsFencedCodeBlock('{"status":"needs_clarification"}'), false);
assert.equal(containsFencedCodeBlock("```javascript\nvar image = ee.Image('x');\n```"), true);
assert.equal(containsFencedCodeBlock("说明\n```\nvar image = ee.Image('x');\n```"), true, "language-less fences with code bodies count as code");
assert.equal(containsFencedCodeBlock("```\n{\"status\":\"ready\"}\n```"), false, "language-less fences holding JSON stay plan text");
const mixedPlanText = "草案：\n```json\n{\"status\":\"needs_clarification\"}\n```\n```javascript\nMap.addLayer(ee.Image('x'));\n```";
const strippedPlanText = stripFencedCodeBlocks(mixedPlanText);
assert.match(strippedPlanText, /\`\`\`json/);
assert.match(strippedPlanText, /needs_clarification/);
assert.doesNotMatch(strippedPlanText, /Map\.addLayer/);
assert.equal(parsePlanResponse(strippedPlanText).status, "needs_clarification");
assert.equal(stripFencedCodeBlocks("没有围栏的纯文本"), "没有围栏的纯文本");

const incompleteDataset = structuredClone(incompleteReady);
incompleteDataset.requirements = {
  area: "广州市",
  timeRange: "2000-2020",
  temporalAggregation: "年度合成",
  spatialStatistic: "区域均值",
  qualityControl: "QA 掩膜"
};
incompleteDataset.datasets[0].coverage = "";
assert.match(validatePlanResponse(incompleteDataset, merged).errors.join("\n"), /coverage/);

const ready = {
  status: "ready",
  goal: "计算 2000-2020 年广州市 NDVI 年均空间均值变化",
  datasets: [
    {
      datasetId: "LANDSAT/LT05/C02/T1_L2",
      url: landsat.url,
      name: "Landsat",
      coverage: "1984-2012",
      spatialResolution: "30 m",
      advantages: "覆盖完整早期时段",
      limitations: "单一 Landsat 5 数据集不覆盖完整研究期，需跨传感器一致化",
      recommendation: "作为早期时段补充候选"
    },
    {
      datasetId: "MODIS/061/MOD13Q1",
      url: modis.url,
      name: "MODIS",
      coverage: "2000-2020",
      spatialResolution: "250 m",
      advantages: "直接提供 NDVI",
      limitations: "空间分辨率较粗",
      recommendation: "用于稳健性对照"
    },
    {
      datasetId: "COPERNICUS/S2_SR_HARMONIZED",
      url: sentinel.url,
      name: "Sentinel-2",
      coverage: "2017-2026",
      spatialResolution: "10-60 m",
      advantages: "空间分辨率高、重访周期短",
      limitations: "2017 年才开始，不覆盖 2000-2020 完整时段",
      recommendation: "仅作为后期空间细节补充，不作为长序列主数据"
    }
  ],
  requirements: {
    area: "广州市官方行政区边界",
    timeRange: "2000-01-01 至 2020-12-31",
    temporalAggregation: "每年中位数合成后求均值",
    spatialStatistic: "区域内像元均值",
    qualityControl: "Landsat C2 QA 云/阴影掩膜，并统一 NDVI 标度"
  },
  method: "按年合成、计算 NDVI、reduceRegion 并导出年度表格与趋势图。",
  outputs: ["年度 NDVI 均值 CSV", "趋势图"],
  questions: []
};
assert.equal(validatePlanResponse(ready, merged).valid, true);
assert.match(
  validatePlanResponse(ready, merged, { requireTodoWorkflow: true }).errors.join("\n"),
  /requires field phase/
);

const todoTasks = [
  {
    id: "todo_1",
    title: "拆解分析需求",
    objective: "识别目标、时空范围、统计口径和输出",
    evidenceNeeded: ["用户原始需求"],
    status: "completed",
    result: "已识别 NDVI、广州市、2000-2020 年和年度变化目标"
  },
  {
    id: "todo_2",
    title: "核验官方数据集",
    objective: "核验候选数据集身份与覆盖期",
    evidenceNeeded: ["Earth Engine Data Catalog"],
    status: "completed",
    result: "已核验 Landsat、MODIS 和 Sentinel-2 官方条目"
  },
  {
    id: "todo_3",
    title: "澄清统计口径",
    objective: "确认年度合成和区域统计定义",
    evidenceNeeded: ["用户明确选择"],
    status: "in_progress",
    result: ""
  },
  {
    id: "todo_4",
    title: "形成可审阅方案",
    objective: "整合数据、方法、风险和输出",
    evidenceNeeded: ["已完成任务与用户答复"],
    status: "pending",
    result: ""
  }
];
const todoClarifying = {
  status: "needs_clarification",
  phase: "clarifying",
  todoList: todoTasks,
  completedThisTurn: ["todo_1", "todo_2"],
  currentTodoId: "todo_3",
  nextTodoId: "todo_4",
  goal: ready.goal,
  researchSummary: "MODIS 覆盖完整时段，Landsat 可提供更高空间分辨率但需跨传感器一致化。",
  datasets: ready.datasets,
  requirements: {
    ...ready.requirements,
    temporalAggregation: "待用户确认"
  },
  method: ["核验数据集", "确认统计口径后形成方案"],
  outputs: ready.outputs,
  assumptions: [],
  risks: ["跨传感器长序列需要一致化"],
  revisionSummary: ["首次建立 TODO 并完成官方数据集核验"],
  questions: [{
    id: "aggregation",
    prompt: "如何定义年度 NDVI 均值？",
    options: [
      { id: "annual", label: "逐年均值", description: "每年全部有效观测聚合", recommended: true },
      { id: "seasonal", label: "生长季均值", description: "只统计指定月份", recommended: false }
    ],
    allowFreeText: true
  }]
};
let todoSession = createPlanSession("计算 2000-2020 年广州市 NDVI 均值变化", { workflow: "todo_v1" });
todoSession = { ...todoSession, sources: merged };
assert.equal(todoSession.workflow, "todo_v1");
assert.equal(validatePlanResponse(todoClarifying, merged, { requireTodoWorkflow: true }).valid, true);
const safeTodoFallback = createSafeTodoFallbackPlan("计算广州市 NDVI");
const safeTodoValidation = validatePlanResponse(safeTodoFallback, [], { requireTodoWorkflow: true });
assert.equal(safeTodoValidation.valid, true, safeTodoValidation.errors.join("\n"));
assert.equal(safeTodoFallback.todoList.length, 4);
assert.equal(safeTodoFallback.status, "needs_clarification");
assert.equal(safeTodoFallback.datasets.length, 0, "local fallback must not retain unverified dataset claims");
assert.equal(safeTodoFallback.questions[0].options.length, 2);
todoSession = applyPlanResponse(todoSession, todoClarifying);
assert.equal(todoSession.plan.todoList.length, 4);
assert.equal(todoSession.plan.currentTodoId, "todo_3");
todoSession = addPlanAnswer(todoSession, "选择逐年均值。");
const todoReady = {
  ...ready,
  phase: "reviewing",
  todoList: todoTasks.map((todo) => ({
    ...todo,
    status: "completed",
    result: todo.result || (todo.id === "todo_3" ? "用户选择逐年均值" : "已形成可审阅方案")
  })),
  completedThisTurn: ["todo_3", "todo_4"],
  currentTodoId: "",
  nextTodoId: "",
  researchSummary: "已核验官方来源并明确逐年均值口径。",
  assumptions: [],
  risks: ["Landsat 跨传感器一致化"],
  revisionSummary: ["按用户答复确定逐年均值并完成方案"]
};
assert.equal(validatePlanResponse(todoReady, merged, { requireTodoWorkflow: true }).valid, true);
todoSession = applyPlanResponse(todoSession, todoReady);
assert.equal(todoSession.state, "ready");
assert.equal(restorePlanSession(serializePlanSession(todoSession)).workflow, "todo_v1");

const independentlyCompletedTodo = structuredClone(todoClarifying);
independentlyCompletedTodo.todoList[1].status = "pending";
independentlyCompletedTodo.todoList[1].result = "";
independentlyCompletedTodo.todoList[2].status = "completed";
independentlyCompletedTodo.todoList[2].result = "官方来源调研可独立完成";
independentlyCompletedTodo.completedThisTurn = ["todo_1", "todo_3"];
independentlyCompletedTodo.currentTodoId = "";
independentlyCompletedTodo.nextTodoId = "todo_2";
assert.equal(
  validatePlanResponse(independentlyCompletedTodo, merged, { requireTodoWorkflow: true }).valid,
  true,
  "independent research may complete while an earlier clarification remains pending"
);

const multipleInProgress = structuredClone(todoClarifying);
multipleInProgress.todoList[1].status = "in_progress";
assert.match(
  validatePlanResponse(multipleInProgress, merged, { requireTodoWorkflow: true }).errors.join("\n"),
  /at most one in_progress/
);
const prematureSession = { ...createPlanSession("计算 2000-2020 年广州市 NDVI 均值变化"), sources: merged };
assert.throws(
  () => applyPlanResponse(prematureSession, ready),
  /at least one user clarification/
);
session = addPlanAnswer(session, "使用 GADM/GAUL 中可复现的广州市边界，并采用推荐年均口径。");
assert.equal(session.state, "clarifying");
assert.equal(session.planStale, true);
assert.equal(session.revision, 2);
session = applyPlanResponse(session, ready);
assert.equal(session.state, "ready");
assert.equal(session.revision, 3);
assert.equal(session.planRevision, 2);

const sentinelOnly = {
  ...structuredClone(ready),
  datasets: [{
    ...structuredClone(ready.datasets[2]),
    coverage: "2000-2020",
    limitations: "空间分辨率高",
    recommendation: "作为唯一主数据"
  }]
};
const sentinelBypass = validatePlanResponse(sentinelOnly, [sentinel], {
  originalRequest: "计算 2000-2020 年广州市 NDVI 均值变化"
});
assert.equal(sentinelBypass.valid, false);
assert.match(sentinelBypass.errors.join("\n"), /conflicts with the official Dataset Availability/);
assert.match(sentinelBypass.errors.join("\n"), /cannot be a primary dataset/);
assert.match(sentinelBypass.errors.join("\n"), /officially verified dataset covering the requested period/);
assert.match(sentinelBypass.errors.join("\n"), /official Landsat candidate/);
assert.match(sentinelBypass.errors.join("\n"), /official MODIS candidate/);

const unmatched = structuredClone(ready);
unmatched.datasets[0].datasetId = "COPERNICUS/S1_GRD";
unmatched.datasets[0].url = "https://developers.google.com/earth-engine/datasets/catalog/COPERNICUS_S1_GRD";
assert.equal(validatePlanResponse(unmatched, merged).valid, false);

const mismatchedUrl = structuredClone(ready);
mismatchedUrl.datasets[0].url = "https://not-an-official-source.invalid/catalog";
assert.equal(validatePlanResponse(mismatchedUrl, merged).valid, false);

const mismatchedPair = structuredClone(ready);
mismatchedPair.datasets[0].url = modis.url;
assert.equal(validatePlanResponse(mismatchedPair, merged).valid, false);

const revised = addPlanAnswer(session, "只统计 4 月到 10 月。");
assert.equal(revised.state, "clarifying");
assert.equal(revised.planStale, true);
assert.equal(revised.userTurns.at(-1), "只统计 4 月到 10 月。");
assert.equal(revised.revision, 4);
assert.equal(revised.planRevision, 2);

const stored = JSON.parse(serializePlanSession(setPlanState(revised, "researching")));
stored.apiKey = "must not persist";
stored.console = "must not persist";
const restored = restorePlanSession(stored);
assert.equal(restored.state, "clarifying");
assert.equal(restored.stableState, "clarifying");
assert.equal(restored.planRevision, 2);
assert.equal("apiKey" in restored, false);
assert.equal("console" in restored, false);
assert.equal(restorePlanSession("not json"), null);

const redactedPlan = createPlanSession("分析 NDVI，令牌 Bearer abcdefghijklmnopqrstuvwxyz");
assert.equal(redactedPlan.originalRequest, "分析 NDVI，令牌 Bearer [已隐藏令牌]");
const redactedAnswer = addPlanAnswer(redactedPlan, "API Key 是 sk-abcdefghijklmnopqrstuvwxyz");
assert.equal(redactedAnswer.userTurns[0], "API Key 是 [已隐藏 API Key]");

const validInterrupted = sanitizePlanSession({
  originalRequest: "x",
  state: "generating",
  stableState: "ready",
  userTurns: ["确认默认方案"],
  plan: ready,
  sources: merged
});
assert.equal(validInterrupted.state, "ready");

const corruptedReady = restorePlanSession({
  originalRequest: "x",
  state: "ready",
  stableState: "ready",
  plan: ready,
  sources: []
});
assert.equal(corruptedReady.state, "clarifying");
assert.equal(corruptedReady.stableState, "clarifying");
assert.equal(corruptedReady.planStale, true);

const poisonedReady = restorePlanSession({
  originalRequest: "x",
  state: "ready",
  stableState: "ready",
  plan: ready,
  sources: ready.datasets.map((dataset) => ({
    type: "dataset",
    datasetId: dataset.datasetId,
    url: dataset.url.replace("https://developers.google.com/earth-engine", "https://fake.example")
  }))
});
assert.equal(poisonedReady.state, "clarifying");
assert.equal(poisonedReady.planStale, true);

const mixedOfficialIdentity = restorePlanSession({
  originalRequest: "x",
  state: "ready",
  stableState: "ready",
  plan: ready,
  sources: [
    { ...landsat, url: modis.url },
    modis
  ]
});
assert.equal(mixedOfficialIdentity.state, "clarifying");
assert.equal(mixedOfficialIdentity.planStale, true);

const malformedTodoPlan = {
  status: "needs_clarification",
  phase: "decomposing",
  todoList: [
    {
      id: "todo_1",
      title: "解析需求",
      objective: "提取分析范围",
      evidenceNeeded: ["用户需求"],
      status: "pending",
      result: ""
    },
    {
      id: "todo_1",
      title: "核验数据",
      objective: "核验候选数据集",
      evidenceNeeded: ["官方目录"],
      status: "in_progress",
      result: ""
    }
  ],
  completedThisTurn: ["missing"],
  currentTodoId: "missing",
  nextTodoId: "todo_1",
  goal: "设计广州 NDVI 方案",
  researchSummary: "",
  datasets: [],
  requirements: {},
  method: [],
  outputs: [],
  assumptions: [],
  risks: [],
  revisionSummary: [],
  questions: []
};
const canonicalTodo = canonicalizeTodoPlanStructure(malformedTodoPlan, {
  originalRequest: "设计广州 NDVI 方案"
});
assert.equal(canonicalTodo.plan.todoList.length, 4);
assert.equal(new Set(canonicalTodo.plan.todoList.map((todo) => todo.id)).size, 4);
assert.equal(canonicalTodo.plan.todoList.filter((todo) => todo.status === "in_progress").length, 1);
assert.equal(canonicalTodo.plan.currentTodoId, canonicalTodo.plan.todoList.find((todo) => todo.status === "in_progress").id);
assert.equal(canonicalTodo.plan.questions.length, 1);
assert.equal(validatePlanResponse(canonicalTodo.plan, [], { requireTodoWorkflow: true }).valid, true);

console.log("Plan tests passed.");

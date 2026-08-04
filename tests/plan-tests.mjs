import assert from "node:assert/strict";
import {
  addPlanAnswer,
  applyPlanResponse,
  createPlanSession,
  mergeSources,
  parsePlanResponse,
  restorePlanSession,
  sanitizePlanSession,
  serializePlanSession,
  setPlanState,
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
session = applyPlanResponse(session, ready);
assert.equal(session.state, "ready");
assert.equal(session.revision, 2);

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
assert.equal(revised.revision, 3);

const stored = JSON.parse(serializePlanSession(setPlanState(revised, "researching")));
stored.apiKey = "must not persist";
stored.console = "must not persist";
const restored = restorePlanSession(stored);
assert.equal(restored.state, "clarifying");
assert.equal(restored.stableState, "clarifying");
assert.equal("apiKey" in restored, false);
assert.equal("console" in restored, false);
assert.equal(restorePlanSession("not json"), null);

const validInterrupted = sanitizePlanSession({
  originalRequest: "x",
  state: "generating",
  stableState: "ready",
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

console.log("Plan tests passed.");

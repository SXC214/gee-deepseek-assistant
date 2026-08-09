import assert from "node:assert/strict";
import {
  GEE_ERROR_PATTERNS,
  GEE_PERFORMANCE_GUIDELINES,
  createGeeErrorSection,
  matchGeeErrors
} from "../lib/gee-errors.js";

// 守则数组：长度与内容校验
assert.equal(Array.isArray(GEE_PERFORMANCE_GUIDELINES), true);
assert.ok(GEE_PERFORMANCE_GUIDELINES.length >= 6 && GEE_PERFORMANCE_GUIDELINES.length <= 8);
for (const guideline of GEE_PERFORMANCE_GUIDELINES) {
  assert.equal(typeof guideline, "string");
  assert.ok(guideline.trim().length > 0);
}
assert.ok(GEE_PERFORMANCE_GUIDELINES.some((g) => g.includes("filterBounds") && g.includes("filterDate")));
assert.ok(GEE_PERFORMANCE_GUIDELINES.some((g) => g.includes("bestEffort") && g.includes("maxPixels")));
assert.ok(GEE_PERFORMANCE_GUIDELINES.some((g) => g.includes("Export")));

// 模式数组：结构完整性
assert.ok(GEE_ERROR_PATTERNS.length >= 6);
const ids = new Set();
for (const entry of GEE_ERROR_PATTERNS) {
  assert.equal(typeof entry.id, "string");
  assert.equal(Array.isArray(entry.patterns), true);
  assert.ok(entry.patterns.length > 0);
  assert.ok(entry.title.trim().length > 0);
  assert.ok(entry.diagnosis.trim().length > 0);
  assert.ok(entry.fixes.length > 0);
  assert.match(entry.docUrl, /^https:\/\/developers\.google\.com\/earth-engine\//);
  assert.equal(ids.has(entry.id), false);
  ids.add(entry.id);
}

// 每条模式的真实错误文案命中
const realMessages = {
  "too-many-concurrent": "Error: Too many concurrent aggregations. Please wait and try again.",
  "user-memory-limit": "Image.reduceRegion: User memory limit exceeded.",
  "computation-timeout": "Error: Computation timed out. Try reducing the scale of the computation.",
  "collection-too-large": "Collection is too large to iterate over in this context.",
  "too-many-bands": "Image.toBands: Too many bands (max 512).",
  "too-many-pixels": "Error: Too many pixels. Try reducing the resolution or region size."
};
for (const [id, message] of Object.entries(realMessages)) {
  const matches = matchGeeErrors(message);
  assert.equal(matches.length, 1, `${id} 应命中且仅命中一条`);
  assert.equal(matches[0].id, id);
}

// 大小写与变体
assert.equal(matchGeeErrors("TOO MANY CONCURRENT AGGREGATIONS")[0].id, "too-many-concurrent");
assert.equal(matchGeeErrors("Exceeded memory limit while evaluating")[0].id, "user-memory-limit");
assert.equal(matchGeeErrors("Deadline exceeded for computation")[0].id, "computation-timeout");
assert.equal(matchGeeErrors("Too Many Elements in the Collection")[0].id, "collection-too-large");
assert.equal(matchGeeErrors("Number of bands exceeds the maximum")[0].id, "too-many-bands");
assert.equal(matchGeeErrors("The resulting image is too large")[0].id, "too-many-pixels");
assert.equal(matchGeeErrors("exceeds the maximum allowed size")[0].id, "too-many-pixels");

// 多条同时命中：保持定义顺序
const mixed = matchGeeErrors("User memory limit exceeded.\nComputation timed out.\nToo many pixels.");
assert.deepEqual(mixed.map((entry) => entry.id), ["user-memory-limit", "computation-timeout", "too-many-pixels"]);

// 多条模式命中同一错误时去重
assert.equal(matchGeeErrors("User memory limit exceeded; exceeded memory limit").length, 1);

// 空与非字符串输入
assert.deepEqual(matchGeeErrors(""), []);
assert.deepEqual(matchGeeErrors("   "), []);
assert.deepEqual(matchGeeErrors(null), []);
assert.deepEqual(matchGeeErrors(undefined), []);
assert.deepEqual(matchGeeErrors(42), []);
assert.deepEqual(matchGeeErrors({}), []);
assert.deepEqual(matchGeeErrors("everything is fine, no errors"), []);

// createGeeErrorSection：空返回
assert.equal(createGeeErrorSection([]), "");
assert.equal(createGeeErrorSection(null), "");
assert.equal(createGeeErrorSection(undefined), "");

// createGeeErrorSection：格式校验
const section = createGeeErrorSection(matchGeeErrors("Too many concurrent aggregations.\nToo many pixels."));
assert.match(section, /^Earth Engine 运行时错误诊断（来自 Console）/);
assert.match(section, /并发聚合请求过多（too-many-concurrent）/);
assert.match(section, /像素数过多（too-many-pixels）/);
assert.match(section, /诊断：/);
assert.match(section, /修复方向：/);
assert.match(section, /- /);
assert.match(section, /官方文档：https:\/\/developers\.google\.com\/earth-engine\//);
// 顺序与编号
assert.ok(section.indexOf("1. 并发聚合请求过多") < section.indexOf("2. 像素数过多"));
// 传入重复项时去重
assert.equal(createGeeErrorSection([GEE_ERROR_PATTERNS[0], GEE_ERROR_PATTERNS[0]]).match(/诊断：/g).length, 1);

console.log("GEE error tests passed.");

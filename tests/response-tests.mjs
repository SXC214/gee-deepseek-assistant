import assert from "node:assert/strict";
import { extractCodeCandidate } from "../lib/response.js";

// Single fenced block is returned unchanged.
assert.equal(
  extractCodeCandidate("说明\n```javascript\nvar image = ee.Image('X');\nMap.addLayer(image);\n```\n结尾"),
  "var image = ee.Image('X');\nMap.addLayer(image);"
);

// Multiple blocks: the longest block is a non-GEE explanation snippet, so the
// GEE-signalled block must win even though it is shorter.
const longNonGee = `// 这是一段很长的解释性伪代码，不含任何 GEE 信号
${"// 说明行，用来把块撑长，模拟模型先给示例再给脚本的场景\n".repeat(40)}function example() { return 1; }`;
const geeScript = "var ndvi = image.normalizedDifference(['B5', 'B4']);\nMap.addLayer(ndvi);";
assert.equal(
  extractCodeCandidate(`先看示例：\n\`\`\`js\n${longNonGee}\n\`\`\`\n再给完整脚本：\n\`\`\`javascript\n${geeScript}\n\`\`\``),
  geeScript
);

// Multiple GEE-signalled blocks: the last one wins (final code at the end).
const firstGee = "ee.Image('OLD');";
const lastGee = "ee.Image('NEW');\nMap.centerObject(image);";
assert.equal(
  extractCodeCandidate(`初版：\n\`\`\`js\n${firstGee}\n\`\`\`\n修订版：\n\`\`\`js\n${lastGee}\n\`\`\``),
  lastGee
);

// No GEE signal anywhere: fall back to the last fenced block, not the longest.
assert.equal(
  extractCodeCandidate("```\nfirst block without any GEE signal but long enough to win a naive length sort\n```\n```\nlast\n```"),
  "last"
);

// A complete script followed by a short usage example: scoring (GEE signal
// +2, substantial length +1, last position only breaks ties) must keep the
// complete script instead of the trailing one-liner.
const fullScript = [
  "var image = ee.Image('LANDSAT/LC08/C02/T1_L2/LC08_044034_20140318');",
  "var ndvi = image.normalizedDifference(['SR_B5', 'SR_B4']).rename('NDVI');",
  "Map.addLayer(ndvi, { min: 0, max: 1 }, 'NDVI');",
  "Map.centerObject(image, 9);"
].join("\n");
const usageExample = "Map.addLayer(ndvi);";
assert.equal(
  extractCodeCandidate(`完整脚本：\n\`\`\`javascript\n${fullScript}\n\`\`\`\n用法：\n\`\`\`js\n${usageExample}\n\`\`\``),
  fullScript
);

// Tie-break by position still applies among equally scored GEE blocks even
// when one of them is substantial: equal score means the later block wins.
const longDraft = `${fullScript}\nprint('draft');`;
const longFinal = `${fullScript}\nprint('final');`;
assert.equal(
  extractCodeCandidate(`草稿：\n\`\`\`js\n${longDraft}\n\`\`\`\n终稿：\n\`\`\`js\n${longFinal}\n\`\`\``),
  longFinal
);

// Unfenced fallback paths are unaffected.
assert.equal(
  extractCodeCandidate("下面是完整脚本：\nvar image = ee.Image('X');\nMap.addLayer(image);"),
  "var image = ee.Image('X');\nMap.addLayer(image);"
);
assert.equal(extractCodeCandidate("普通解释，没有代码"), "");

console.log("Response extraction tests passed.");

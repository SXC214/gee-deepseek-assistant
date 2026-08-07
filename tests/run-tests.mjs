import assert from "node:assert/strict";
import { createLineDiff } from "../lib/diff.js";
import { extractCodeCandidate, stripCodeFences } from "../lib/response.js";

const diff = createLineDiff("a\nb\nc", "a\nx\nc\nd");
assert.equal(diff.additions, 2);
assert.equal(diff.removals, 1);
assert.deepEqual(
  diff.entries.filter((entry) => entry.type !== "context"),
  [
    { type: "remove", text: "b" },
    { type: "add", text: "x" },
    { type: "add", text: "d" }
  ]
);

const response = "说明文字\n```javascript\nvar image = ee.Image('X');\nMap.addLayer(image);\n```";
assert.equal(extractCodeCandidate(response), "var image = ee.Image('X');\nMap.addLayer(image);");
assert.equal(stripCodeFences(response), "说明文字\n[代码见下方修改预览]");
assert.equal(
  extractCodeCandidate("下面是完整脚本：\nvar image = ee.Image('X');\nMap.addLayer(image);"),
  "var image = ee.Image('X');\nMap.addLayer(image);"
);
assert.equal(
  extractCodeCandidate("建议如下：\r\n// GEE 脚本\r\nprint(ee.Image('X'));"),
  "// GEE 脚本\nprint(ee.Image('X'));"
);
assert.equal(extractCodeCandidate("普通解释，没有代码"), "");

console.log("All tests passed.");

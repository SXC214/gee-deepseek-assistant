import assert from "node:assert/strict";
import {
  extractGeeDatasetIds,
  formatValidationRepairPrompt,
  sanitizeGeeValidation,
  scanJavaScriptStructure,
  validateGeeCandidate
} from "../lib/gee-validator.js";

const validCode = [
  "var images = ee.ImageCollection('COPERNICUS/S2_SR_HARMONIZED')",
  "  .filterDate('2024-01-01', '2024-12-31');",
  "var slash = /[{}]/g;",
  "Map.addLayer(images.median(), {}, 'S2');"
].join("\n");
const source = {
  datasetId: "COPERNICUS/S2_SR_HARMONIZED",
  url: "https://developers.google.com/earth-engine/datasets/catalog/COPERNICUS_S2_SR_HARMONIZED"
};
const plan = {
  datasets: [{ datasetId: "COPERNICUS/S2_SR_HARMONIZED" }],
  requirements: { timeRange: "2024-01-01 至 2024-12-31" }
};
const valid = validateGeeCandidate({ code: validCode, plan, sources: [source] });
assert.equal(valid.status, "passed");
assert.deepEqual(valid.datasetIds, ["COPERNICUS/S2_SR_HARMONIZED"]);
assert.equal(valid.checks.every((item) => item.status === "passed"), true);
assert.equal(sanitizeGeeValidation(valid).status, "passed");

const blocked = validateGeeCandidate({
  code: "```javascript\nvar x = document.querySelector('body');\nfetch('https://x');\nMap.addLayer(x;\n```"
});
assert.equal(blocked.status, "failed");
assert.ok(blocked.checks.some((item) => item.id === "javascript_structure" && item.status === "failed"));
assert.ok(blocked.checks.some((item) => item.id === "gee_runtime_surface" && item.status === "failed"));
assert.match(formatValidationRepairPrompt(blocked), /唯一一次自动修复/);

const unverified = validateGeeCandidate({
  code: "var x = ee.Image('FAKE/DATASET'); Map.addLayer(x);",
  sources: [source]
});
assert.equal(unverified.status, "warning");
assert.match(unverified.checks.find((item) => item.id === "dataset_evidence").detail, /FAKE\/DATASET/);

const privateAsset = validateGeeCandidate({
  code: "var x = ee.FeatureCollection('projects/my-project/assets/aoi'); Map.addLayer(x);"
});
assert.equal(privateAsset.checks.find((item) => item.id === "dataset_evidence").status, "passed");

const secret = validateGeeCandidate({
  code: `var key = "${"AIza"}${"a".repeat(35)}"; print(key);`
});
assert.equal(secret.status, "failed");
assert.equal(secret.checks.find((item) => item.id === "secret_exposure").status, "failed");

assert.deepEqual(
  extractGeeDatasetIds("ee.Image('A/B'); ee.ImageCollection(\"C/D\"); ee.Image('A/B');"),
  ["A/B", "C/D"]
);
assert.equal(scanJavaScriptStructure("var ratio = total / count; var re = /[()]/;").ok, true);
assert.equal(scanJavaScriptStructure("var x = {a: [1, 2};").ok, false);
assert.notEqual(
  validateGeeCandidate({ code: "// document.querySelector and fetch are mentioned in a comment\nprint('window.fetch');" }).status,
  "failed",
  "comments and string contents must not trigger forbidden-runtime checks"
);
assert.equal(sanitizeGeeValidation({ checks: [] }), null);

console.log("GEE candidate validator tests passed.");

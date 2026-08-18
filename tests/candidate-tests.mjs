import assert from "node:assert/strict";
import {
  createCodeCandidate,
  markCodeCandidateApplied,
  sanitizeCodeCandidate
} from "../lib/candidate.js";

const ready = createCodeCandidate({
  code: "var image = ee.Image('X');\r\nMap.addLayer(image);",
  baseCode: "print('old');",
  baseRevision: "revision-1",
  tabId: 42,
  planRevision: 3,
  validation: {
    status: "warning",
    summary: "需核验",
    checks: [{ id: "dataset_evidence", label: "数据集来源", status: "warning", detail: "待核验" }],
    datasetIds: ["X"],
    createdAt: 99
  },
  createdAt: 100,
  apiKey: "must not survive"
});
assert.equal(ready.code.includes("\r"), false);
assert.equal(ready.status, "ready");
assert.equal(ready.schemaVersion, 2);
assert.equal(ready.validation.status, "warning");
assert.equal("apiKey" in ready, false);

const applied = markCodeCandidateApplied(ready, "replace_all", 200);
assert.equal(applied.status, "applied");
assert.equal(applied.applicationMode, "replace_all");
assert.equal(applied.appliedAt, 200);
assert.equal(sanitizeCodeCandidate(applied).code, ready.code);
assert.equal(sanitizeCodeCandidate(applied).validation.checks[0].id, "dataset_evidence");
assert.equal(sanitizeCodeCandidate({ code: "" }), null);
assert.equal(sanitizeCodeCandidate("bad"), null);
assert.throws(() => markCodeCandidateApplied(ready, "unknown"), /Unknown/);

console.log("Candidate persistence tests passed.");

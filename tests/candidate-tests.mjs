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
  createdAt: 100,
  apiKey: "must not survive"
});
assert.equal(ready.code.includes("\r"), false);
assert.equal(ready.status, "ready");
assert.equal("apiKey" in ready, false);

const applied = markCodeCandidateApplied(ready, "replace_all", 200);
assert.equal(applied.status, "applied");
assert.equal(applied.applicationMode, "replace_all");
assert.equal(applied.appliedAt, 200);
assert.equal(sanitizeCodeCandidate(applied).code, ready.code);
assert.equal(sanitizeCodeCandidate({ code: "" }), null);
assert.equal(sanitizeCodeCandidate("bad"), null);
assert.throws(() => markCodeCandidateApplied(ready, "unknown"), /Unknown/);

console.log("Candidate persistence tests passed.");

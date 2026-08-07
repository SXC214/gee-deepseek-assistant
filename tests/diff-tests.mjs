import assert from "node:assert/strict";
import { createLineDiff } from "../lib/diff.js";

function splitLines(text) {
  return String(text ?? "").replace(/\r\n/g, "\n").split("\n");
}

// Entries must consume the before-text exactly and reconstruct the after-text.
function assertValidDiff(beforeText, afterText, diff) {
  const before = splitLines(beforeText);
  const after = [];
  let index = 0;
  for (const entry of diff.entries) {
    if (entry.type === "context") {
      assert.equal(entry.text, before[index], "context entry must match the before-text");
      index += 1;
      after.push(entry.text);
    } else if (entry.type === "remove") {
      index += 1;
    } else {
      assert.equal(entry.type, "add");
      after.push(entry.text);
    }
  }
  assert.equal(index, before.length, "every before line is consumed");
  assert.equal(after.join("\n"), splitLines(afterText).join("\n"), "entries reconstruct the after-text");
  assert.equal(diff.additions, diff.entries.filter((entry) => entry.type === "add").length);
  assert.equal(diff.removals, diff.entries.filter((entry) => entry.type === "remove").length);
}

function makeLines(count, prefix = "line") {
  return Array.from({ length: count }, (_unused, index) => `var ${prefix}${index} = ${index};`);
}

// Small diff: exact line-level entries with delete-before-insert ordering.
{
  const diff = createLineDiff("a\nb\nc", "a\nx\nc\nd");
  assertValidDiff("a\nb\nc", "a\nx\nc\nd", diff);
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
}

// Pure insertion and pure deletion stay line-level.
{
  const diff = createLineDiff("a\nc", "a\nb\nc");
  assertValidDiff("a\nc", "a\nb\nc", diff);
  assert.deepEqual(diff.entries.filter((entry) => entry.type !== "context"), [{ type: "add", text: "b" }]);

  const deletion = createLineDiff("a\nb\nc", "a\nc");
  assertValidDiff("a\nb\nc", "a\nc", deletion);
  assert.deepEqual(deletion.entries.filter((entry) => entry.type !== "context"), [{ type: "remove", text: "b" }]);
}

// Identical inputs produce an empty diff (no adds, no removals).
{
  const diff = createLineDiff("a\nb\nc", "a\nb\nc");
  assertValidDiff("a\nb\nc", "a\nb\nc", diff);
  assert.equal(diff.additions, 0);
  assert.equal(diff.removals, 0);

  const huge = makeLines(6000).join("\n");
  const hugeDiff = createLineDiff(huge, huge);
  assert.equal(hugeDiff.additions, 0);
  assert.equal(hugeDiff.removals, 0);
  assert.equal(hugeDiff.entries.length, 6000);
}

// Scripts well beyond the old 600-line LCS threshold still diff line-level.
{
  const before = makeLines(800);
  const after = before.slice();
  after[300] = "var changed300 = true;";
  after[301] = "var changed301 = true;";
  after[302] = "var changed302 = true;";
  const diff = createLineDiff(before.join("\n"), after.join("\n"));
  assertValidDiff(before.join("\n"), after.join("\n"), diff);
  assert.equal(diff.removals, 3);
  assert.equal(diff.additions, 3);
  assert.deepEqual(
    diff.entries.filter((entry) => entry.type !== "context").slice(0, 3).map((entry) => entry.type),
    ["remove", "remove", "remove"],
    "changed lines are paired edits, not a whole-block replacement"
  );
}

// Larger edits inside the budget stay line-level on long scripts.
{
  const before = makeLines(2000);
  const after = [...before.slice(0, 100), ...makeLines(40, "inserted"), ...before.slice(100)];
  after[1500] = "var replaced = 1;";
  const beforeText = before.join("\n");
  const afterText = after.join("\n");
  const diff = createLineDiff(beforeText, afterText);
  assertValidDiff(beforeText, afterText, diff);
  assert.equal(diff.additions, 41, "40 inserted lines plus 1 replacement");
  assert.equal(diff.removals, 1);
}

// Extreme divergence falls back to the coarse whole-block diff.
{
  const before = makeLines(1200, "left");
  const after = makeLines(1200, "right");
  const diff = createLineDiff(before.join("\n"), after.join("\n"));
  assertValidDiff(before.join("\n"), after.join("\n"), diff);
  assert.equal(diff.removals, 1200);
  assert.equal(diff.additions, 1200);
  assert.equal(diff.entries[0].type, "remove");
  assert.equal(diff.entries[1199].type, "remove");
  assert.equal(diff.entries[1200].type, "add", "coarse shape: all removals before all additions");
}

// Huge wildly-different inputs (>5000 lines each) skip Myers via the guard.
{
  const before = makeLines(5200, "left");
  const after = makeLines(5200, "right");
  const started = Date.now();
  const diff = createLineDiff(before.join("\n"), after.join("\n"));
  const elapsed = Date.now() - started;
  assertValidDiff(before.join("\n"), after.join("\n"), diff);
  assert.equal(diff.removals, 5200);
  assert.equal(diff.additions, 5200);
  assert.ok(elapsed < 1000, `guard should keep huge divergent inputs fast, took ${elapsed}ms`);
}

// Performance: 5000-line scripts with scattered small edits stay line-level
// and return well under a second.
{
  const before = makeLines(5000);
  const after = before.slice();
  for (const index of [17, 512, 1000, 1999, 2500, 3000, 3456, 4000, 4321, 4990]) {
    after[index] = `var line${index} = ${index} * 2;`;
  }
  const beforeText = before.join("\n");
  const afterText = after.join("\n");
  const started = Date.now();
  const diff = createLineDiff(beforeText, afterText);
  const elapsed = Date.now() - started;
  assertValidDiff(beforeText, afterText, diff);
  assert.equal(diff.removals, 10);
  assert.equal(diff.additions, 10);
  assert.ok(elapsed < 1000, `5000-line diff with small edits must stay fast, took ${elapsed}ms`);
  console.log(`Diff performance: 5000-line input with 10 edits in ${elapsed}ms`);
}

// Performance: a long run of contiguous replacements near the budget edge.
{
  const before = makeLines(5000);
  const after = before.slice();
  for (let index = 2000; index < 2900; index += 1) after[index] = `var edited${index} = 0;`;
  const started = Date.now();
  const diff = createLineDiff(before.join("\n"), after.join("\n"));
  const elapsed = Date.now() - started;
  assertValidDiff(before.join("\n"), after.join("\n"), diff);
  assert.equal(diff.removals, 900);
  assert.equal(diff.additions, 900);
  assert.ok(elapsed < 1000, `5000-line diff with 900 edits must stay fast, took ${elapsed}ms`);
  console.log(`Diff performance: 5000-line input with 900 edits in ${elapsed}ms`);
}

console.log("Diff tests passed.");

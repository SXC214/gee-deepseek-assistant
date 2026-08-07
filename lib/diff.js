/**
 * Line diffing for candidate code previews. Uses a bounded Myers (O(ND))
 * scan so scripts of any length get a true line-level diff; only when the
 * edit distance provably exceeds the budget does it degrade to the coarse
 * whole-block diff. The public shape is unchanged: createLineDiff returns
 * { entries: [{ type, text }], additions, removals }.
 */

/** Maximum edit distance (D) the Myers scan will explore before giving up. */
const MYERS_EDIT_LIMIT = 2000;

/** Inputs longer than this on both sides get a cheap lower-bound pre-check. */
const HUGE_INPUT_LINES = 5000;

export function createLineDiff(beforeText, afterText, limit = MYERS_EDIT_LIMIT) {
  const before = splitLines(beforeText);
  const after = splitLines(afterText);

  // Identical or shared ends never need Myers: strip them and diff the middle.
  let prefix = 0;
  while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) prefix += 1;

  let suffix = 0;
  while (
    suffix < before.length - prefix &&
    suffix < after.length - prefix &&
    before[before.length - 1 - suffix] === after[after.length - 1 - suffix]
  ) suffix += 1;

  const head = before.slice(0, prefix).map((text) => ({ type: "context", text }));
  const tail = before.slice(before.length - suffix).map((text) => ({ type: "context", text }));
  const middleBefore = before.slice(prefix, before.length - suffix);
  const middleAfter = after.slice(prefix, after.length - suffix);

  if (!middleBefore.length && !middleAfter.length) {
    return summarize([...head, ...tail]);
  }

  // Guard: the length gap alone forces at least that many edits.
  let lowerBound = Math.abs(middleBefore.length - middleAfter.length);
  if (
    lowerBound <= limit &&
    middleBefore.length > HUGE_INPUT_LINES &&
    middleAfter.length > HUGE_INPUT_LINES
  ) {
    // Both sides are huge: estimate the multiset distance so wildly different
    // scripts skip the O(ND) scan instead of burning the whole budget in it.
    lowerBound = lowerBoundEdits(middleBefore, middleAfter);
  }
  if (lowerBound > limit) {
    return coarseDiff(before, after);
  }

  const middle = boundedMyersDiff(middleBefore, middleAfter, limit);
  if (!middle) return coarseDiff(before, after);
  return summarize([...head, ...middle, ...tail]);
}

/**
 * Greedy Myers shortest-edit scan bounded by limit. Returns line-level
 * entries for the middle segments, or null when the edit distance exceeds
 * the budget (caller falls back to coarseDiff). Deletion wins ties during
 * backtracking, matching the ordering the previous LCS pass produced.
 */
function boundedMyersDiff(before, after, limit) {
  const n = before.length;
  const m = after.length;
  const maxD = Math.min(limit, n + m);
  const offset = maxD + 1;
  const v = new Int32Array(2 * maxD + 3).fill(-1);
  v[1 + offset] = 0;
  const trace = [];

  let finalD = -1;
  for (let d = 0; d <= maxD && finalD < 0; d += 1) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x;
      if (k === -d || (k !== d && v[k - 1 + offset] < v[k + 1 + offset])) {
        x = v[k + 1 + offset]; // move down: insert from after
      } else {
        x = v[k - 1 + offset] + 1; // move right: delete from before
      }
      let y = x - k;
      while (x < n && y < m && before[x] === after[y]) {
        x += 1;
        y += 1;
      }
      v[k + offset] = x;
      if (x >= n && y >= m) {
        finalD = d;
        break;
      }
    }
  }
  if (finalD < 0) return null;
  if (finalD === 0) {
    return before.map((text) => ({ type: "context", text }));
  }

  // Walk the trace backwards to reconstruct the edit path.
  const reversed = [];
  let x = n;
  let y = m;
  for (let d = finalD; d > 0; d -= 1) {
    const vPrev = trace[d];
    const k = x - y;
    const inserted = k === -d || (k !== d && vPrev[k - 1 + offset] < vPrev[k + 1 + offset]);
    const prevK = inserted ? k + 1 : k - 1;
    const prevX = vPrev[prevK + offset];
    const prevY = prevX - prevK;
    const startX = inserted ? prevX : prevX + 1;
    const startY = inserted ? prevY + 1 : prevY;
    while (x > startX && y > startY) {
      x -= 1;
      y -= 1;
      reversed.push({ type: "context", text: before[x] });
    }
    if (inserted) {
      y -= 1;
      reversed.push({ type: "add", text: after[y] });
    } else {
      x -= 1;
      reversed.push({ type: "remove", text: before[x] });
    }
  }
  while (x > 0 && y > 0) {
    x -= 1;
    y -= 1;
    reversed.push({ type: "context", text: before[x] });
  }
  return reversed.reverse();
}

/** Multiset distance: edits are at least unmatched lines on both sides. */
function lowerBoundEdits(before, after) {
  const counts = new Map();
  for (const line of before) counts.set(line, (counts.get(line) || 0) + 1);
  let matched = 0;
  for (const line of after) {
    const count = counts.get(line) || 0;
    if (count > 0) {
      counts.set(line, count - 1);
      matched += 1;
    }
  }
  return before.length + after.length - 2 * matched;
}

function coarseDiff(before, after) {
  let prefix = 0;
  while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) prefix += 1;

  let suffix = 0;
  while (
    suffix < before.length - prefix &&
    suffix < after.length - prefix &&
    before[before.length - 1 - suffix] === after[after.length - 1 - suffix]
  ) suffix += 1;

  const entries = [
    ...before.slice(0, prefix).map((text) => ({ type: "context", text })),
    ...before.slice(prefix, before.length - suffix).map((text) => ({ type: "remove", text })),
    ...after.slice(prefix, after.length - suffix).map((text) => ({ type: "add", text })),
    ...before.slice(before.length - suffix).map((text) => ({ type: "context", text }))
  ];
  return summarize(entries);
}

function summarize(entries) {
  return {
    entries,
    additions: entries.filter((entry) => entry.type === "add").length,
    removals: entries.filter((entry) => entry.type === "remove").length
  };
}

function splitLines(text) {
  return String(text ?? "").replace(/\r\n/g, "\n").split("\n");
}

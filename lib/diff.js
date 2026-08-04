export function createLineDiff(beforeText, afterText, limit = 600) {
  const before = splitLines(beforeText);
  const after = splitLines(afterText);

  if (before.length > limit || after.length > limit) {
    return coarseDiff(before, after);
  }

  const table = Array.from({ length: before.length + 1 }, () => new Uint32Array(after.length + 1));
  for (let i = before.length - 1; i >= 0; i -= 1) {
    for (let j = after.length - 1; j >= 0; j -= 1) {
      table[i][j] = before[i] === after[j]
        ? table[i + 1][j + 1] + 1
        : Math.max(table[i + 1][j], table[i][j + 1]);
    }
  }

  const entries = [];
  let i = 0;
  let j = 0;
  while (i < before.length && j < after.length) {
    if (before[i] === after[j]) {
      entries.push({ type: "context", text: before[i] });
      i += 1;
      j += 1;
    } else if (table[i + 1][j] >= table[i][j + 1]) {
      entries.push({ type: "remove", text: before[i++] });
    } else {
      entries.push({ type: "add", text: after[j++] });
    }
  }
  while (i < before.length) entries.push({ type: "remove", text: before[i++] });
  while (j < after.length) entries.push({ type: "add", text: after[j++] });
  return summarize(entries);
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

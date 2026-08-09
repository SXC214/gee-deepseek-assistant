// Static validation of Earth Engine (`ee.*`) API calls against the locally
// generated official API index (lib/ee-api-index.json). Zero dependencies:
// comments and string literals are stripped first so symbols inside them are
// never reported, then literal `ee.` chains are matched and compared with the
// index. Instance chains such as `image.ndvi()` cannot be resolved statically
// and are intentionally out of scope.

const EE_SYMBOL_PATTERN = /\bee\.[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*){0,2}/g;

// Top-level functions/namespaces that are part of the public API surface but
// are not classes listed in the index.
const TOP_LEVEL_WHITELIST = new Set([
  "initialize", "authenticate", "load", "apply", "call", "require", "data", "batch"
]);

const MAX_UNKNOWN_REPORTS = 8;
const MAX_SUGGESTIONS = 3;
const MAX_SCRIPT_BYTES = 400 * 1024;

export const INDEX_VERSION_NOTE = "未在本地官方名单（生成于 {generatedAt}）中找到该符号，名单来源：{sourceUrl}";

const SENSITIVE_PATTERNS = [
  [/oauth[\s_-]*token|access[\s_-]*token|refresh[\s_-]*token|ya29\.[a-z0-9_-]{8,}/i, "OAuth token"],
  [/\bset-cookie\b|\bcookie\b/i, "Cookie"],
  [/\bxsrf([_-]?token)?\b|\bcsrf([_-]?token)?\b/i, "XSRF"],
  [/private[\s_-]*key|BEGIN[ A-Z]*PRIVATE KEY/i, "私钥"]
];

export function extractEeCalls(code) {
  const stripped = stripCommentsAndStrings(code);
  const matches = stripped.match(EE_SYMBOL_PATTERN) || [];
  return [...new Set(matches)];
}

export function validateEeCalls(code, { index, verifiedContext = "" } = {}) {
  const stripped = stripCommentsAndStrings(code);
  const context = String(verifiedContext || "");
  const classes = index && index.classes ? index.classes : {};
  const classNames = Object.keys(classes);
  const unknown = [];
  const decided = new Set();
  let verifiedByContext = 0;

  const recordUnknown = (symbol, name, candidates, className) => {
    if (decided.has(symbol)) return;
    decided.add(symbol);
    unknown.push({
      symbol,
      suggestions: suggestFrom(name, candidates),
      url: docsUrl(className)
    });
  };
  const recordVerified = (symbol) => {
    if (decided.has(symbol)) return;
    decided.add(symbol);
    verifiedByContext += 1;
  };

  // Walk every `ee.` literal chain segment by segment so that methods called
  // directly on a constructor (e.g. ee.Image.adBands(...)) are checked, while
  // instance chains through variables or call results stay out of scope.
  for (const match of stripped.matchAll(EE_SYMBOL_PATTERN)) {
    const segments = [match[0].split(".").slice(1)[0]];
    const chain = [];
    let exempt = match[0].split(".").length >= 4;
    // `end` tracks the offset right after the last consumed segment.
    let end = match.index + "ee.".length + segments[0].length;

    // Bracket property access right after the class (ee.Class["x"]) is dynamic.
    if (!exempt && /^\s*\[/.test(stripped.slice(end))) continue;

    while (!exempt) {
      if (segments.length >= 3) { exempt = true; break; }
      const nextDot = /^\.(\s*)([A-Za-z][A-Za-z0-9_]*)/.exec(stripped.slice(end));
      if (!nextDot || nextDot[1].length > 0) break; // whitespace breaks a static chain
      segments.push(nextDot[2]);
      end += nextDot[0].length;
      if (segments.length >= 3) { exempt = true; break; }
      const tail = stripped.slice(end);
      if (tail.startsWith("(")) chain.push(nextDot[2]);
      else if (/^\s*\[/.test(tail)) { exempt = true; break; } // dynamic access
    }
    if (exempt) continue;

    const className = segments[0];
    if (segments.length === 1) {
      if (TOP_LEVEL_WHITELIST.has(className.toLowerCase()) || classNames.includes(className)) {
        decided.add(`ee.${className}`);
        continue;
      }
      if (context.includes(`ee.${className}`) || context.includes(className)) {
        recordVerified(`ee.${className}`);
        continue;
      }
      recordUnknown(`ee.${className}`, className, classNames, className);
      continue;
    }

    decided.add(`ee.${className}`);
    const methods = classes[className] && Array.isArray(classes[className].methods)
      ? classes[className].methods
      : null;
    if (methods === null) {
      if (context.includes(`ee.${className}`) || context.includes(className)) {
        recordVerified(`ee.${className}`);
        continue;
      }
      recordUnknown(`ee.${className}`, className, classNames, className);
      continue;
    }

    for (const methodName of chain) {
      const symbol = `ee.${className}.${methodName}`;
      if (methods.includes(methodName)) { decided.add(symbol); continue; }
      if (context.includes(symbol) || context.includes(`${className}.${methodName}`)) {
        recordVerified(symbol);
        continue;
      }
      recordUnknown(symbol, methodName, methods, className);
    }
  }

  const truncated = unknown.length > MAX_UNKNOWN_REPORTS ? unknown.length - MAX_UNKNOWN_REPORTS : 0;
  return {
    unknown: unknown.slice(0, MAX_UNKNOWN_REPORTS),
    verifiedByContext,
    truncated
  };
}

export function lintGeeScript(code) {
  const source = code === undefined || code === null ? "" : String(code);
  const errors = [];
  if (!source.trim()) errors.push("脚本为空");
  else if (source.split(/\r?\n/).length < 3) errors.push("脚本行数不足 3 行");
  if (new TextEncoder().encode(source).length > MAX_SCRIPT_BYTES) errors.push("脚本超过 400KB 上限");
  errors.push(...checkBrackets(stripCommentsAndStrings(source)));
  for (const [pattern, label] of SENSITIVE_PATTERNS) {
    if (pattern.test(source)) errors.push(`检测到疑似${label}内容`);
  }
  return { ok: errors.length === 0, errors };
}

// Replaces comments (// and /* */) and string literals (", ', `) with spaces
// while preserving newlines and overall length, so downstream regex matches
// keep their original offsets.
function stripCommentsAndStrings(code) {
  const source = String(code || "");
  let result = "";
  let index = 0;
  while (index < source.length) {
    const char = source[index];
    const next = source[index + 1];
    if (char === "/" && next === "/") {
      while (index < source.length && source[index] !== "\n") { result += " "; index += 1; }
    } else if (char === "/" && next === "*") {
      result += "  ";
      index += 2;
      while (index < source.length && !(source[index] === "*" && source[index + 1] === "/")) {
        result += source[index] === "\n" ? "\n" : " ";
        index += 1;
      }
      if (index < source.length) { result += "  "; index += 2; }
    } else if (char === '"' || char === "'" || char === "`") {
      result += " ";
      index += 1;
      while (index < source.length && source[index] !== char && source[index] !== "\n") {
        if (source[index] === "\\") { result += "  "; index += 2; continue; }
        result += source[index] === "\n" ? "\n" : " ";
        index += 1;
      }
      if (index < source.length && source[index] === char) { result += " "; index += 1; }
    } else {
      result += char;
      index += 1;
    }
  }
  return result;
}

// Suggestions prefer prefix matches (case-insensitive) and fall back to edit
// distance <= 2, capped at MAX_SUGGESTIONS entries.
function suggestFrom(name, candidates) {
  const lower = name.toLowerCase();
  const prefixMatches = candidates.filter((entry) => entry.toLowerCase().startsWith(lower) && entry !== name);
  const closeMatches = candidates
    .filter((entry) => !prefixMatches.includes(entry) && entry !== name)
    .map((entry) => ({ entry, distance: levenshtein(lower, entry.toLowerCase()) }))
    .filter((item) => item.distance <= 2)
    .sort((a, b) => a.distance - b.distance || a.entry.localeCompare(b.entry));
  return [...prefixMatches, ...closeMatches.map((item) => item.entry)].slice(0, MAX_SUGGESTIONS);
}

function docsUrl(className) {
  return `https://developers.google.com/earth-engine/apidocs/ee-${className.toLowerCase()}`;
}

function levenshtein(a, b) {
  if (a === b) return 0;
  let previous = Array.from({ length: b.length + 1 }, (_, position) => position);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + cost);
    }
    previous = current;
  }
  return previous[b.length];
}

function checkBrackets(source) {
  const pairs = { ")": "(", "}": "{", "]": "[" };
  const stack = [];
  for (const char of source) {
    if (char === "(" || char === "{" || char === "[") stack.push(char);
    else if (char === ")" || char === "}" || char === "]") {
      if (stack.at(-1) === pairs[char]) stack.pop();
      else return [`括号不配平：出现多余的 "${char}"`];
    }
  }
  if (stack.length > 0) return [`括号不配平：缺少闭合的 "${stack.at(-1)}"`];
  return [];
}

// ---- Bundled official ee.* API index (lib/ee-api-index.json) lazy loading.
// Module-level cache: one fetch+parse shared by all callers; a failed load
// rejects (callers degrade by skipping validateEeCalls) and the next call may
// retry. fetchFn/resolveUrl are injectable so Node tests stay hermetic.
let eeApiIndexCache = null;
let eeApiIndexPending = null;

export function loadEeApiIndex({ fetchFn, resolveUrl } = {}) {
  if (eeApiIndexCache) return Promise.resolve(eeApiIndexCache);
  if (eeApiIndexPending) return eeApiIndexPending;
  const doFetch = typeof fetchFn === "function" ? fetchFn : fetch;
  const resolve = typeof resolveUrl === "function"
    ? resolveUrl
    : (path) => chrome.runtime.getURL(path);
  eeApiIndexPending = (async () => {
    try {
      const response = await doFetch(resolve("lib/ee-api-index.json"));
      if (!response?.ok) throw new Error(`HTTP ${response?.status ?? "unknown"}`);
      const index = await response.json();
      if (!index || typeof index !== "object" || !index.classes) {
        throw new Error("ee-api-index.json 结构无效");
      }
      eeApiIndexCache = index;
      return index;
    } finally {
      eeApiIndexPending = null;
    }
  })();
  return eeApiIndexPending;
}

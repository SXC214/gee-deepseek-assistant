export function extractCodeCandidate(content) {
  const text = String(content || "").replace(/\r\n?/g, "\n");
  const fenced = [...text.matchAll(/```(?:javascript|js|typescript|ts)?[^\S\r\n]*\r?\n([\s\S]*?)```/gi)]
    .map((match) => match[1].trim())
    .filter(Boolean);

  if (fenced.length > 0) {
    return fenced.sort((a, b) => b.length - a.length)[0];
  }

  const trimmed = text.trim();
  if (/^(?:\/\/|\/\*|var\s|let\s|const\s|function\s|ee\.|Map\.|print\(|Export\.)/.test(trimmed)) {
    return trimmed;
  }
  const rawJavascript = extractRawJavascriptAfterExplanation(trimmed);
  if (rawJavascript) return rawJavascript;
  return "";
}

export function stripCodeFences(content) {
  return String(content || "")
    .replace(/```(?:javascript|js|typescript|ts)?[^\S\r\n]*\r?\n[\s\S]*?```/gi, "[代码见下方修改预览]")
    .trim();
}

function extractRawJavascriptAfterExplanation(text) {
  const lines = text.split("\n");
  const codeStart = /^(?:\/\/|\/\*|['\"]use strict['\"]|(?:var|let|const|function|class|async\s+function)\b|ee\.|Map\.|ui\.|print\s*\(|Export\.)/;
  for (let index = 1; index < lines.length; index += 1) {
    if (!codeStart.test(lines[index].trim())) continue;
    const candidate = lines.slice(index).join("\n").trim();
    if (looksLikeJavascript(candidate)) return candidate;
  }
  return "";
}

function looksLikeJavascript(value) {
  if (value.length < 12) return false;
  const geeSignal = /\b(?:ee|Map|Export|ui)\.[A-Za-z_$][\w$]*|\bprint\s*\(/.test(value);
  const generalSignal = /\b(?:var|let|const|function|class|if|for)\b/.test(value)
    && /[;{}]/.test(value);
  return geeSignal || generalSignal;
}

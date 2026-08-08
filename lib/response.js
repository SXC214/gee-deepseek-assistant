export function extractCodeCandidate(content) {
  const text = String(content || "").replace(/\r\n?/g, "\n");
  const fenced = [...text.matchAll(/```(?:javascript|js|typescript|ts)?[^\S\r\n]*\r?\n([\s\S]*?)```/gi)]
    .map((match) => match[1].trim())
    .filter(Boolean);

  if (fenced.length > 0) {
    // Score each fenced block instead of blindly taking the last GEE-looking
    // one: GEE signal dominates (+2), a substantial length earns a bonus
    // (+1), and position only breaks ties (later block wins). So a complete
    // script followed by a short usage example still yields the script,
    // while a revised final script still beats an earlier draft.
    let best = null;
    for (let index = 0; index < fenced.length; index += 1) {
      const score = scoreFencedBlock(fenced[index]);
      if (!best || score >= best.score) best = { score, block: fenced[index] };
    }
    return best.block;
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

// A block counts as a full script once it is long enough to hold real logic.
// The threshold sits well above one-liners and short usage examples but below
// any plausible complete script.
const FENCED_BLOCK_SUBSTANTIAL_LENGTH = 150;

function scoreFencedBlock(block) {
  let score = 0;
  if (hasGeeSignal(block)) score += 2;
  if (block.length >= FENCED_BLOCK_SUBSTANTIAL_LENGTH) score += 1;
  return score;
}

function hasGeeSignal(value) {
  return /\b(?:ee|Map|Export|ui)\.[A-Za-z_$][\w$]*|\bprint\s*\(/.test(value);
}

function looksLikeJavascript(value) {
  if (value.length < 12) return false;
  const geeSignal = hasGeeSignal(value);
  const generalSignal = /\b(?:var|let|const|function|class|if|for)\b/.test(value)
    && /[;{}]/.test(value);
  return geeSignal || generalSignal;
}

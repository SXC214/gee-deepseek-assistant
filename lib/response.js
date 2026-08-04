export function extractCodeCandidate(content) {
  const text = String(content || "");
  const fenced = [...text.matchAll(/```(?:javascript|js|typescript|ts)?\s*\n([\s\S]*?)```/gi)]
    .map((match) => match[1].trim())
    .filter(Boolean);

  if (fenced.length > 0) {
    return fenced.sort((a, b) => b.length - a.length)[0];
  }

  const trimmed = text.trim();
  if (/^(?:\/\/|\/\*|var\s|let\s|const\s|function\s|ee\.|Map\.|print\(|Export\.)/.test(trimmed)) {
    return trimmed;
  }
  return "";
}

export function stripCodeFences(content) {
  return String(content || "")
    .replace(/```(?:javascript|js|typescript|ts)?\s*\n[\s\S]*?```/gi, "[代码见下方修改预览]")
    .trim();
}

const STOP_WORDS = new Set([
  "and", "are", "code", "current", "data", "earth", "engine", "for", "from",
  "ee", "gee", "google", "how", "javascript", "of", "the", "this", "to", "with",
  "代码", "当前", "数据", "如何", "使用", "需要"
]);

const QUERY_ALIASES = [
  ["哨兵", "sentinel"],
  ["陆地卫星", "landsat"],
  ["中分辨率成像光谱仪", "modis"],
  ["降水", "precipitation rainfall chirps gpm"],
  ["雨量", "precipitation rainfall"],
  ["高程", "elevation dem terrain"],
  ["地形", "terrain elevation dem"],
  ["土地覆盖", "land cover landcover"],
  ["地表覆盖", "land cover landcover"],
  ["温度", "temperature thermal"],
  ["地表温度", "land surface temperature lst"],
  ["蒸散", "evapotranspiration evaporation"],
  ["洪水", "flood surface water"],
  ["水体", "water surface water"],
  ["森林", "forest tree canopy"],
  ["土壤", "soil"],
  ["夜间灯光", "nighttime lights night light"],
  ["海洋", "ocean sea"],
  ["风速", "wind speed"],
  ["云掩膜", "cloud mask cloud probability"],
  ["云量", "cloud cover"],
  ["植被", "vegetation ndvi evi"],
  ["归一化植被指数", "ndvi vegetation"],
  ["雷达", "radar sar sentinel-1"],
  ["光学", "optical reflectance"],
  ["地表反射率", "surface reflectance sr"],
  ["夜光", "nighttime lights"],
  ["人口", "population worldpop"],
  ["干旱", "drought"],
  ["火灾", "fire burned area"],
  ["火点", "fire firms"],
  ["农业", "agriculture crop cropland"],
  ["分类", "classification classifier"],
  ["回归", "regression"],
  ["导出", "export"],
  ["重投影", "reproject projection"],
  ["区域统计", "reduceRegion reduceRegions reducer"],
  ["影像集合", "ImageCollection"],
  ["要素集合", "FeatureCollection"]
];

export function parseDatasetIndexHtml(html, baseUrl = "https://developers.google.com") {
  const source = String(html || "");
  const entries = [];
  const seen = new Set();
  const anchorPattern = /<a\b[^>]*href=(?:"([^"]*\/earth-engine\/datasets\/catalog\/([^"?#]+)[^"]*)"|'([^']*\/earth-engine\/datasets\/catalog\/([^'?#]+)[^']*)')[^>]*>([\s\S]*?)<\/a>/gi;

  for (const match of source.matchAll(anchorPattern)) {
    const href = match[1] || match[3];
    const slug = decodeURIComponent(match[2] || match[4] || "").replace(/\/$/, "");
    const title = htmlToText(match[5]);
    if (!slug || slug.includes("/") || !title || seen.has(slug)) continue;

    const listStart = source.lastIndexOf("<li", match.index);
    const listEnd = source.indexOf("</li>", match.index);
    const block = listStart >= 0 && listEnd > match.index && listEnd - listStart < 12000
      ? source.slice(listStart, listEnd + 5)
      : match[0];
    const description = htmlToText(block).replace(title, "").trim().slice(0, 1200);
    let parsedUrl;
    try {
      parsedUrl = new URL(href, baseUrl);
    } catch {
      continue;
    }
    if (parsedUrl.origin !== "https://developers.google.com") continue;
    const url = parsedUrl.href.split("?")[0];

    entries.push({
      kind: "dataset",
      title,
      url,
      slug,
      searchText: `${title} ${slug.replaceAll("_", " ")} ${description}`,
      description
    });
    seen.add(slug);
  }
  return entries;
}

export function parseDocsIndexHtml(html, baseUrl = "https://developers.google.com") {
  const source = String(html || "");
  const entries = [];
  const seen = new Set();
  const anchorPattern = /<a\b[^>]*href=(?:"([^"]+)"|'([^']+)')[^>]*>([\s\S]*?)<\/a>/gi;

  for (const match of source.matchAll(anchorPattern)) {
    const href = match[1] || match[2];
    if (!href || !href.includes("/earth-engine/")) continue;
    let url;
    try {
      url = new URL(href, baseUrl);
    } catch {
      continue;
    }
    if (url.origin !== "https://developers.google.com") continue;
    if (/\/earth-engine\/datasets\/(?:catalog|tags)\//.test(url.pathname)) continue;
    if (!/^\/earth-engine\/(?:apidocs|guides|reference|tutorials|community|release_notes)/.test(url.pathname)) continue;

    url.search = "";
    url.hash = "";
    const canonical = url.href.replace(/\/$/, "");
    const title = htmlToText(match[3]);
    if (title.length < 3 || title.length > 180 || seen.has(canonical)) continue;
    if (/^(?:home|send feedback|next|previous)$/i.test(title)) continue;

    entries.push({
      kind: "docs",
      title,
      url: canonical,
      searchText: `${title} ${decodeURIComponent(url.pathname).replaceAll(/[-_/]/g, " ")}`
    });
    seen.add(canonical);
  }
  return entries;
}

export function rankEntries(entries, query, limit = 6) {
  const expanded = expandQuery(query);
  const tokens = tokenize(expanded).filter((token) => !STOP_WORDS.has(token));
  const rawQuery = normalize(query);

  return entries
    .map((entry) => {
      const title = normalize(entry.title);
      const url = normalize(entry.url);
      const text = normalize(entry.searchText || `${entry.title} ${entry.description || ""}`);
      let score = 0;
      if (rawQuery.length > 2 && text.includes(rawQuery)) score += 45;
      for (const token of tokens) {
        if (title === token) score += 35;
        else if (title.startsWith(token)) score += 22;
        else if (title.includes(token)) score += 14;
        if (url.includes(token)) score += 16;
        if (text.includes(token)) score += 5;
      }
      return { ...entry, score };
    })
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.title.localeCompare(b.title))
    .slice(0, limit);
}

export function directApiDocEntries(query) {
  const matches = String(query || "").match(/\bee\.[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)?/g) || [];
  return [...new Set(matches)].map((symbol) => ({
    kind: "docs",
    title: symbol,
    url: `https://developers.google.com/earth-engine/apidocs/${symbol.toLowerCase().replaceAll(".", "-")}`,
    searchText: symbol,
    score: 100
  }));
}

export function extractOfficialPage(html, url, query, kind) {
  const source = String(html || "");
  const decodedSource = decodeHtml(source);
  const titleMatch = decodedSource.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i)
    || decodedSource.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i);
  const title = cleanTitle(htmlToText(titleMatch?.[1] || url));
  const mainMatch = decodedSource.match(/<main\b[^>]*>([\s\S]*?)<\/main>/i)
    || decodedSource.match(/<article\b[^>]*>([\s\S]*?)<\/article>/i);
  const text = htmlToText(mainMatch?.[1] || decodedSource);
  const summary = relevantText(text, query, kind === "dataset" ? 7500 : 6000);
  const snippetMatch = decodedSource.match(/ee\.(ImageCollection|Image|FeatureCollection)\(\s*["']([^"']+)["']\s*\)/i);

  return {
    kind,
    title,
    url,
    summary,
    snippet: snippetMatch ? `ee.${snippetMatch[1]}("${snippetMatch[2]}")` : "",
    datasetId: snippetMatch?.[2] || ""
  };
}

export function expandQuery(query) {
  const original = String(query || "");
  const additions = [];
  const lower = original.toLowerCase();
  for (const [needle, aliases] of QUERY_ALIASES) {
    if (lower.includes(needle.toLowerCase())) additions.push(aliases);
  }
  return `${original} ${additions.join(" ")}`.trim();
}

export function htmlToText(html) {
  return decodeHtml(String(html || ""))
    .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[\s\S]*?<\/style>/gi, " ")
    .replace(/<svg\b[\s\S]*?<\/svg>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function relevantText(text, query, maxLength) {
  if (text.length <= maxLength) return text;
  const tokens = tokenize(expandQuery(query)).filter((token) => token.length > 2 && !STOP_WORDS.has(token));
  const lower = text.toLowerCase();
  const ranges = [{ start: 0, end: Math.min(1500, text.length) }];

  for (const token of tokens.slice(0, 10)) {
    const index = lower.indexOf(token.toLowerCase());
    if (index >= 0) ranges.push({ start: Math.max(0, index - 500), end: Math.min(text.length, index + 1200) });
  }

  ranges.sort((a, b) => a.start - b.start);
  const merged = [];
  for (const range of ranges) {
    const previous = merged.at(-1);
    if (previous && range.start <= previous.end + 100) previous.end = Math.max(previous.end, range.end);
    else merged.push({ ...range });
  }

  return merged.map((range) => text.slice(range.start, range.end)).join("\n…\n").slice(0, maxLength);
}

function tokenize(value) {
  const tokens = normalize(value).match(/[a-z0-9_.:/+-]{2,}|[\u3400-\u9fff]{2,}/g) || [];
  const parts = tokens.flatMap((token) => token.split(/[._:/+-]+/).filter((part) => part.length >= 2));
  return [...new Set([...tokens, ...parts])];
}

function normalize(value) {
  return String(value || "").toLowerCase().replace(/\s+/g, " ").trim();
}

function cleanTitle(value) {
  return String(value || "")
    .replace(/\s+Stay organized with collections[\s\S]*$/i, "")
    .replace(/\s+Save and categorize content based on your preferences\.?$/i, "")
    .trim();
}

function decodeHtml(value) {
  const named = {
    amp: "&", apos: "'", gt: ">", lt: "<", nbsp: " ", quot: '"'
  };
  return String(value || "").replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (entity, code) => {
    if (code[0] === "#") {
      const number = code[1].toLowerCase() === "x" ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isFinite(number) ? String.fromCodePoint(number) : entity;
    }
    return named[code.toLowerCase()] ?? entity;
  });
}

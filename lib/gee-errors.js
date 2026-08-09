// Earth Engine 运行时错误诊断与性能守则（数据驱动，供系统提示词注入）。
// 匹配逻辑只做只读遍历，模式数组保持定义顺序即输出顺序。

export const GEE_PERFORMANCE_GUIDELINES = [
  "先用 filterBounds/filterDate 缩小影像或要素集合，再执行聚合，避免对未过滤的大集合直接计算。",
  "reduceRegion/reduceRegions 聚合时按需设置 bestEffort: true、maxPixels 与 tileScale，降低单次计算负载。",
  "避免对未过滤的大集合执行全量 map，先用 limit/filter 约束参与计算的元素数量。",
  "大结果优先走 Export（Export.image/toDrive/toAsset）分块导出，不要在单次在线请求中聚合海量数据。",
  "时序分析使用 ee.ImageCollection 的 map/reduce 链式操作，不要在客户端循环中反复调用 evaluate/getInfo。",
  "控制单张影像叠加聚合的层数与波段数，必要时拆分为多次小计算再合并。",
  "在大范围区域计算时适当降低分辨率（增大 scale）或缩小研究区，再分阶段细化。"
];

export const GEE_ERROR_PATTERNS = [
  {
    id: "too-many-concurrent",
    patterns: [
      /too many concurrent aggregations/i,
      /too many concurrent (?:requests|evaluations)/i
    ],
    title: "并发聚合请求过多",
    diagnosis: "同一时间发起的聚合/evaluate 请求超过 Earth Engine 的并发配额，常见于循环内逐景调用 evaluate 或批量 reduce。",
    fixes: [
      "将循环内的 evaluate/getInfo 合并为单次 map/reduce 链式计算",
      "客户端串行或限流提交请求，避免一次性批量并发",
      "缩小聚合范围或降低输出规模后再重试"
    ],
    docUrl: "https://developers.google.com/earth-engine/guides/usage"
  },
  {
    id: "user-memory-limit",
    patterns: [
      /user memory limit exceeded/i,
      /exceeded memory limit/i,
      /user memory limit/i
    ],
    title: "用户内存超限",
    diagnosis: "单次计算在内存中物化了过多像素或要素，常见于对大范围/高分辨率数据做全量聚合、toArray 或过深的集合 join。",
    fixes: [
      "缩小时间/空间范围后再计算，或分段分块处理",
      "reduceRegion/reduceRegions 设置 bestEffort: true 并增大 scale 降低分辨率",
      "避免 collectionToArray/toArray 全量物化，改用 reduce 逐段聚合",
      "大结果改用 Export 分块导出到 Drive/Asset"
    ],
    docUrl: "https://developers.google.com/earth-engine/guides/usage"
  },
  {
    id: "computation-timeout",
    patterns: [
      /computation timed out/i,
      /deadline exceeded/i,
      /computation timeout/i
    ],
    title: "计算超时",
    diagnosis: "计算图过大或数据量超出单次请求时限（在线调用约 5 分钟），常见于未过滤大集合叠加多层聚合。",
    fixes: [
      "先 filterBounds/filterDate 缩小集合，减少参与计算的影像数量",
      "拆分计算：分时段/分区块聚合后再合并",
      "增大 scale 或设置 bestEffort 降低计算成本",
      "结果较大时改用 Export 异步导出而非在线计算"
    ],
    docUrl: "https://developers.google.com/earth-engine/guides/debugging"
  },
  {
    id: "collection-too-large",
    patterns: [
      /collection is too large/i,
      /too many elements in (?:the )?collection/i
    ],
    title: "集合元素过多",
    diagnosis: "对元素数量过大的 ImageCollection/FeatureCollection 做了不支持全量物化的操作（如 distinct、频繁 sort/filter 未索引集合）。",
    fixes: [
      "先 filterDate/filterBounds/filterMetadata 缩小集合",
      "用 limit 取前 N 个元素做采样验证，再扩大范围",
      "对大集合的聚合改用 reduce 而非全量物化"
    ],
    docUrl: "https://developers.google.com/earth-engine/guides/usage"
  },
  {
    id: "too-many-bands",
    patterns: [
      /too many bands/i,
      /number of bands exceeds/i
    ],
    title: "波段数过多",
    diagnosis: "toBands 或反复 addBands 叠加后单张影像波段数超出上限（通常数百个），常见于长时间序列逐景转波段。",
    fixes: [
      "减少叠加的影像数量，分时段拆分后分别计算",
      "只保留需要的波段（select），避免全波段叠加",
      "时序结果改用 ImageCollection + reduce 而非 toBands 堆叠"
    ],
    docUrl: "https://developers.google.com/earth-engine/guides/debugging"
  },
  {
    id: "too-many-pixels",
    patterns: [
      /too many pixels/i,
      /image (?:is )?too large/i,
      /exceeds the maximum allowed (?:size|pixels)/i
    ],
    title: "像素数过多",
    diagnosis: "单次计算涉及的像素总量超出限制，常见于高分辨率数据覆盖大区域或未设置 maxPixels 的 reduceRegion。",
    fixes: [
      "增大 scale（降低分辨率）或缩小研究区域",
      "reduceRegion 设置 maxPixels 并按区块分块计算",
      "大结果改用 Export 分块导出（Export.image.toDrive/toAsset）",
      "设置 tileScale（如 4~16）缓解分块不均导致的失败"
    ],
    docUrl: "https://developers.google.com/earth-engine/cloud/exporting"
  }
];

export function matchGeeErrors(text) {
  if (typeof text !== "string" || text.trim() === "") return [];
  const matches = [];
  const seen = new Set();
  for (const entry of GEE_ERROR_PATTERNS) {
    if (seen.has(entry.id)) continue;
    if (entry.patterns.some((pattern) => pattern.test(text))) {
      matches.push(entry);
      seen.add(entry.id);
    }
  }
  return matches;
}

export function createGeeErrorSection(matches) {
  const unique = [];
  const seen = new Set();
  for (const match of Array.isArray(matches) ? matches : []) {
    if (!match || !match.id || seen.has(match.id)) continue;
    unique.push(match);
    seen.add(match.id);
  }
  if (unique.length === 0) return "";

  const lines = ["Earth Engine 运行时错误诊断（来自 Console）", ""];
  unique.forEach((match, index) => {
    lines.push(`${index + 1}. ${match.title}（${match.id}）`);
    lines.push(`   诊断：${match.diagnosis}`);
    lines.push("   修复方向：");
    for (const fix of match.fixes || []) lines.push(`   - ${fix}`);
    lines.push(`   官方文档：${match.docUrl}`);
    lines.push("");
  });
  return lines.join("\n").trimEnd();
}

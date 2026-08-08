/**
 * Local shapefile parsing fallback for the sidepanel.
 *
 * When the cloud upload path is unavailable, the sidepanel parses a complete
 * shapefile set (.shp/.shx/.dbf plus optional .prj/.cpg) entirely in the
 * browser and persists the result as a local asset. Everything here is a pure
 * function over ArrayBuffers + DataView so the same code runs in the
 * extension and in the Node test suite; there are zero runtime dependencies.
 *
 * Supported geometry types: Point(1), PolyLine(3), Polygon(5), MultiPoint(8)
 * and the Z variants PointZ(11)/PolyLineZ(13)/PolygonZ(15)/MultiPointZ(18),
 * which are flattened to 2D. Null shapes (0) are skipped; MultiPatch(19) and
 * every other type are rejected with a user-presentable Chinese error.
 *
 * Polygon ring strategy: per the shapefile specification outer rings are
 * clockwise (negative signed area) and holes are counter-clockwise. Rings are
 * scanned in file order: a clockwise ring opens a new Polygon and every
 * following counter-clockwise ring is attached to the most recent outer ring
 * as a hole. If the very first ring is counter-clockwise (malformed data) it
 * is still treated as an outer ring. GeoJSON RFC 7946 prefers CCW exteriors,
 * but GEE's ee.FeatureCollection accepts either orientation, so the winding is
 * preserved as-is instead of being re-ordered.
 */

/** Total size cap for one locally parsed shapefile set (32 MB). */
export const SHP_SET_MAX_BYTES = 32 * 1024 * 1024;
/** Feature count cap for local parsing. */
export const SHP_MAX_FEATURES = 50000;
/** Character cap for the inline ee.FeatureCollection snippet. */
export const SHP_SNIPPET_MAX_CHARS = 1024 * 1024;
/** Sets at or below this size may still go through the cloud direct upload. */
export const SHP_CLOUD_DIRECT_MAX_BYTES = 8 * 1024 * 1024;

const REQUIRED_EXTENSIONS = ["shp", "shx", "dbf"];
const KNOWN_EXTENSIONS = [...REQUIRED_EXTENSIONS, "prj", "cpg"];
const SHP_MAGIC = 9994;
const REPROJECT_HINT = "请先用 GIS 工具重投影为 EPSG:4326 后再导入";
// Yields the event loop roughly every N records so the sidepanel stays live.
const PROGRESS_CHUNK_SIZE = 2000;

/**
 * Validates that the selected files form exactly one complete shapefile set.
 * Input entries only need { name, size }; grouping is case-insensitive on the
 * base name. Returns { ok, missing, baseName, error } where `error` is a
 * ready-to-display Chinese message (empty string when ok).
 */
export function validateShapefileSet(files) {
  const fail = (error, missing = [], baseName = "") => ({ ok: false, missing, baseName, error });
  if (!Array.isArray(files) || files.length === 0) {
    return fail("请先选择完整的 shapefile 文件集（至少包含 .shp、.shx、.dbf）");
  }

  let totalBytes = 0;
  const groups = new Map();
  for (const file of files) {
    const name = String(file && file.name ? file.name : "").trim();
    if (!name) return fail("检测到无效文件名，请重新选择文件");
    totalBytes += Number(file.size) || 0;
    const dot = name.lastIndexOf(".");
    if (dot <= 0 || dot === name.length - 1) return fail(`无法识别文件的扩展名：${name}`);
    const base = name.slice(0, dot);
    const ext = name.slice(dot + 1).toLowerCase();
    if (!KNOWN_EXTENSIONS.includes(ext)) {
      return fail(`不支持的文件类型：${name}（仅接受 .shp / .shx / .dbf / .prj / .cpg）`);
    }
    const key = base.toLowerCase();
    if (!groups.has(key)) groups.set(key, { baseName: base, exts: new Map() });
    const group = groups.get(key);
    if (group.exts.has(ext)) {
      return fail(`检测到重复的 .${ext} 文件，同一套 shapefile 中每个扩展名只能出现一次`);
    }
    group.exts.set(ext, name);
  }

  if (totalBytes > SHP_SET_MAX_BYTES) {
    return fail(`文件总大小超过 ${SHP_SET_MAX_BYTES / 1024 / 1024} MB 的本地解析上限，请先在 GIS 工具中裁剪数据`);
  }
  if (groups.size > 1) {
    const names = [...groups.values()].map((group) => group.baseName).join("、");
    return fail(`检测到多套 shapefile（${names}），请一次只选择一套`);
  }

  const group = groups.values().next().value;
  const missing = REQUIRED_EXTENSIONS.filter((ext) => !group.exts.has(ext));
  if (missing.length) {
    return fail(`缺少必需文件：${missing.map((ext) => `.${ext}`).join("、")}`, missing, group.baseName);
  }
  return { ok: true, missing: [], baseName: group.baseName, error: "" };
}

/** Throws unless the .prj text (if any) is recognizably WGS84/EPSG:4326. */
function assertPrjIsWgs84(prjBuffer) {
  if (!prjBuffer || !prjBuffer.byteLength) return;
  const text = new TextDecoder("utf-8", { fatal: false }).decode(prjBuffer).trim();
  if (!text) return; // an empty .prj is treated the same as a missing one
  const upper = text.toUpperCase();
  if (upper.includes("PROJCS")) {
    throw new Error(`该 shapefile 使用投影坐标系（PROJCS），${REPROJECT_HINT}`);
  }
  const looksWgs84 = upper.includes("EPSG:4326")
    || upper.includes("EPSG\"4326")
    || (/GEOGCS/.test(upper) && (/WGS[ _]?(?:19)?84/.test(upper) || upper.includes("4326")));
  if (!looksWgs84) {
    throw new Error(`无法将该 shapefile 的坐标参考（.prj）识别为 WGS84/EPSG:4326，${REPROJECT_HINT}`);
  }
}

/** Builds the attribute decoder from the optional .cpg declaration. */
function createFieldDecoder(cpgBuffer) {
  let label = "utf-8";
  if (cpgBuffer && cpgBuffer.byteLength) {
    const declared = new TextDecoder("utf-8", { fatal: false }).decode(cpgBuffer).trim();
    if (declared) label = declared;
  }
  try {
    // fatal:false keeps decoding alive; undecodable bytes become U+FFFD.
    return new TextDecoder(label, { fatal: false });
  } catch {
    return new TextDecoder("utf-8", { fatal: false });
  }
}

function decodeFieldText(bytes) {
  return bytes.reduce((text, byte) => {
    if (byte === 0) return text;
    return text + String.fromCharCode(byte);
  }, "");
}

/** Parses one raw dBase III field value into a typed JS value. */
function convertDbfValue(field, raw) {
  const text = raw.trim();
  if (field.type === "N" || field.type === "F") {
    if (!text || /^\*+$/.test(text)) return null;
    const value = Number(text);
    return Number.isFinite(value) ? value : null;
  }
  if (field.type === "D") {
    if (/^\d{8}$/.test(text)) return `${text.slice(0, 4)}-${text.slice(4, 6)}-${text.slice(6, 8)}`;
    return null;
  }
  if (field.type === "L") {
    const flag = text.toUpperCase();
    if (flag === "T" || flag === "Y") return true;
    if (flag === "F" || flag === "N") return false;
    return null;
  }
  return text; // C and any other character-like types
}

/** Parses a dBase III attribute table: { fieldNames, records }. */
function parseDbf(dbfBuffer, decoder) {
  const view = new DataView(dbfBuffer);
  if (dbfBuffer.byteLength < 32) throw new Error("DBF 文件过小，无法解析属性表");
  const recordCount = view.getUint32(4, true);
  const headerSize = view.getUint16(8, true);
  const recordSize = view.getUint16(10, true);

  const fields = [];
  let offset = 32;
  while (offset + 32 <= dbfBuffer.byteLength && offset + 32 <= headerSize) {
    if (view.getUint8(offset) === 0x0d) break; // field descriptor terminator
    const nameBytes = new Uint8Array(dbfBuffer, offset, 11);
    const name = decodeFieldText([...nameBytes]).trim();
    fields.push({
      name: name || `FIELD_${fields.length + 1}`,
      type: String.fromCharCode(view.getUint8(offset + 11)),
      length: view.getUint8(offset + 16)
    });
    offset += 32;
  }
  if (fields.length && offset > headerSize) {
    throw new Error("DBF 字段描述符表结构损坏");
  }

  const records = [];
  const bytes = new Uint8Array(dbfBuffer);
  let cursor = headerSize;
  for (let index = 0; index < recordCount && cursor + recordSize <= dbfBuffer.byteLength; index += 1) {
    const deleted = bytes[cursor] === 0x2a; // "*" marks a deleted record
    const properties = {};
    let fieldOffset = cursor + 1;
    for (const field of fields) {
      const slice = bytes.subarray(fieldOffset, fieldOffset + field.length);
      properties[field.name] = deleted ? null : convertDbfValue(field, decoder.decode(slice));
      fieldOffset += field.length;
    }
    records.push(properties);
    cursor += recordSize;
  }
  return { fieldNames: fields.map((field) => field.name), records };
}

function readPoint(view, offset, sink) {
  const x = view.getFloat64(offset, true);
  const y = view.getFloat64(offset + 8, true);
  sink.push([x, y]);
  return offset + 16;
}

function readPartsHeader(view, offset) {
  const numParts = view.getInt32(offset, true);
  const numPoints = view.getInt32(offset + 4, true);
  if (numParts <= 0 || numPoints < 0) throw new Error("SHP 记录中的分块/顶点数量无效，文件可能已损坏");
  return { numParts, numPoints };
}

function readRingsOrPaths(view, offset, numParts, numPoints) {
  const parts = [];
  for (let partIndex = 0; partIndex < numParts; partIndex += 1) {
    parts.push(view.getInt32(offset + partIndex * 4, true));
  }
  const paths = [];
  let cursor = offset + numParts * 4;
  for (let partIndex = 0; partIndex < numParts; partIndex += 1) {
    const start = parts[partIndex];
    const end = partIndex + 1 < numParts ? parts[partIndex + 1] : numPoints;
    if (start < 0 || end > numPoints || start > end) {
      throw new Error("SHP 记录中的分块索引越界，文件可能已损坏");
    }
    const path = [];
    for (let pointIndex = start; pointIndex < end; pointIndex += 1) {
      cursor = readPoint(view, cursor, path);
    }
    paths.push(path);
  }
  return paths;
}

function signedArea(ring) {
  let sum = 0;
  for (let index = 0; index < ring.length - 1; index += 1) {
    sum += ring[index][0] * ring[index + 1][1] - ring[index + 1][0] * ring[index][1];
  }
  return sum / 2;
}

/** Groups rings into polygons by winding order (see module header comment). */
function groupPolygonRings(rings) {
  const polygons = [];
  for (const ring of rings) {
    if (!polygons.length || signedArea(ring) < 0) {
      polygons.push([ring]);
    } else {
      polygons[polygons.length - 1].push(ring);
    }
  }
  return polygons;
}

function polylineGeometry(paths) {
  if (paths.length === 1) return { type: "LineString", coordinates: paths[0] };
  return { type: "MultiLineString", coordinates: paths };
}

function polygonGeometry(rings) {
  const polygons = groupPolygonRings(rings);
  if (polygons.length === 1) return { type: "Polygon", coordinates: polygons[0] };
  return { type: "MultiPolygon", coordinates: polygons };
}

/** Parses one record body into a 2D GeoJSON geometry (null for Null shapes). */
function parseRecordGeometry(view, contentOffset, contentLength) {
  const shapeType = view.getInt32(contentOffset, true);
  if (shapeType === 0) return null; // Null shape: no geometry, but its DBF row is still consumed
  if (shapeType === 1 || shapeType === 11) {
    if (contentLength < 20) throw new Error("Point 记录长度不足，SHP 文件已损坏");
    const points = [];
    readPoint(view, contentOffset + 4, points);
    return { type: "Point", coordinates: points[0] };
  }
  if (shapeType === 8 || shapeType === 18) {
    if (contentLength < 40) throw new Error("MultiPoint 记录长度不足，SHP 文件已损坏");
    const numPoints = view.getInt32(contentOffset + 36, true);
    if (numPoints < 0) throw new Error("MultiPoint 记录点数无效，SHP 文件已损坏");
    const points = [];
    let cursor = contentOffset + 40;
    for (let index = 0; index < numPoints; index += 1) cursor = readPoint(view, cursor, points);
    return { type: "MultiPoint", coordinates: points };
  }
  if (shapeType === 3 || shapeType === 13 || shapeType === 5 || shapeType === 15) {
    if (contentLength < 44) throw new Error("PolyLine/Polygon 记录长度不足，SHP 文件已损坏");
    const { numParts, numPoints } = readPartsHeader(view, contentOffset + 36);
    const paths = readRingsOrPaths(view, contentOffset + 44, numParts, numPoints);
    if (shapeType === 3 || shapeType === 13) return polylineGeometry(paths);
    // Each part is treated as one ring; multi-ring parts are a rare layout
    // and the winding-order grouping below still handles the common cases.
    return polygonGeometry(paths);
  }
  if (shapeType === 19) {
    throw new Error("不支持 MultiPatch（多面体）类型的 shapefile，请先在 GIS 工具中转换为面要素");
  }
  throw new Error(`不支持的几何类型（shape type ${shapeType}），仅支持 Point/PolyLine/Polygon/MultiPoint 及其 Z 变体`);
}

function updateBbox(bbox, geometry) {
  const visit = (position) => {
    if (typeof position[0] === "number") {
      bbox[0] = Math.min(bbox[0], position[0]);
      bbox[1] = Math.min(bbox[1], position[1]);
      bbox[2] = Math.max(bbox[2], position[0]);
      bbox[3] = Math.max(bbox[3], position[1]);
      return;
    }
    for (const nested of position) visit(nested);
  };
  visit(geometry.coordinates);
}

/**
 * Parses a full shapefile set into a GeoJSON FeatureCollection.
 * Inputs are ArrayBuffers; `prj`/`cpg` are optional. Yields the event loop
 * every ~2000 records and reports { processed, total, done } via onProgress.
 * Returns { geoJson, featureCount, bbox, properties }.
 */
export async function parseShapefileToGeoJson({ shp, dbf, prj, cpg } = {}, { onProgress } = {}) {
  if (!(shp instanceof ArrayBuffer)) throw new Error("缺少 .shp 文件的二进制内容");
  if (!(dbf instanceof ArrayBuffer)) throw new Error("缺少 .dbf 文件的二进制内容");
  const totalBytes = shp.byteLength + dbf.byteLength + (prj ? prj.byteLength : 0) + (cpg ? cpg.byteLength : 0);
  if (totalBytes > SHP_SET_MAX_BYTES) {
    throw new Error(`shapefile 总大小超过 ${SHP_SET_MAX_BYTES / 1024 / 1024} MB 的本地解析上限，请先在 GIS 工具中裁剪数据`);
  }
  assertPrjIsWgs84(prj);

  const view = new DataView(shp);
  if (shp.byteLength < 100 || view.getInt32(0, false) !== SHP_MAGIC) {
    throw new Error("SHP 文件头无效（魔数 9994 校验失败），文件可能不是 shapefile 或已损坏");
  }
  const fileLength = view.getInt32(24, false) * 2;

  const decoder = createFieldDecoder(cpg);
  const attributeTable = parseDbf(dbf, decoder);
  const report = typeof onProgress === "function" ? onProgress : () => {};

  const features = [];
  const bbox = [Infinity, Infinity, -Infinity, -Infinity];
  let offset = 100;
  let scanned = 0;
  // DBF rows map 1:1 onto SHP records, Null shapes included, so the
  // attribute cursor advances for every record, not just non-empty ones.
  let recordIndex = 0;
  const limit = Math.min(fileLength, shp.byteLength);
  while (offset < limit) {
    if (offset + 8 > shp.byteLength) throw new Error("SHP 记录头越界，文件可能已损坏");
    const contentLength = view.getInt32(offset + 4, false) * 2;
    const contentOffset = offset + 8;
    if (contentLength < 4 || contentOffset + contentLength > shp.byteLength) {
      throw new Error("SHP 记录长度越界，文件可能已损坏");
    }
    const geometry = parseRecordGeometry(view, contentOffset, contentLength);
    if (geometry) {
      if (features.length >= SHP_MAX_FEATURES) {
        throw new Error(`要素数量超过 ${SHP_MAX_FEATURES} 的本地解析上限，请先在 GIS 工具中筛选或裁剪数据`);
      }
      features.push({
        type: "Feature",
        properties: attributeTable.records[recordIndex] || {},
        geometry
      });
      updateBbox(bbox, geometry);
    }
    recordIndex += 1;
    offset = contentOffset + contentLength;
    scanned += 1;
    if (scanned % PROGRESS_CHUNK_SIZE === 0) {
      report({ processed: scanned, total: Math.max(scanned, attributeTable.records.length), done: false });
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }

  report({ processed: scanned, total: scanned, done: true });
  return {
    geoJson: { type: "FeatureCollection", features },
    featureCount: features.length,
    bbox: features.length ? bbox : null,
    properties: attributeTable.fieldNames
  };
}

/** Derives a safe JavaScript identifier from an asset name / base name. */
export function sanitizeSnippetVariableName(name) {
  const cleaned = String(name || "").replace(/[^A-Za-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  if (!cleaned) return "shp_asset";
  return /^[0-9]/.test(cleaned) ? `shp_${cleaned}` : cleaned;
}

/**
 * Builds `var <name> = ee.FeatureCollection(<json>);` for inline injection.
 * Returns { truncated:true } when the snippet would exceed maxChars,
 * otherwise { truncated:false, snippet, variableName }.
 */
export function buildFeatureCollectionSnippet(name, geoJson, maxChars = SHP_SNIPPET_MAX_CHARS) {
  const variableName = sanitizeSnippetVariableName(name);
  const snippet = `var ${variableName} = ee.FeatureCollection(${JSON.stringify(geoJson)});`;
  if (snippet.length > maxChars) return { truncated: true };
  return { truncated: false, snippet, variableName };
}

import assert from "node:assert/strict";
import {
  SHP_SET_MAX_BYTES,
  SHP_MAX_FEATURES,
  SHP_SNIPPET_MAX_CHARS,
  SHP_CLOUD_DIRECT_MAX_BYTES,
  validateShapefileSet,
  parseShapefileToGeoJson,
  buildFeatureCollectionSnippet,
  sanitizeSnippetVariableName
} from "../lib/shapefile.js";
import {
  SHP_ASSETS_KEY,
  readShpAssets,
  writeShpAssets,
  sanitizeShpAssets
} from "../lib/storage.js";

// ---------- binary fixture builders ----------

function toArrayBuffer(buffer) {
  return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
}

function shpRecord(index, content) {
  const header = Buffer.alloc(8);
  header.writeInt32BE(index, 0);
  header.writeInt32BE(content.length / 2, 4); // content length in 16-bit words
  return Buffer.concat([header, content]);
}

function buildShp(fileShapeType, contents) {
  const body = Buffer.concat(contents.map((content, index) => shpRecord(index + 1, content)));
  const header = Buffer.alloc(100);
  header.writeInt32BE(9994, 0);
  header.writeInt32BE((100 + body.length) / 2, 24);
  header.writeInt32LE(1000, 28);
  header.writeInt32LE(fileShapeType, 32);
  return Buffer.concat([header, body]);
}

function pointContent(x, y) {
  const buf = Buffer.alloc(20);
  buf.writeInt32LE(1, 0);
  buf.writeDoubleLE(x, 4);
  buf.writeDoubleLE(y, 12);
  return buf;
}

function nullContent() {
  const buf = Buffer.alloc(4);
  buf.writeInt32LE(0, 0);
  return buf;
}

function pointZContent(x, y, z) {
  const buf = Buffer.alloc(28);
  buf.writeInt32LE(11, 0);
  buf.writeDoubleLE(x, 4);
  buf.writeDoubleLE(y, 12);
  buf.writeDoubleLE(z, 20);
  return buf;
}

function pathsContent(shapeType, parts, withZ) {
  const points = parts.flat();
  let size = 4 + 32 + 4 + 4 + 4 * parts.length + 16 * points.length;
  if (withZ) size += 16 + 8 * points.length;
  const buf = Buffer.alloc(size);
  let off = 0;
  buf.writeInt32LE(shapeType, off);
  off += 4;
  const xs = points.map((point) => point[0]);
  const ys = points.map((point) => point[1]);
  buf.writeDoubleLE(Math.min(...xs), off);
  buf.writeDoubleLE(Math.min(...ys), off + 8);
  buf.writeDoubleLE(Math.max(...xs), off + 16);
  buf.writeDoubleLE(Math.max(...ys), off + 24);
  off += 32;
  buf.writeInt32LE(parts.length, off);
  off += 4;
  buf.writeInt32LE(points.length, off);
  off += 4;
  let cursor = 0;
  for (const part of parts) {
    buf.writeInt32LE(cursor, off);
    off += 4;
    cursor += part.length;
  }
  for (const [x, y] of points) {
    buf.writeDoubleLE(x, off);
    buf.writeDoubleLE(y, off + 8);
    off += 16;
  }
  if (withZ) {
    buf.writeDoubleLE(0, off);
    buf.writeDoubleLE(1, off + 8);
    off += 16;
    for (const point of points) {
      buf.writeDoubleLE(point[2] ?? 0, off);
      off += 8;
    }
  }
  return buf;
}

function multiPointContent(points) {
  const buf = Buffer.alloc(4 + 32 + 4 + 16 * points.length);
  buf.writeInt32LE(8, 0);
  const xs = points.map((point) => point[0]);
  const ys = points.map((point) => point[1]);
  buf.writeDoubleLE(Math.min(...xs), 4);
  buf.writeDoubleLE(Math.min(...ys), 12);
  buf.writeDoubleLE(Math.max(...xs), 20);
  buf.writeDoubleLE(Math.max(...ys), 28);
  buf.writeInt32LE(points.length, 36);
  let off = 40;
  for (const [x, y] of points) {
    buf.writeDoubleLE(x, off);
    buf.writeDoubleLE(y, off + 8);
    off += 16;
  }
  return buf;
}

function utf8Field(value, length) {
  const bytes = Buffer.from(value, "utf8");
  const out = Buffer.alloc(length, 0x20);
  bytes.copy(out, 0, 0, Math.min(bytes.length, length));
  return out;
}

function buildDbf(fields, records) {
  // records: [{ deleted?, values: [Buffer, ...] }]
  const headerSize = 32 + fields.length * 32 + 1;
  const recordSize = 1 + fields.reduce((sum, field) => sum + field.length, 0);
  const header = Buffer.alloc(headerSize);
  header.writeUInt8(0x03, 0);
  header.writeUInt8(126, 1);
  header.writeUInt8(8, 2);
  header.writeUInt8(8, 3);
  header.writeUInt32LE(records.length, 4);
  header.writeUInt16LE(headerSize, 8);
  header.writeUInt16LE(recordSize, 10);
  let off = 32;
  for (const field of fields) {
    Buffer.from(field.name.slice(0, 10), "ascii").copy(header, off);
    header.writeUInt8(field.type.charCodeAt(0), off + 11);
    header.writeUInt8(field.length, off + 16);
    header.writeUInt8(field.decimals || 0, off + 17);
    off += 32;
  }
  header.writeUInt8(0x0d, off);
  const body = records.map((record) => Buffer.concat([
    Buffer.from([record.deleted ? 0x2a : 0x20]),
    ...record.values
  ]));
  return Buffer.concat([header, ...body]);
}

function buildEmptyDbf(recordCount) {
  const header = Buffer.alloc(33);
  header.writeUInt8(0x03, 0);
  header.writeUInt32LE(recordCount, 4);
  header.writeUInt16LE(33, 8);
  header.writeUInt16LE(1, 10);
  header.writeUInt8(0x0d, 32);
  const body = Buffer.alloc(recordCount, 0x20);
  return Buffer.concat([header, body]);
}

const WGS84_PRJ = 'GEOGCS["GCS_WGS_1984",DATUM["D_WGS_1984",SPHEROID["WGS_1984",6378137.0,298.257223563]],'
  + 'PRIMEM["Greenwich",0.0],UNIT["Degree",0.0174532925199433]]';
const UTM_PRJ = 'PROJCS["WGS_1984_UTM_Zone_50N",GEOGCS["GCS_WGS_1984",DATUM["D_WGS_1984",'
  + 'SPHEROID["WGS_1984",6378137.0,298.257223563]],PRIMEM["Greenwich",0.0],'
  + 'UNIT["Degree",0.0174532925199433]],PROJECTION["Transverse_Mercator"]]';

function textBuffer(text) {
  return toArrayBuffer(Buffer.from(text, "utf8"));
}

// ---------- constants ----------

assert.equal(SHP_SET_MAX_BYTES, 32 * 1024 * 1024);
assert.equal(SHP_MAX_FEATURES, 50000);
assert.equal(SHP_SNIPPET_MAX_CHARS, 1024 * 1024);
assert.equal(SHP_CLOUD_DIRECT_MAX_BYTES, 8 * 1024 * 1024);

// ---------- validateShapefileSet matrix ----------

{
  const ok = validateShapefileSet([
    { name: "River.shp", size: 100 },
    { name: "river.SHX", size: 50 },
    { name: "RIVER.dbf", size: 80 },
    { name: "River.prj", size: 10 },
    { name: "River.cpg", size: 5 }
  ]);
  assert.deepEqual(ok, { ok: true, missing: [], baseName: "River", error: "" }, "case-insensitive set passes");
}

{
  const missing = validateShapefileSet([
    { name: "lake.shp", size: 10 },
    { name: "lake.shx", size: 10 }
  ]);
  assert.equal(missing.ok, false);
  assert.deepEqual(missing.missing, ["dbf"]);
  assert.equal(missing.baseName, "lake");
  assert.ok(missing.error.includes(".dbf"), "missing file error is presentable");
}

{
  const mixed = validateShapefileSet([
    { name: "a.shp", size: 1 }, { name: "a.shx", size: 1 }, { name: "a.dbf", size: 1 },
    { name: "b.shp", size: 1 }
  ]);
  assert.equal(mixed.ok, false);
  assert.ok(mixed.error.includes("多套"));
}

{
  const duplicated = validateShapefileSet([
    { name: "a.shp", size: 1 }, { name: "A.SHP", size: 1 },
    { name: "a.shx", size: 1 }, { name: "a.dbf", size: 1 }
  ]);
  assert.equal(duplicated.ok, false);
  assert.ok(duplicated.error.includes("重复"));
}

{
  const unknown = validateShapefileSet([
    { name: "a.shp", size: 1 }, { name: "a.shx", size: 1 },
    { name: "a.dbf", size: 1 }, { name: "a.shp.xml", size: 1 }
  ]);
  assert.equal(unknown.ok, false);
  assert.ok(unknown.error.includes("不支持"));
}

{
  assert.equal(validateShapefileSet([]).ok, false);
  assert.equal(validateShapefileSet(null).ok, false);
  assert.equal(validateShapefileSet([{ name: "noext", size: 1 }]).ok, false);
}

{
  const oversized = validateShapefileSet([
    { name: "big.shp", size: 30 * 1024 * 1024 },
    { name: "big.shx", size: 3 * 1024 * 1024 },
    { name: "big.dbf", size: 1024 }
  ]);
  assert.equal(oversized.ok, false);
  assert.ok(oversized.error.includes("32"), "byte cap error mentions the 32 MB limit");
}

// ---------- point parsing with UTF-8 attributes ----------

{
  const fields = [
    { name: "NAME", type: "C", length: 10 },
    { name: "POP", type: "N", length: 6, decimals: 1 },
    { name: "UPDATED", type: "D", length: 8 }
  ];
  const dbf = buildDbf(fields, [{
    values: [utf8Field("北京", 10), utf8Field("12.5", 6), utf8Field("20260808", 8)]
  }]);
  const progress = [];
  const result = await parseShapefileToGeoJson({
    shp: toArrayBuffer(buildShp(1, [pointContent(116.4, 39.9)])),
    dbf: toArrayBuffer(dbf),
    prj: textBuffer(WGS84_PRJ),
    cpg: textBuffer("UTF-8\n")
  }, { onProgress: (state) => progress.push(state) });

  assert.equal(result.featureCount, 1);
  assert.deepEqual(result.properties, ["NAME", "POP", "UPDATED"]);
  assert.deepEqual(result.geoJson.type, "FeatureCollection");
  const feature = result.geoJson.features[0];
  assert.deepEqual(feature.geometry, { type: "Point", coordinates: [116.4, 39.9] });
  assert.deepEqual(feature.properties, { NAME: "北京", POP: 12.5, UPDATED: "2026-08-08" });
  assert.deepEqual(result.bbox, [116.4, 39.9, 116.4, 39.9]);
  assert.equal(progress.at(-1).done, true);
  assert.equal(progress.at(-1).processed, 1);
}

// ---------- polyline / polygon / multipoint geometries ----------

{
  const dbf = buildEmptyDbf(1);
  const multi = await parseShapefileToGeoJson({
    shp: toArrayBuffer(buildShp(3, [pathsContent(3, [[[0, 0], [1, 1]], [[2, 2], [3, 3], [4, 0]]])])),
    dbf: toArrayBuffer(dbf)
  });
  assert.deepEqual(multi.geoJson.features[0].geometry, {
    type: "MultiLineString",
    coordinates: [[[0, 0], [1, 1]], [[2, 2], [3, 3], [4, 0]]]
  });

  const single = await parseShapefileToGeoJson({
    shp: toArrayBuffer(buildShp(3, [pathsContent(3, [[[5, 5], [6, 6]]])])),
    dbf: toArrayBuffer(buildEmptyDbf(1))
  });
  assert.deepEqual(single.geoJson.features[0].geometry, { type: "LineString", coordinates: [[5, 5], [6, 6]] });
}

{
  // outer ring is clockwise, hole is counter-clockwise (shapefile convention)
  const outer = [[0, 0], [0, 10], [10, 10], [10, 0], [0, 0]];
  const hole = [[2, 2], [8, 2], [8, 8], [2, 8], [2, 2]];
  const result = await parseShapefileToGeoJson({
    shp: toArrayBuffer(buildShp(5, [pathsContent(5, [outer, hole])])),
    dbf: toArrayBuffer(buildEmptyDbf(1))
  });
  const geometry = result.geoJson.features[0].geometry;
  assert.equal(geometry.type, "Polygon");
  assert.equal(geometry.coordinates.length, 2, "hole is attached to the outer ring");
  assert.deepEqual(geometry.coordinates[0], outer);
  assert.deepEqual(geometry.coordinates[1], hole);
  assert.deepEqual(result.bbox, [0, 0, 10, 10]);
}

{
  // two clockwise rings in separate parts become a MultiPolygon
  const ringA = [[0, 0], [0, 1], [1, 1], [1, 0], [0, 0]];
  const ringB = [[5, 5], [5, 6], [6, 6], [6, 5], [5, 5]];
  const result = await parseShapefileToGeoJson({
    shp: toArrayBuffer(buildShp(5, [pathsContent(5, [ringA, ringB])])),
    dbf: toArrayBuffer(buildEmptyDbf(1))
  });
  const geometry = result.geoJson.features[0].geometry;
  assert.equal(geometry.type, "MultiPolygon");
  assert.deepEqual(geometry.coordinates, [[ringA], [ringB]]);
}

{
  const result = await parseShapefileToGeoJson({
    shp: toArrayBuffer(buildShp(8, [multiPointContent([[1, 2], [3, 4]])])),
    dbf: toArrayBuffer(buildEmptyDbf(1))
  });
  assert.deepEqual(result.geoJson.features[0].geometry, { type: "MultiPoint", coordinates: [[1, 2], [3, 4]] });
}

// ---------- Z variants flatten to 2D ----------

{
  const pointZ = await parseShapefileToGeoJson({
    shp: toArrayBuffer(buildShp(11, [pointZContent(10, 20, 30)])),
    dbf: toArrayBuffer(buildEmptyDbf(1))
  });
  assert.deepEqual(pointZ.geoJson.features[0].geometry, { type: "Point", coordinates: [10, 20] });

  const outer = [[0, 0], [0, 1], [1, 1], [1, 0], [0, 0]].map(([x, y]) => [x, y, 5]);
  const polygonZ = await parseShapefileToGeoJson({
    shp: toArrayBuffer(buildShp(15, [pathsContent(15, [outer], true)])),
    dbf: toArrayBuffer(buildEmptyDbf(1))
  });
  assert.equal(polygonZ.geoJson.features[0].geometry.type, "Polygon");
  assert.deepEqual(polygonZ.geoJson.features[0].geometry.coordinates[0][0], [0, 0]);
}

// ---------- encodings ----------

{
  // GBK-declared attribute table decodes through the .cpg label
  const gbkBytes = Buffer.concat([Buffer.from([0xb1, 0xb1, 0xbe, 0xa9]), Buffer.alloc(6, 0x20)]);
  const dbf = buildDbf([{ name: "NAME", type: "C", length: 10 }], [{ values: [gbkBytes] }]);
  const result = await parseShapefileToGeoJson({
    shp: toArrayBuffer(buildShp(1, [pointContent(0, 0)])),
    dbf: toArrayBuffer(dbf),
    cpg: textBuffer("GBK")
  });
  assert.equal(result.geoJson.features[0].properties.NAME, "北京");
}

{
  // unknown .cpg labels fall back to UTF-8 instead of aborting
  const dbf = buildDbf([{ name: "NAME", type: "C", length: 10 }], [{ values: [utf8Field("北京", 10)] }]);
  const result = await parseShapefileToGeoJson({
    shp: toArrayBuffer(buildShp(1, [pointContent(0, 0)])),
    dbf: toArrayBuffer(dbf),
    cpg: textBuffer("NO-SUCH-ENCODING-9999")
  });
  assert.equal(result.geoJson.features[0].properties.NAME, "北京");
}

{
  // undecodable bytes become U+FFFD replacement chars without throwing
  const bad = Buffer.concat([Buffer.from([0xff, 0xfe, 0x41]), Buffer.alloc(7, 0x20)]);
  const dbf = buildDbf([{ name: "NOTE", type: "C", length: 10 }], [{ values: [bad] }]);
  const result = await parseShapefileToGeoJson({
    shp: toArrayBuffer(buildShp(1, [pointContent(0, 0)])),
    dbf: toArrayBuffer(dbf)
  });
  assert.ok(result.geoJson.features[0].properties.NOTE.includes("\uFFFD"));
  assert.ok(result.geoJson.features[0].properties.NOTE.includes("A"));
}

// ---------- deleted dbf records keep index alignment ----------

{
  const fields = [{ name: "NAME", type: "C", length: 4 }];
  const dbf = buildDbf(fields, [
    { values: [utf8Field("a", 4)] },
    { deleted: true, values: [utf8Field("b", 4)] }
  ]);
  const result = await parseShapefileToGeoJson({
    shp: toArrayBuffer(buildShp(1, [pointContent(0, 0), pointContent(1, 1)])),
    dbf: toArrayBuffer(dbf)
  });
  assert.equal(result.featureCount, 2);
  assert.deepEqual(result.geoJson.features[0].properties, { NAME: "a" });
  assert.deepEqual(result.geoJson.features[1].properties, { NAME: null });
}

// ---------- null shapes keep attribute alignment ----------

{
  // DBF rows map 1:1 onto SHP records; a Null shape still consumes its row,
  // so later features must read later rows, not features.length.
  const fields = [{ name: "NAME", type: "C", length: 4 }];
  const dbf = buildDbf(fields, [
    { values: [utf8Field("a", 4)] },
    { values: [utf8Field("x", 4)] },
    { values: [utf8Field("b", 4)] }
  ]);
  const result = await parseShapefileToGeoJson({
    shp: toArrayBuffer(buildShp(1, [pointContent(0, 0), nullContent(), pointContent(2, 2)])),
    dbf: toArrayBuffer(dbf)
  });
  assert.equal(result.featureCount, 2, "the Null shape yields no feature");
  assert.deepEqual(result.geoJson.features[0].properties, { NAME: "a" });
  assert.deepEqual(result.geoJson.features[0].geometry.coordinates, [0, 0]);
  assert.deepEqual(result.geoJson.features[1].properties, { NAME: "b" }, "rows after a Null shape stay aligned");
  assert.deepEqual(result.geoJson.features[1].geometry.coordinates, [2, 2]);
}

// ---------- .prj gating ----------

{
  await assert.rejects(
    parseShapefileToGeoJson({
      shp: toArrayBuffer(buildShp(1, [pointContent(0, 0)])),
      dbf: toArrayBuffer(buildEmptyDbf(1)),
      prj: textBuffer(UTM_PRJ)
    }),
    (error) => error.message.includes("EPSG:4326") && error.message.includes("重投影")
  );
  await assert.rejects(
    parseShapefileToGeoJson({
      shp: toArrayBuffer(buildShp(1, [pointContent(0, 0)])),
      dbf: toArrayBuffer(buildEmptyDbf(1)),
      prj: textBuffer('GEOGCS["GCS_Unknown_Datum",PRIMEM["Greenwich",0.0]]')
    }),
    (error) => error.message.includes("EPSG:4326")
  );
  // no .prj at all is assumed to be WGS84 and parses cleanly
  const withoutPrj = await parseShapefileToGeoJson({
    shp: toArrayBuffer(buildShp(1, [pointContent(0, 0)])),
    dbf: toArrayBuffer(buildEmptyDbf(1))
  });
  assert.equal(withoutPrj.featureCount, 1);
}

// ---------- unsupported / corrupted inputs ----------

{
  const multiPatch = Buffer.alloc(20);
  multiPatch.writeInt32LE(19, 0);
  await assert.rejects(
    parseShapefileToGeoJson({
      shp: toArrayBuffer(buildShp(19, [multiPatch])),
      dbf: toArrayBuffer(buildEmptyDbf(1))
    }),
    (error) => error.message.includes("MultiPatch")
  );
  const unknownType = pointContent(0, 0);
  unknownType.writeInt32LE(21, 0);
  await assert.rejects(
    parseShapefileToGeoJson({
      shp: toArrayBuffer(buildShp(21, [unknownType])),
      dbf: toArrayBuffer(buildEmptyDbf(1))
    }),
    (error) => error.message.includes("不支持")
  );
  const badMagic = buildShp(1, [pointContent(0, 0)]);
  badMagic.writeInt32BE(1234, 0);
  await assert.rejects(
    parseShapefileToGeoJson({ shp: toArrayBuffer(badMagic), dbf: toArrayBuffer(buildEmptyDbf(1)) }),
    (error) => error.message.includes("9994")
  );
  await assert.rejects(
    parseShapefileToGeoJson({ dbf: toArrayBuffer(buildEmptyDbf(1)) }),
    (error) => error.message.includes(".shp")
  );
}

// ---------- truncated multi-geometry record bodies are rejected ----------

{
  // MultiPoint declares 2 points (full body 72 bytes) but the record is cut
  // to 56 bytes; without a full-body check the reader would run past the
  // record into neighbouring data.
  const truncatedMultiPoint = multiPointContent([[1, 2], [3, 4]]).subarray(0, 56);
  await assert.rejects(
    parseShapefileToGeoJson({
      shp: toArrayBuffer(buildShp(8, [truncatedMultiPoint])),
      dbf: toArrayBuffer(buildEmptyDbf(1))
    }),
    (error) => error.message.includes("MultiPoint") && error.message.includes("已损坏")
  );

  // PolyLine declares 1 part / 2 points (full body 80 bytes), cut to 60.
  const truncatedPath = pathsContent(3, [[[0, 0], [1, 1]]]).subarray(0, 60);
  await assert.rejects(
    parseShapefileToGeoJson({
      shp: toArrayBuffer(buildShp(3, [truncatedPath])),
      dbf: toArrayBuffer(buildEmptyDbf(1))
    }),
    (error) => error.message.includes("PolyLine/Polygon") && error.message.includes("已损坏")
  );
}

// ---------- limits ----------

{
  const count = SHP_MAX_FEATURES + 1;
  const body = Buffer.alloc(count * 28);
  for (let index = 0; index < count; index += 1) {
    const off = index * 28;
    body.writeInt32BE(index + 1, off);
    body.writeInt32BE(10, off + 4);
    body.writeInt32LE(1, off + 8);
    body.writeDoubleLE(index % 100, off + 12);
    body.writeDoubleLE(index % 50, off + 20);
  }
  const header = Buffer.alloc(100);
  header.writeInt32BE(9994, 0);
  header.writeInt32BE((100 + body.length) / 2, 24);
  header.writeInt32LE(1000, 28);
  header.writeInt32LE(1, 32);
  const shp = Buffer.concat([header, body]);
  await assert.rejects(
    parseShapefileToGeoJson({ shp: toArrayBuffer(shp), dbf: toArrayBuffer(buildEmptyDbf(count)) }),
    (error) => error.message.includes(String(SHP_MAX_FEATURES))
  );
}

{
  const huge = Buffer.alloc(SHP_SET_MAX_BYTES + 1024);
  huge.writeInt32BE(9994, 0);
  await assert.rejects(
    parseShapefileToGeoJson({ shp: toArrayBuffer(huge), dbf: toArrayBuffer(buildEmptyDbf(1)) }),
    (error) => error.message.includes("32")
  );
}

// ---------- snippet builder ----------

{
  const geoJson = { type: "FeatureCollection", features: [] };
  const snippet = buildFeatureCollectionSnippet("basin-2024", geoJson);
  assert.equal(snippet.truncated, false);
  assert.equal(snippet.variableName, "basin_2024");
  assert.ok(snippet.snippet.startsWith("var basin_2024 = ee.FeatureCollection("));
  assert.ok(snippet.snippet.endsWith(");"));

  assert.equal(sanitizeSnippetVariableName("2024边界"), "shp_2024");
  assert.equal(sanitizeSnippetVariableName("流域.shp"), "shp");
  assert.equal(sanitizeSnippetVariableName("！！！"), "shp_asset");
  assert.equal(sanitizeSnippetVariableName(""), "shp_asset");

  assert.deepEqual(buildFeatureCollectionSnippet("basin", geoJson, 20), { truncated: true });
}

// ---------- storage: shpAssetsV1 ----------

assert.equal(SHP_ASSETS_KEY, "shpAssetsV1");

function createFakeStorage(initial = {}) {
  const data = structuredClone(initial);
  return {
    data,
    async get(key) {
      return { [key]: structuredClone(data[key]) };
    },
    async set(values) {
      Object.assign(data, structuredClone(values));
    },
    async remove(key) {
      delete data[key];
    }
  };
}

{
  const valid = {
    id: "shp:river",
    name: "river",
    featureCount: 2,
    bbox: [0, 0, 1, 1],
    properties: ["NAME"],
    geoJson: { type: "FeatureCollection", features: [{ type: "Feature", properties: {}, geometry: null }] },
    createdAt: 1754600000000
  };
  const sanitized = sanitizeShpAssets([
    valid,
    { name: "broken", geoJson: { type: "Feature" } },
    { name: "", geoJson: { type: "FeatureCollection", features: [] } },
    { ...valid }, // duplicate id is dropped
    { name: "noBbox", featureCount: "x", geoJson: { type: "FeatureCollection", features: [1] }, createdAt: "soon" }
  ]);
  assert.equal(sanitized.length, 2);
  assert.deepEqual(sanitized[0], valid);
  assert.equal(sanitized[1].id, "shp:noBbox");
  assert.equal(sanitized[1].bbox, null);
  assert.equal(sanitized[1].featureCount, 1, "invalid featureCount falls back to features.length");
  assert.equal(sanitized[1].createdAt, 0);
  assert.deepEqual(sanitizeShpAssets(null), []);
  assert.deepEqual(sanitizeShpAssets("nope"), []);
}

{
  const asset = {
    id: "shp:river",
    name: "river",
    featureCount: 1,
    bbox: [0, 0, 1, 1],
    properties: ["NAME"],
    geoJson: { type: "FeatureCollection", features: [] },
    createdAt: 123
  };
  const storage = createFakeStorage();
  const written = await writeShpAssets(storage, [asset]);
  assert.deepEqual(written, [asset]);
  assert.deepEqual(storage.data[SHP_ASSETS_KEY], [asset]);
  assert.deepEqual(await readShpAssets(storage), [asset]);
  assert.deepEqual(await readShpAssets(createFakeStorage()), []);

  await writeShpAssets(storage, []);
  assert.equal(SHP_ASSETS_KEY in storage.data, false, "empty asset list is written as removal");
}

console.log("Shapefile parsing tests passed.");

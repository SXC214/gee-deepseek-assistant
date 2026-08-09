import assert from "node:assert/strict";
import {
  INDEX_VERSION_NOTE,
  extractEeCalls,
  lintGeeScript,
  validateEeCalls
} from "../lib/ee-api-validate.js";

// Inline fixture index matching the lib/ee-api-index.json contract.
const index = {
  schemaVersion: 1,
  generatedAt: "2026-08-09T00:00:00Z",
  sourceUrl: "https://developers.google.com/earth-engine/apidocs",
  classes: {
    Image: { methods: ["addBands", "clip", "multiply", "normalizedDifference", "reduceRegion", "select"] },
    ImageCollection: { methods: ["filterBounds", "filterDate", "map", "median", "mosaic", "select"] },
    FeatureCollection: { methods: ["filterBounds", "geometry", "map", "size"] },
    Reducer: { methods: ["count", "forEach", "mean", "median", "sum"] },
    Algorithms: { methods: ["If", "IsOnly", "Landsat.simpleComposite"] },
    Number: { methods: ["add", "format", "multiply"] }
  }
};

// --- extractEeCalls ---
const extracted = extractEeCalls(`
  // ee.Fake.lineComment should be ignored
  /* ee.FakeCollection.blockComment */
  var note = "ee.FakeReducer.inString";
  var template = \`ee.FakeNumber.inTemplate\`;
  var image = ee.Image("LANDSAT/LC08").ndvi();
  var collection = ee.ImageCollection("COPERNICUS/S2").filterDate("2020-01-01", "2020-12-31");
  var twice = ee.Image(1);
  var deep = ee.Algorithms.Landsat.simpleComposite();
`);
assert.ok(!extracted.some((symbol) => symbol.includes("Fake")), "comments/strings must not leak");
assert.deepEqual(extracted.filter((symbol) => symbol.startsWith("ee.Image")), ["ee.Image", "ee.ImageCollection"]);
assert.ok(extracted.includes("ee.Algorithms.Landsat.simpleComposite"), "three-segment chains are extracted");
assert.equal(extracted.filter((symbol) => symbol === "ee.Image").length, 1, "symbols are deduplicated");

// --- extractEeCalls: multi-line template literals stay opaque ---
const multilineTemplate = extractEeCalls("var note = `\nopen template ee.FakeSymbol.body ( with [ unbalanced\n`;\nvar img = ee.Image('x');");
assert.ok(!multilineTemplate.some((symbol) => symbol.includes("Fake")), "multi-line template content must not be scanned");
assert.deepEqual(multilineTemplate, ["ee.Image"], "code outside the template is still extracted");

// --- validateEeCalls: legit calls and instance chains ---
const clean = validateEeCalls('var img = ee.Image("LC08").ndvi().rename("NDVI");\nvar col = ee.ImageCollection("S2").filterDate("a", "b");', { index });
assert.equal(clean.unknown.length, 0, "ee.Image passes, instance chain .ndvi() is not checked");
assert.equal(clean.verifiedByContext, 0);
assert.equal(clean.truncated, 0);

// --- validateEeCalls: hallucinated method with suggestion quality ---
const hallucinated = validateEeCalls("var img = ee.Image.adBands(x);", { index });
assert.equal(hallucinated.unknown.length, 1);
assert.equal(hallucinated.unknown[0].symbol, "ee.Image.adBands");
assert.ok(hallucinated.unknown[0].suggestions.includes("addBands"));
assert.equal(hallucinated.unknown[0].url, "https://developers.google.com/earth-engine/apidocs/ee-image");
const instanceChain = validateEeCalls('var x = ee.Image("LC08").totallyFake();', { index });
assert.equal(instanceChain.unknown.length, 0, "instance methods after a constructor call are not statically resolvable");

// --- validateEeCalls: unknown class with close-name suggestions ---
const unknownClass = validateEeCalls("var x = ee.Imag(1);", { index });
assert.equal(unknownClass.unknown.length, 1);
assert.equal(unknownClass.unknown[0].symbol, "ee.Imag");
assert.ok(unknownClass.unknown[0].suggestions.includes("Image"));
assert.equal(unknownClass.unknown[0].url, "https://developers.google.com/earth-engine/apidocs/ee-imag");

// --- validateEeCalls: verifiedContext exemptions ---
const bySymbol = validateEeCalls("var x = ee.Image.adBands(1);", { index, verifiedContext: "已核对 ee.Image.adBands 存在于官方文档" });
assert.equal(bySymbol.unknown.length, 0);
assert.equal(bySymbol.verifiedByContext, 1);
const byClassDotMethod = validateEeCalls("var x = ee.Image.adBands(1);", { index, verifiedContext: "确认 Image.adBands 可用" });
assert.equal(byClassDotMethod.unknown.length, 0);
assert.equal(byClassDotMethod.verifiedByContext, 1);

// --- validateEeCalls: verifiedContext must anchor on word boundaries ---
const bareWordWash = validateEeCalls("var x = ee.Info(1);", { index, verifiedContext: "快照文本含 info 字样的说明" });
assert.equal(bareWordWash.unknown.length, 1, "a bare word must not wash an unknown symbol clean");
const anchoredClass = validateEeCalls("var x = ee.Info(1);", { index, verifiedContext: "已核对 ee.Info 官方文档" });
assert.equal(anchoredClass.verifiedByContext, 1);
assert.equal(anchoredClass.unknown.length, 0);
const longerSymbol = validateEeCalls("var x = ee.Info(1);", { index, verifiedContext: "仅核对过 ee.Information" });
assert.equal(longerSymbol.unknown.length, 1, "a longer symbol must not verify a shorter prefix");

// --- validateEeCalls: bracket / Algorithms / top-level exemptions ---
const exempted = validateEeCalls(`
  var constant = ee.Image["constant"];
  var composite = ee.Algorithms.Landsat.simpleComposite({ input: col });
  var dynamic = ee.Algorithms.Foo.Bar.Baz(1);
  ee.initialize();
  ee.Authenticate();
  ee.load("users/x/y");
`, { index });
assert.equal(exempted.unknown.length, 0, "bracket access, three-plus segments and whitelisted top-level calls are exempt");

// --- validateEeCalls: cap at 8 reports ---
const overflow = validateEeCalls(
  Array.from({ length: 10 }, (_, i) => `var u${i} = ee.Image.fake${i}(x);`).join("\n"),
  { index }
);
assert.equal(overflow.unknown.length, 8);
assert.equal(overflow.truncated, 2);

// --- INDEX_VERSION_NOTE ---
assert.match(INDEX_VERSION_NOTE, /\{generatedAt\}/);
assert.match(INDEX_VERSION_NOTE, /未在本地官方名单/);

// --- lintGeeScript ---
const goodScript = 'var image = ee.Image("LC08");\nvar mean = image.reduceRegion({ reducer: ee.Reducer.mean() });\nprint(mean);';
assert.deepEqual(lintGeeScript(goodScript), { ok: true, errors: [] });

assert.equal(lintGeeScript("").ok, false, "empty script rejected");
assert.match(lintGeeScript("").errors[0], /为空/);
assert.equal(lintGeeScript("var a = 1;\nvar b = 2;").ok, false, "short script rejected");
assert.match(lintGeeScript("var a = 1;\nvar b = 2;").errors[0], /行数/);

const unbalancedParen = lintGeeScript("var a = (1;\nvar b = 2;\nvar c = 3;");
assert.equal(unbalancedParen.ok, false);
assert.match(unbalancedParen.errors.join(" "), /括号/);
const unbalancedBrace = lintGeeScript("function f() {\n  return 1;\n");
assert.equal(unbalancedBrace.ok, false);
const strayBracket = lintGeeScript("var a = 1]\nvar b = 2;\nvar c = 3;");
assert.equal(strayBracket.ok, false);
const balancedCommentNoise = lintGeeScript("// stray ( brace in comment\n/* } */\nvar a = 1;");
assert.equal(balancedCommentNoise.ok, true, "brackets inside comments/strings are ignored");
const multilineTemplateLint = lintGeeScript("var note = `\n( [ { stray brackets\n`;\nvar b = 2;\nvar c = 3;");
assert.equal(multilineTemplateLint.ok, true, "newlines and brackets inside multi-line templates must not break lint");

const oauthLeak = lintGeeScript('var token = "ya29.a0AfH6SMBx";\nvar b = 2;\nvar c = 3;');
assert.equal(oauthLeak.ok, false);
assert.match(oauthLeak.errors.join(" "), /OAuth token/);
assert.equal(lintGeeScript("var t = accessToken;\nvar b = 2;\nvar c = 3;").ok, false);
assert.match(lintGeeScript("document.cookie = x;\nvar b = 2;\nvar c = 3;").errors.join(" "), /Cookie/);
assert.match(lintGeeScript("var h = xsrfToken;\nvar b = 2;\nvar c = 3;").errors.join(" "), /XSRF/);
assert.match(lintGeeScript('var key = "-----BEGIN PRIVATE KEY-----";\nvar b = 2;\nvar c = 3;').errors.join(" "), /私钥/);

const oversized = Array.from({ length: 410 }, (_, i) => `var v${i} = ${"0".repeat(1000)};`).join("\n");
assert.equal(lintGeeScript(oversized).ok, false, "scripts over 400KB rejected");
assert.match(lintGeeScript(oversized).errors.join(" "), /400KB/);

console.log("EE API validate tests passed.");

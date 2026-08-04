import assert from "node:assert/strict";
import {
  directApiDocEntries,
  expandQuery,
  extractOfficialPage,
  parseDatasetIndexHtml,
  parseDocsIndexHtml,
  rankEntries
} from "../lib/search.js";

const datasetHtml = `
  <ul>
    <li><a href="/earth-engine/datasets/catalog/COPERNICUS_S2_SR_HARMONIZED">Harmonized Sentinel-2 Surface Reflectance</a><p>Optical imagery with reflectance bands.</p></li>
    <li><a href="/earth-engine/datasets/catalog/UCSB-CHG_CHIRPS_DAILY">CHIRPS Daily</a><p>Daily precipitation.</p></li>
  </ul>`;
const datasets = parseDatasetIndexHtml(datasetHtml);
assert.equal(datasets.length, 2);
assert.match(datasets[0].description, /Optical imagery/);
assert.equal(rankEntries(datasets, "哨兵2地表反射率", 1)[0].slug, "COPERNICUS_S2_SR_HARMONIZED");
assert.equal(rankEntries(datasets, "daily precipitation", 1)[0].slug, "UCSB-CHG_CHIRPS_DAILY");
assert.match(expandQuery("计算降水"), /precipitation/);

const docsHtml = `
  <nav>
    <a href="/earth-engine/apidocs/ee-image-reduceregion">ee.Image.reduceRegion</a>
    <a href="/earth-engine/guides/reducers_intro">Reducers overview</a>
    <a href="/earth-engine/datasets/catalog/COPERNICUS_S2">Dataset should be excluded</a>
  </nav>`;
const docs = parseDocsIndexHtml(docsHtml);
assert.equal(docs.length, 2);
assert.equal(rankEntries(docs, "reduceRegion", 1)[0].title, "ee.Image.reduceRegion");
assert.equal(rankEntries(docs, "ee.Image.reduceRegion", 1)[0].title, "ee.Image.reduceRegion");
assert.equal(directApiDocEntries("解释 ee.Image.normalizedDifference")[0].url, "https://developers.google.com/earth-engine/apidocs/ee-image-normalizeddifference");

const pageHtml = `
  <html><head><title>Sentinel dataset</title><script>ignore me</script></head>
  <body><main><h1>Sentinel-2 SR</h1><p>Description and bands B2 B3 B4.</p><code>ee.ImageCollection(&quot;COPERNICUS/S2_SR_HARMONIZED&quot;)</code></main></body></html>`;
const page = extractOfficialPage(pageHtml, "https://developers.google.com/example", "sentinel bands", "dataset");
assert.equal(page.title, "Sentinel-2 SR");
assert.equal(page.datasetId, "COPERNICUS/S2_SR_HARMONIZED");
assert.match(page.summary, /bands B2 B3 B4/);

console.log("Search tests passed.");

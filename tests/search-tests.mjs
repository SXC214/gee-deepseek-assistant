import assert from "node:assert/strict";
import {
  directApiDocEntries,
  expandQuery,
  extractOfficialPage,
  parseDatasetIndexHtml,
  parseDocsIndexHtml,
  rankEntries,
  selectDatasetCandidates
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
assert.match(expandQuery("计算 2000-2020 年 NDVI 均值变化"), /landsat modis sentinel-2/);

const ndviCandidates = selectDatasetCandidates([
  { title: "Landsat annual NDVI", slug: "LANDSAT_NDVI", url: "https://example/landsat", searchText: "landsat ndvi" },
  { title: "Landsat 8-day NDVI", slug: "LANDSAT_NDVI_8DAY", url: "https://example/landsat-8", searchText: "landsat ndvi" },
  { title: "MOD13Q1 Vegetation Indices", slug: "MODIS_061_MOD13Q1", url: "https://example/modis", searchText: "modis vegetation indices ndvi" },
  { title: "Sentinel-2 Surface Reflectance", slug: "COPERNICUS_S2_SR_HARMONIZED", url: "https://example/sentinel", searchText: "sentinel-2 surface reflectance" }
], "2000-2020 NDVI", 3);
assert.match(ndviCandidates[0].url, /^https:\/\/example\/landsat/);
assert.equal(ndviCandidates[1].url, "https://example/modis");
assert.equal(ndviCandidates[2].url, "https://example/sentinel");

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

import assert from "node:assert/strict";
import fs from "node:fs";

const html = fs.readFileSync(new URL("../sidepanel.html", import.meta.url), "utf8");
const script = fs.readFileSync(new URL("../sidepanel.js", import.meta.url), "utf8");
const ids = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]));
const references = new Set([...script.matchAll(/elements\.([A-Za-z][A-Za-z0-9]*)/g)].map((match) => match[1]));

const missing = [...references].filter((id) => !ids.has(id));
assert.deepEqual(missing, [], `sidepanel.js references missing HTML ids: ${missing.join(", ")}`);
assert.equal(ids.size, [...html.matchAll(/\bid="([^"]+)"/g)].length, "HTML ids must be unique");

console.log("UI consistency tests passed.");

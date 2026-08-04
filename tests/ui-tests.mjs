import assert from "node:assert/strict";
import fs from "node:fs";

const html = fs.readFileSync(new URL("../sidepanel.html", import.meta.url), "utf8");
const script = fs.readFileSync(new URL("../sidepanel.js", import.meta.url), "utf8");
const manifest = JSON.parse(fs.readFileSync(new URL("../manifest.json", import.meta.url), "utf8"));
const packageJson = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const ids = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]));
const references = new Set([...script.matchAll(/elements\.([A-Za-z][A-Za-z0-9]*)/g)].map((match) => match[1]));

const missing = [...references].filter((id) => !ids.has(id));
assert.deepEqual(missing, [], `sidepanel.js references missing HTML ids: ${missing.join(", ")}`);
assert.equal(ids.size, [...html.matchAll(/\bid="([^"]+)"/g)].length, "HTML ids must be unique");
assert.match(html, /id="settingsButton"[^>]*aria-controls="settingsPanel"[^>]*aria-expanded="false"/);
assert.match(html, /class="settings-card hidden" id="settingsPanel"/);
assert.match(html, /id="thinkingEnabled"[^>]*checked/);
assert.match(html, /<option value="high">High（默认）<\/option>/);
assert.match(html, /<option value="max">Max（复杂任务）<\/option>/);
assert.match(html, /id="planMode"/);
assert.match(html, /id="confirmPlanButton"/);
assert.match(html, /id="continuePlanButton"/);
assert.match(html, /id="cancelPlanButton"/);
assert.match(script, /const ACTIVE_PLAN_KEY = "activePlanV1"/);
assert.match(script, /chrome\.runtime\.connect\(\{ name: "AI_CHAT_STREAM" \}\)/);
assert.match(script, /兼容模式不支持实时思考/);
assert.match(script, /if \(!currentSettings\.hasApiKey\) openSettings\(\{ focusKey: true \}\)/);
assert.match(script, /baseRevision: baseState\?\.revision/);
assert.match(script, /tabId: baseState\?\.tabId/);
assert.equal(manifest.version, "0.3.0");
assert.equal(packageJson.version, manifest.version);

console.log("UI consistency tests passed.");

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

test("frontend platform selectors expose YouTube", () => {
  const popupHtml = readText("src/popup/popup.html");
  const sidepanelHtml = readText("src/sidepanel/sidepanel.html");

  assert.match(popupHtml, /<option value="youtube">YouTube<\/option>/);
  assert.match(sidepanelHtml, /<option value="youtube">YouTube<\/option>/);
});

test("frontend platform normalizers and labels include YouTube", () => {
  const popupJs = readText("src/popup/popup.js");
  const sidepanelJs = readText("src/sidepanel/sidepanel.js");
  const contentPanelJs = readText("src/content/panel.js");

  for (const source of [popupJs, sidepanelJs, contentPanelJs]) {
    assert.match(source, /explicit === "youtube"/);
    assert.match(source, /youtube:\s*"YouTube"/);
    assert.match(source, /油管/);
  }
});

test("background allows YouTube creator profile hosts", () => {
  const serviceWorker = readText("src/background/service-worker.js");

  assert.match(serviceWorker, /youtube\.com/);
  assert.match(serviceWorker, /m\.youtube\.com/);
  assert.match(serviceWorker, /X、TikTok 或 YouTube/);
});

test("server action labels use YouTube display name", () => {
  const server = readText("backend/server.js");

  assert.match(server, /youtube:\s*"YouTube"/);
  assert.match(server, /打开 \$\{platformLabel\(plan\.platform\)\} 全站用户搜索/);
});

test("content detector preserves YouTube channel custom paths", () => {
  const detector = readText("src/content/detector.js");

  assert.match(detector, /user\\\/\[\^\/\?#\]\+/);
  assert.match(detector, /\(\?:channel\|c\|user\)\\\//);
  assert.match(detector, /return `\$\{url\.protocol\}\/\/\$\{host\}\/\$\{handle\}`/);
});

test("shared schema and export keep YouTube platform data", () => {
  const schema = readText("src/shared/schema.js");
  const exportJs = readText("src/shared/export.js");

  assert.match(schema, /youtube:\s*"YouTube"/);
  assert.match(exportJs, /"platform"/);
  assert.match(exportJs, /profileUrl/);
});

function readText(path) {
  return readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
}

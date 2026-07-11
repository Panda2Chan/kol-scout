import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { getBackendConfig } from "../backend/services/config-service.js";

test("release metadata is synchronized for v1.3.1", () => {
  const packageJson = readJson("package.json");
  const packageLock = readJson("package-lock.json");
  const manifest = readJson("manifest.json");

  assert.equal(packageJson.version, "1.3.1");
  assert.equal(packageLock.version, "1.3.1");
  assert.equal(packageLock.packages[""].version, "1.3.1");
  assert.equal(manifest.version, "1.3.1");
  assert.equal(getBackendConfig({}).version, "1.3.1");
});

test("release notes mention v1.3 YouTube integration", () => {
  const changelog = readText("CHANGELOG.md");
  const readme = readText("README.md");

  assert.match(changelog, /2026-07-09/);
  assert.match(changelog, /KOL Scout v1\.3 YouTube 接入/);
  assert.match(changelog, /2026-07-11/);
  assert.match(changelog, /YouTube fallback 切换到 Jina/);
  assert.match(readme, /TikTok、YouTube 和 X/);
});

function readJson(path) {
  return JSON.parse(readText(path));
}

function readText(path) {
  return readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
}

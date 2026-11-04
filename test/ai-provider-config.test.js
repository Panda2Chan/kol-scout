import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildAiCreatorSearchPlan,
  configureAiSearchCache,
  discoverCreatorsWithAiWebSearch,
  loadAiConfig,
  postProcessCreatorsWithAi
} from "../backend/services/ai-search-service.js";

function fixtureHome(t, { config, endpoint = "https://cc-fallback.example/v1" } = {}) {
  const homeDir = mkdtempSync(join(tmpdir(), "kol-ai-provider-"));
  t.after(() => rmSync(homeDir, { recursive: true, force: true }));
  if (!config) return homeDir;
  const directory = join(homeDir, ".cc-switch");
  mkdirSync(directory);
  writeFileSync(join(directory, "settings.json"), JSON.stringify({ currentProviderCodex: "selected" }));
  const quote = (value) => `'${String(value).replaceAll("'", "''")}'`;
  execFileSync("sqlite3", [join(directory, "cc-switch.db"), `
    CREATE TABLE providers (id TEXT, app_type TEXT, settings_config TEXT);
    CREATE TABLE provider_endpoints (id INTEGER, app_type TEXT, provider_id TEXT, url TEXT);
    INSERT INTO providers VALUES ('selected', 'codex', ${quote(JSON.stringify(config))});
    INSERT INTO provider_endpoints VALUES (1, 'codex', 'selected', ${quote(endpoint)});
  `]);
  return homeDir;
}

function ccConfig(model = "vendor/cc-default:custom") {
  return {
    auth: { OPENAI_API_KEY: "fixture-cc-key" },
    config: `model = "${model}"\nmodel_provider = 'selected-gateway'\n
[model_providers.unused]
base_url = "https://unused.example/v1"
wire_api = "chat"
[model_providers.selected-gateway]
base_url = 'https://selected.example/provider/v1/'
wire_api = 'responses'
`
  };
}

function environment(overrides = {}) {
  return { AI_API_KEY: "fixture-env-key", AI_BASE_URL: "https://gateway.example/v1", AI_MODEL: "vendor/custom:任意模型", ...overrides };
}

function interceptFetch(t, handler) {
  const original = globalThis.fetch;
  globalThis.fetch = handler;
  t.after(() => { globalThis.fetch = original; });
  configureAiSearchCache();
}

const brief = { rawText: "YouTube tech creators" };
const fallbackPlan = { platform: "youtube", positiveTerms: ["tech"], negativeTerms: [], directProfiles: [], query: "tech" };
const planOutput = { intent: "tech creators", queries: ["site:youtube.com/@ tech"], positiveTerms: ["tech"], exclude: [] };
const chatResponse = (payload = planOutput) => Response.json({ choices: [{ message: { content: JSON.stringify(payload) } }] });

test("cc-switch follows its selected provider model, endpoint and wire protocol", (t) => {
  const homeDir = fixtureHome(t, { config: ccConfig() });
  const config = loadAiConfig({ homeDir, env: {} });
  assert.equal(config.model, "vendor/cc-default:custom");
  assert.equal(config.baseUrl, "https://selected.example/provider/v1");
  assert.equal(config.apiMode, "responses");
  assert.equal(config.provider, "cc-switch");
});

test("generic environment overrides models without a model allowlist", (t) => {
  const homeDir = fixtureHome(t, { config: ccConfig() });
  const config = loadAiConfig({ homeDir, env: environment({ OPENAI_MODEL: "legacy-model", AI_SEARCH_MODEL: "search-model" }) });
  assert.equal(config.model, "vendor/custom:任意模型");
  assert.equal(config.apiKey, "fixture-env-key");
  assert.equal(config.baseUrl, "https://gateway.example/v1");
  assert.equal(config.provider, "env");
});

test("legacy OpenAI variables and AI_SEARCH_MODEL remain supported", (t) => {
  const homeDir = fixtureHome(t);
  const config = loadAiConfig({ homeDir, env: {
    OPENAI_API_KEY: "legacy-key", OPENAI_BASE_URL: "https://legacy.example",
    OPENAI_MODEL: "legacy/model", AI_SEARCH_MODEL: "lower-priority", AI_SEARCH_API_MODE: "responses"
  } });
  assert.equal(config.model, "legacy/model");
  assert.equal(config.apiKey, "legacy-key");
  assert.equal(config.apiMode, "responses");
  assert.equal(loadAiConfig({ homeDir, env: {
    AI_OPENAI_API_KEY: "alias-key", AI_OPENAI_BASE_URL: "https://legacy.example/v1", AI_SEARCH_MODEL: "search/model"
  } }).model, "search/model");
});

test("a model-only environment override keeps cc-switch connection credentials", (t) => {
  const homeDir = fixtureHome(t, { config: ccConfig() });
  const config = loadAiConfig({ homeDir, env: { AI_MODEL: "override/model", AI_API_MODE: "chat" } });
  assert.equal(config.model, "override/model");
  assert.equal(config.apiKey, "fixture-cc-key");
  assert.equal(config.baseUrl, "https://selected.example/provider/v1");
  assert.equal(config.apiMode, "chat");
});

test("partial environment credentials never borrow another provider's key or endpoint", (t) => {
  const homeDir = fixtureHome(t, { config: ccConfig() });
  const keyOnly = loadAiConfig({ homeDir, env: { AI_API_KEY: "own-key", AI_MODEL: "own-model" } });
  const urlOnly = loadAiConfig({ homeDir, env: { AI_BASE_URL: "https://own.example", AI_MODEL: "own-model" } });
  assert.equal(keyOnly.apiKey, "own-key");
  assert.equal(keyOnly.baseUrl, "");
  assert.equal(urlOnly.apiKey, "");
  assert.equal(urlOnly.baseUrl, "https://own.example");
});

test("environment connections require their own model instead of a hardcoded or cc-switch model", (t) => {
  const homeDir = fixtureHome(t, { config: ccConfig() });
  const config = loadAiConfig({ homeDir, env: environment({ AI_MODEL: "" }) });
  assert.equal(config.model, "");
  const absent = loadAiConfig({ homeDir: fixtureHome(t), env: {} });
  assert.equal(absent.model, "");
});

test("cc-switch supports an endpoint table fallback without a fixed model", (t) => {
  const homeDir = fixtureHome(t, { config: { auth: { OPENAI_API_KEY: "fixture-cc-key" }, config: 'model = "cc/model"' } });
  const config = loadAiConfig({ homeDir, env: {} });
  assert.equal(config.model, "cc/model");
  assert.equal(config.baseUrl, "https://cc-fallback.example/v1");
  assert.equal(config.apiMode, "chat");
});

for (const [input, prefix] of [
  ["https://api.deepseek.com/", "https://api.deepseek.com/v1"],
  ["https://api.commandcode.ai/provider/v1/", "https://api.commandcode.ai/provider/v1"],
  ["https://gateway.example/custom/api", "https://gateway.example/custom/api"],
  ["https://gateway.example/chat/completions", "https://gateway.example"],
  ["https://gateway.example/responses", "https://gateway.example"],
  ["https://gateway.example/provider/v1/chat/completions", "https://gateway.example/provider/v1"],
  ["https://gateway.example/provider/v1/responses", "https://gateway.example/provider/v1"]
]) {
  test(`provider endpoints preserve the configured API prefix: ${input}`, (t) => {
    const config = loadAiConfig({ homeDir: fixtureHome(t), env: environment({ AI_BASE_URL: input }) });
    assert.equal(config.chatCompletionsUrl, `${prefix}/chat/completions`);
    assert.equal(config.responsesUrl, `${prefix}/responses`);
  });
}

test("missing model disables plan, review and web search without any HTTP calls", async (t) => {
  let calls = 0;
  interceptFetch(t, async () => { calls += 1; throw new Error("unexpected HTTP request"); });
  const options = { homeDir: fixtureHome(t), env: environment({ AI_MODEL: "" }) };
  const plan = await buildAiCreatorSearchPlan(brief, fallbackPlan, options);
  assert.equal(plan.aiSearch.enabled, false);
  assert.match(plan.aiSearch.reason, /模型|model/i);
  const review = await postProcessCreatorsWithAi(brief, [{ id: "youtube:one" }], options);
  assert.equal(review.meta.enabled, false);
  await assert.rejects(discoverCreatorsWithAiWebSearch(brief, fallbackPlan, options), { code: "AI_CONFIG_MISSING" });
  await assert.rejects(buildAiCreatorSearchPlan(brief, fallbackPlan, { ...options, requireAi: true }), { code: "AI_CONFIG_MISSING" });
  assert.equal(calls, 0);
});

test("DeepSeek and third-party models pass unchanged through planning and review", async (t) => {
  const requests = [];
  interceptFetch(t, async (url, request) => {
    const body = JSON.parse(request.body);
    requests.push({ url, body, authorization: request.headers.Authorization });
    return body.max_tokens === 1800 ? chatResponse({ reviews: [{ id: "youtube:one", semanticScore: 88 }] }) : chatResponse();
  });
  const options = { homeDir: fixtureHome(t), env: environment({ AI_BASE_URL: "https://api.deepseek.com", AI_MODEL: "vendor/future-model:preview" }) };
  const plan = await buildAiCreatorSearchPlan(brief, fallbackPlan, options);
  const review = await postProcessCreatorsWithAi(brief, [{ id: "youtube:one" }], options);
  assert.equal(plan.aiSearch.enabled, true);
  assert.equal(review.meta.enabled, true);
  assert.equal(requests.length, 2);
  for (const request of requests) {
    assert.equal(request.url, "https://api.deepseek.com/v1/chat/completions");
    assert.equal(request.body.model, "vendor/future-model:preview");
    assert.equal(request.authorization, "Bearer fixture-env-key");
  }
});

test("cc-switch wire_api selects Responses for both planning and review", async (t) => {
  const requests = [];
  interceptFetch(t, async (url, request) => {
    const body = JSON.parse(request.body);
    requests.push({ url, body });
    return Response.json({ output_text: JSON.stringify(body.max_output_tokens === 1800 ? { reviews: [] } : planOutput) });
  });
  const options = { homeDir: fixtureHome(t, { config: ccConfig() }), env: {} };
  assert.equal((await buildAiCreatorSearchPlan(brief, fallbackPlan, options)).aiSearch.enabled, true);
  assert.equal((await postProcessCreatorsWithAi(brief, [{ id: "youtube:one" }], options)).meta.enabled, true);
  assert.equal(requests.length, 2);
  assert.ok(requests.every(({ url, body }) => url === "https://selected.example/provider/v1/responses" && body.model === "vendor/cc-default:custom"));
});

test("Responses failure falls back to Chat while preserving provider URL and model", async (t) => {
  const requests = [];
  interceptFetch(t, async (url, request) => {
    requests.push({ url, model: JSON.parse(request.body).model });
    return url.endsWith("/responses") ? Response.json({ error: { message: "unsupported endpoint" } }, { status: 404 }) : chatResponse();
  });
  const options = { homeDir: fixtureHome(t), env: environment({ AI_BASE_URL: "https://api.commandcode.ai/provider/v1", AI_API_MODE: "responses" }) };
  const plan = await buildAiCreatorSearchPlan(brief, fallbackPlan, options);
  assert.equal(plan.aiSearch.enabled, true);
  assert.deepEqual(requests.map(({ url }) => url), ["https://api.commandcode.ai/provider/v1/responses", "https://api.commandcode.ai/provider/v1/chat/completions"]);
  assert.ok(requests.every(({ model }) => model === "vendor/custom:任意模型"));
});

test("AI plan cache separates endpoints, API modes and credentials", async (t) => {
  let calls = 0;
  interceptFetch(t, async (url) => {
    calls += 1;
    return url.endsWith("/responses") ? Response.json({ output_text: JSON.stringify(planOutput) }) : chatResponse();
  });
  const homeDir = fixtureHome(t);
  const configs = [environment(), environment({ AI_BASE_URL: "https://second.example/v1" }), environment({ AI_API_MODE: "responses" }), environment({ AI_API_KEY: "other-fixture-key" })];
  for (const env of configs) assert.equal((await buildAiCreatorSearchPlan(brief, fallbackPlan, { homeDir, env })).aiSearch.enabled, true);
  assert.equal(calls, 4);
  assert.equal((await buildAiCreatorSearchPlan(brief, fallbackPlan, { homeDir, env: configs[0] })).aiSearch.cached, true);
  assert.equal(calls, 4);
});

import test from "node:test";
import assert from "node:assert/strict";
import { createUsageService } from "../backend/services/usage-service.js";
import { getBackendConfig } from "../backend/services/config-service.js";

test("usage context records discovery success without sensitive prompt or token", async () => {
  let currentTime = Date.UTC(2026, 6, 4, 1, 0, 0);
  const written = [];
  const usageService = createUsageService(getBackendConfig({ USAGE_SINK: "none" }), {
    now: () => currentTime,
    sink: { write: async (record) => written.push(record) }
  });
  const context = usageService.createContext({
    requestId: "req_1",
    identity: { id: "token:abc", tokenId: "abc" },
    platform: "tiktok",
    brief: { rawText: "beauty creator private prompt" },
    requestedLimit: 20
  });

  currentTime += 120;
  context.recordStage("ai_plan", Date.UTC(2026, 6, 4, 1, 0, 0));
  context.recordStage("provider_discovery", Date.UTC(2026, 6, 4, 1, 0, 0));
  currentTime += 80;
  const record = await context.finish({
    status: "success",
    response: { candidates: [{ id: "tiktok:@one" }, { id: "tiktok:@two" }] }
  });

  assert.equal(record.requestId, "req_1");
  assert.equal(record.identityId, "token:abc");
  assert.equal(record.platform, "tiktok");
  assert.equal(record.briefLength, "beauty creator private prompt".length);
  assert.equal(record.candidatesReturned, 2);
  assert.equal(record.aiPlanCalls, 1);
  assert.equal(record.searchProviderCalls, 1);
  assert.equal(JSON.stringify(record).includes("beauty creator private prompt"), false);
  assert.deepEqual(written, [record]);
});

test("usage context records failures once", async () => {
  const usageService = createUsageService(getBackendConfig({ USAGE_SINK: "none" }));
  const context = usageService.createContext({
    requestId: "req_fail",
    identity: { id: "token:def", tokenId: "def" },
    platform: "x",
    brief: {},
    requestedLimit: 10
  });

  const error = new Error("boom");
  error.code = "DISCOVERY_TIMEOUT";
  const first = await context.finish({ status: "error", error });
  const second = await context.finish({ status: "success", response: { candidates: [] } });

  assert.equal(first.status, "error");
  assert.equal(first.errorCode, "DISCOVERY_TIMEOUT");
  assert.equal(second, null);
  assert.equal(usageService.records.length, 1);
});

test("usage service summarizes daily usage by identity and platform", async () => {
  let currentTime = Date.UTC(2026, 6, 4, 8, 0, 0);
  const usageService = createUsageService(getBackendConfig({ USAGE_SINK: "none" }), {
    now: () => currentTime
  });

  await usageService.createContext({
    requestId: "a",
    identity: { id: "token:one", tokenId: "one" },
    platform: "tiktok",
    requestedLimit: 20
  }).finish({ status: "success", response: { candidates: [{ id: "1" }] } });
  currentTime = Date.UTC(2026, 6, 4, 9, 0, 0);
  await usageService.createContext({
    requestId: "b",
    identity: { id: "token:one", tokenId: "one" },
    platform: "x",
    requestedLimit: 20
  }).finish({ status: "success", response: { candidates: [{ id: "2" }] } });

  const summary = usageService.summarizeDailyUsage({
    day: "2026-07-04",
    identityId: "token:one",
    platform: "tiktok"
  });

  assert.equal(summary.requests, 1);
  assert.equal(summary.candidatesReturned, 1);
  assert.equal(summary.platform, "tiktok");
});

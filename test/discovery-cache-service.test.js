import test from "node:test";
import assert from "node:assert/strict";
import {
  __testing,
  buildThirdPartyDiscoveryCacheKey,
  getThirdPartyDiscoveryCache,
  getThirdPartyCacheTtlMs,
  setThirdPartyDiscoveryCache,
  setThirdPartyDiscoveryErrorCache
} from "../backend/services/discovery-cache-service.js";

test("Third-party discovery cache normalizes identical keywords for a 10-minute hit", () => {
  delete process.env.DISCOVERY_THIRD_PARTY_CACHE_DISABLED;
  __testing.clearThirdPartyDiscoveryCache();
  const firstKey = buildThirdPartyDiscoveryCacheKey({
    platform: "tiktok",
    provider: "fallback-search",
    brief: { rawText: "  Beauty   Creator " },
    filters: { country: "US", minFollowers: 10000, minMatchScore: 50, minQualityScore: 55 },
    limit: 100,
    locale: "zh-CN"
  });
  const secondKey = buildThirdPartyDiscoveryCacheKey({
    platform: "TikTok",
    provider: "fallback-search",
    brief: { rawText: "beauty creator" },
    filters: { country: "us", minFollowers: 10000, minMatchScore: 50, minQualityScore: 55 },
    limit: 100,
    locale: "zh-cn"
  });
  const creators = [{ id: "tiktok:@one", handle: "@one" }];
  Object.defineProperty(creators, "discoveryMeta", {
    value: { rawFetched: 3 },
    enumerable: false
  });

  setThirdPartyDiscoveryCache(firstKey, creators, 1_000);
  const hit = getThirdPartyDiscoveryCache(secondKey, 2_000);

  assert.equal(firstKey.hash, secondKey.hash);
  assert.equal(hit.kind, "success");
  assert.equal(hit.ageMs, 1_000);
  assert.equal(hit.ttlMs, 10 * 60 * 1000);
  assert.deepEqual(hit.creators, [{ id: "tiktok:@one", handle: "@one" }]);
  assert.deepEqual(hit.creators.discoveryMeta, { rawFetched: 3 });
  assert.notEqual(hit.creators, creators);
});

test("Third-party discovery cache stores business-empty results but expires them", () => {
  delete process.env.DISCOVERY_THIRD_PARTY_CACHE_DISABLED;
  __testing.clearThirdPartyDiscoveryCache();
  const key = buildThirdPartyDiscoveryCacheKey({
    platform: "tiktok",
    provider: "fallback-search",
    brief: { rawText: "cosplay creator" },
    filters: {},
    limit: 80,
    locale: "zh-CN"
  });
  const error = new Error("未召回候选");
  error.name = "DiscoveryEmptyError";
  error.code = "DISCOVERY_EMPTY";
  error.statusCode = 200;

  setThirdPartyDiscoveryErrorCache(key, error, 5_000);
  const hit = getThirdPartyDiscoveryCache(key, 6_000);
  const expired = getThirdPartyDiscoveryCache(key, 5_000 + getThirdPartyCacheTtlMs() + 1);

  assert.equal(hit.kind, "error");
  assert.equal(hit.error.code, "DISCOVERY_EMPTY");
  assert.equal(hit.error.statusCode, 200);
  assert.equal(expired, null);
});

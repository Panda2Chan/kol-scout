import test from "node:test";
import assert from "node:assert/strict";
import {
  buildCacheKey,
  createCacheAdapter,
  createMemoryCacheAdapter,
  createRedisCacheAdapter
} from "../backend/services/cache-service.js";
import { ConfigError, getBackendConfig } from "../backend/services/config-service.js";

test("memory cache adapter stores values with TTL", async () => {
  let currentTime = 1_000;
  const cache = createMemoryCacheAdapter({ now: () => currentTime });

  await cache.set("key", { ok: true }, { ttlMs: 500 });
  assert.deepEqual(await cache.get("key"), { ok: true });

  currentTime = 1_600;
  assert.equal(await cache.get("key"), null);
});

test("cache keys are namespaced hashes without raw input", () => {
  const key = buildCacheKey("demo", ["secret prompt", { country: "US" }]);

  assert.equal(key.startsWith("kol-scout:demo:"), true);
  assert.equal(key.includes("secret prompt"), false);
});

test("redis cache adapter works with a Redis-like test double", async () => {
  const client = createRedisDouble();
  const cache = createRedisCacheAdapter(client);

  await cache.set("profile", { id: 1 }, { ttlMs: 1000 });
  assert.deepEqual(await cache.get("profile"), { id: 1 });
  assert.equal(await cache.increment("counter", { ttlMs: 1000 }), 1);
  assert.equal(await cache.increment("counter"), 2);
  assert.deepEqual(await cache.health(), { driver: "redis", available: true });
});

test("production Redis cache requires REDIS_URL", () => {
  assert.throws(
    () => createCacheAdapter(getBackendConfig({
      APP_ENV: "production",
      CACHE_DRIVER: "redis"
    })),
    ConfigError
  );
});

function createRedisDouble() {
  const values = new Map();
  return {
    async get(key) {
      return values.get(key) || null;
    },
    async set(key, value) {
      values.set(key, value);
    },
    async setEx(key, _seconds, value) {
      values.set(key, value);
    },
    async incrBy(key, amount) {
      const next = Number(values.get(key) || 0) + amount;
      values.set(key, String(next));
      return next;
    },
    async pExpire() {},
    async del(key) {
      values.delete(key);
    },
    async ping() {
      return "PONG";
    }
  };
}

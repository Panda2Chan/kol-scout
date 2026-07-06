import { createHash } from "node:crypto";
import { createClient } from "redis";
import { ConfigError } from "./config-service.js";

export function createCacheAdapter(config, options = {}) {
  if (config.cache.driver === "redis") {
    if (options.redisClient) return createRedisCacheAdapter(options.redisClient);
    if (!config.cache.redisUrl) {
      if (config.cache.redisRequired) throw new ConfigError("生产环境 CACHE_DRIVER=redis 时必须配置 REDIS_URL。");
      return createMemoryCacheAdapter();
    }
    return createRedisCacheAdapter(createClient({ url: config.cache.redisUrl }), { lazyConnect: true });
  }
  return createMemoryCacheAdapter();
}

export function createMemoryCacheAdapter(options = {}) {
  const now = options.now || (() => Date.now());
  const entries = new Map();

  return {
    driver: "memory",
    async get(key) {
      const entry = entries.get(key);
      if (!entry) return null;
      if (entry.expiresAt && entry.expiresAt <= now()) {
        entries.delete(key);
        return null;
      }
      return cloneJsonSafe(entry.value);
    },
    async set(key, value, options = {}) {
      entries.set(key, {
        value: cloneJsonSafe(value),
        expiresAt: options.ttlMs ? now() + Number(options.ttlMs) : 0
      });
      return true;
    },
    async delete(key) {
      entries.delete(key);
    },
    async increment(key, options = {}) {
      const current = Number(await this.get(key) || 0);
      const next = current + Number(options.amount ?? 1);
      if (next <= 0) {
        entries.delete(key);
        return 0;
      }
      await this.set(key, next, { ttlMs: options.ttlMs });
      return next;
    },
    async clear() {
      entries.clear();
    },
    async size() {
      return entries.size;
    },
    async health() {
      return { driver: "memory", available: true };
    }
  };
}

export function createRedisCacheAdapter(client, options = {}) {
  let connecting = null;

  return {
    driver: "redis",
    async get(key) {
      await ensureConnected();
      const value = await client.get(key);
      return value ? JSON.parse(value) : null;
    },
    async set(key, value, options = {}) {
      await ensureConnected();
      const serialized = JSON.stringify(value);
      if (options.ttlMs && client.setEx) {
        await client.setEx(key, Math.max(1, Math.ceil(Number(options.ttlMs) / 1000)), serialized);
        return true;
      }
      if (options.ttlMs) {
        await client.set(key, serialized, { PX: Number(options.ttlMs) });
        return true;
      }
      await client.set(key, serialized);
      return true;
    },
    async delete(key) {
      await ensureConnected();
      await client.del(key);
    },
    async increment(key, options = {}) {
      await ensureConnected();
      const amount = Number(options.amount ?? 1);
      const next = client.incrBy ? await client.incrBy(key, amount) : await incrementFallback(client, key, amount);
      if (options.ttlMs && next === amount) {
        if (client.pExpire) await client.pExpire(key, Number(options.ttlMs));
        else if (client.expire) await client.expire(key, Math.max(1, Math.ceil(Number(options.ttlMs) / 1000)));
      }
      if (next <= 0) await client.del(key);
      return Math.max(0, next);
    },
    async clear() {},
    async size() {
      return null;
    },
    async health() {
      await ensureConnected();
      if (client.ping) await client.ping();
      return { driver: "redis", available: true };
    }
  };

  async function ensureConnected() {
    if (!options.lazyConnect) return;
    if (client.isOpen) return;
    connecting ||= client.connect();
    await connecting;
  }
}

export function buildCacheKey(namespace, parts = []) {
  const raw = stableStringify(parts);
  const hash = createHash("sha256").update(raw).digest("hex").slice(0, 24);
  return `kol-scout:${namespace}:${hash}`;
}

async function incrementFallback(client, key, amount) {
  const current = Number(await client.get(key) || 0);
  const next = current + amount;
  await client.set(key, JSON.stringify(next));
  return next;
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function cloneJsonSafe(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

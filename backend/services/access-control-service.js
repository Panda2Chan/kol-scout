import { createHash } from "node:crypto";

export class AccessControlError extends Error {
  constructor(message, code, statusCode = 403) {
    super(message);
    this.name = "AccessControlError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

export function createAccessController(config, options = {}) {
  const now = options.now || (() => Date.now());
  const store = options.store || createMemoryAccessStore();
  const cacheAdapter = options.cacheAdapter || null;

  return {
    async guardRequest(req, guardOptions = {}) {
      const identity = resolveIdentity(req, config);
      if (config.limits.enabled) {
        await consumeIpLimit(store, cacheAdapter, config, resolveClientIp(req), now());
      }

      if (!guardOptions.discovery) {
        return { identity, release: () => {} };
      }

      if (config.limits.enabled) {
        await consumeDailyDiscoveryQuota(store, cacheAdapter, config, identity, now());
        await consumeUserConcurrency(store, cacheAdapter, config, identity);
      }

      let released = false;
      return {
        identity,
        release() {
          if (released || !guardOptions.discovery || !config.limits.enabled) return;
          released = true;
          return releaseUserConcurrency(store, cacheAdapter, identity);
        }
      };
    },
    store
  };
}

export function createMemoryAccessStore() {
  return {
    ipWindows: new Map(),
    dailyDiscovery: new Map(),
    runningDiscovery: new Map()
  };
}

export function resolveClientIp(req) {
  const forwardedFor = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();
  return forwardedFor || req.socket?.remoteAddress || "unknown";
}

function resolveIdentity(req, config) {
  if (!config.auth.required) {
    return {
      id: "local-dev",
      tokenId: "local-dev",
      authenticated: false,
      bypassed: true
    };
  }

  const token = extractBearerToken(req);
  if (!token) {
    throw new AccessControlError("缺少访问 token，请配置后重试。", "AUTH_TOKEN_MISSING", 401);
  }
  if (!config.auth.tokens.includes(token)) {
    throw new AccessControlError("访问 token 无效，请检查配置。", "AUTH_TOKEN_INVALID", 403);
  }

  const tokenId = createHash("sha256").update(token).digest("hex").slice(0, 16);
  return {
    id: `token:${tokenId}`,
    tokenId,
    authenticated: true,
    bypassed: false
  };
}

function extractBearerToken(req) {
  const header = String(req.headers.authorization || "");
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || "";
}

async function consumeIpLimit(store, cacheAdapter, config, ip, timestamp) {
  const maxRequests = config.limits.ipMaxRequests;
  const windowMs = config.limits.ipWindowMs;
  if (!maxRequests || !windowMs) return;

  const key = `ip:${ip}`;
  if (cacheAdapter) {
    const count = await cacheAdapter.increment(`access:${key}`, { ttlMs: windowMs });
    if (count > maxRequests) {
      throw new AccessControlError("请求太频繁，请稍后再试。", "RATE_LIMITED", 429);
    }
    return;
  }

  const existing = store.ipWindows.get(key);
  const entry = !existing || existing.resetAt <= timestamp
    ? { count: 0, resetAt: timestamp + windowMs }
    : existing;

  entry.count += 1;
  store.ipWindows.set(key, entry);

  if (entry.count > maxRequests) {
    throw new AccessControlError("请求太频繁，请稍后再试。", "RATE_LIMITED", 429);
  }
}

async function consumeDailyDiscoveryQuota(store, cacheAdapter, config, identity, timestamp) {
  const quota = config.limits.userDailyDiscoveryQuota;
  if (!quota) return;

  const day = new Date(timestamp).toISOString().slice(0, 10);
  const key = `quota:${identity.id}:${day}`;
  if (cacheAdapter) {
    const count = await cacheAdapter.increment(`access:${key}`, { ttlMs: getMsUntilTomorrow(timestamp) });
    if (count > quota) {
      throw new AccessControlError("今日全站匹配额度已用完。", "DAILY_QUOTA_EXCEEDED", 429);
    }
    return;
  }

  const count = store.dailyDiscovery.get(key) || 0;
  if (count >= quota) {
    throw new AccessControlError("今日全站匹配额度已用完。", "DAILY_QUOTA_EXCEEDED", 429);
  }
  store.dailyDiscovery.set(key, count + 1);
}

async function consumeUserConcurrency(store, cacheAdapter, config, identity) {
  const limit = config.limits.userConcurrentDiscoveryLimit;
  if (!limit) return;

  const key = `running:${identity.id}`;
  if (cacheAdapter) {
    const count = await cacheAdapter.increment(`access:${key}`);
    if (count > limit) {
      await cacheAdapter.increment(`access:${key}`, { amount: -1 });
      throw new AccessControlError("已有全站匹配任务在运行，请稍后再试。", "USER_CONCURRENCY_LIMITED", 429);
    }
    return;
  }

  const count = store.runningDiscovery.get(key) || 0;
  if (count >= limit) {
    throw new AccessControlError("已有全站匹配任务在运行，请稍后再试。", "USER_CONCURRENCY_LIMITED", 429);
  }
  store.runningDiscovery.set(key, count + 1);
}

async function releaseUserConcurrency(store, cacheAdapter, identity) {
  const key = `running:${identity.id}`;
  if (cacheAdapter) {
    await cacheAdapter.increment(`access:${key}`, { amount: -1 });
    return;
  }

  const count = store.runningDiscovery.get(key) || 0;
  if (count <= 1) {
    store.runningDiscovery.delete(key);
    return;
  }
  store.runningDiscovery.set(key, count - 1);
}

function getMsUntilTomorrow(timestamp) {
  const date = new Date(timestamp);
  const tomorrow = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + 1);
  return Math.max(1, tomorrow - timestamp);
}

export const DEFAULT_API_BASE_URL = "http://127.0.0.1:8787";

const TRUE_VALUES = new Set(["1", "true", "yes", "on"]);
const FALSE_VALUES = new Set(["0", "false", "no", "off"]);
const LOCAL_HOST_PERMISSIONS = [
  "http://127.0.0.1:8787/*",
  "http://localhost:8787/*"
];

export class ConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = "ConfigError";
    this.code = "CONFIG_ERROR";
  }
}

export function getBackendConfig(env = process.env) {
  const appEnv = normalizeAppEnv(env.APP_ENV || env.NODE_ENV || "development");
  const isProduction = appEnv === "production";
  const host = normalizeHost(env.HOST || "127.0.0.1");
  const port = parseInteger(env.PORT, 8787, "PORT");
  const authRequired = parseBoolean(env.AUTH_REQUIRED, isProduction);
  const limitsEnabled = parseBoolean(env.ACCESS_LIMITS_ENABLED, isProduction);
  const queueLimitsEnabled = parseBoolean(env.DISCOVERY_QUEUE_LIMITS_ENABLED, isProduction);
  const cacheDriver = normalizeDriver(env.CACHE_DRIVER || "memory", ["memory", "redis"], "CACHE_DRIVER");
  const usageSink = normalizeDriver(env.USAGE_SINK || (isProduction ? "redis" : "jsonl"), ["jsonl", "redis", "none"], "USAGE_SINK");
  const corsOrigins = parseList(env.CORS_ORIGINS || "*");

  return {
    appEnv,
    version: env.npm_package_version || "1.3.1",
    isProduction,
    server: {
      host,
      port,
      publicBaseUrl: normalizeOptionalUrl(env.PUBLIC_BASE_URL || "")
    },
    cors: {
      allowedOrigins: corsOrigins,
      allowAllOrigins: corsOrigins.includes("*")
    },
    auth: {
      required: authRequired,
      tokens: parseList(env.API_AUTH_TOKENS || env.API_AUTH_TOKEN || ""),
      tokensConfigured: parseList(env.API_AUTH_TOKENS || env.API_AUTH_TOKEN || "").length > 0
    },
    limits: {
      enabled: limitsEnabled,
      ipWindowMs: parseInteger(env.IP_RATE_LIMIT_WINDOW_MS, 60_000, "IP_RATE_LIMIT_WINDOW_MS"),
      ipMaxRequests: parseInteger(env.IP_RATE_LIMIT_MAX_REQUESTS, 60, "IP_RATE_LIMIT_MAX_REQUESTS"),
      userDailyDiscoveryQuota: parseInteger(
        env.USER_DAILY_DISCOVERY_QUOTA,
        isProduction ? 30 : 0,
        "USER_DAILY_DISCOVERY_QUOTA"
      ),
      userConcurrentDiscoveryLimit: parseInteger(
        env.USER_CONCURRENT_DISCOVERY_LIMIT,
        isProduction ? 1 : 0,
        "USER_CONCURRENT_DISCOVERY_LIMIT"
      )
    },
    queue: {
      limitsEnabled: queueLimitsEnabled,
      maxConcurrent: parseInteger(env.DISCOVERY_MAX_CONCURRENT, isProduction ? 2 : 0, "DISCOVERY_MAX_CONCURRENT"),
      maxSize: parseInteger(env.DISCOVERY_QUEUE_MAX_SIZE, isProduction ? 20 : 0, "DISCOVERY_QUEUE_MAX_SIZE"),
      timeoutMs: parseInteger(env.DISCOVERY_QUEUE_TIMEOUT_MS, 30_000, "DISCOVERY_QUEUE_TIMEOUT_MS")
    },
    usage: {
      sink: usageSink,
      jsonlPath: env.USAGE_JSONL_PATH || "logs/usage.jsonl"
    },
    cache: {
      driver: cacheDriver,
      redisUrl: env.REDIS_URL || "",
      redisConfigured: Boolean(env.REDIS_URL),
      redisRequired: isProduction && cacheDriver === "redis",
      discoveryThirdPartyTtlMs: parseInteger(
        env.DISCOVERY_THIRD_PARTY_CACHE_TTL_MS,
        10 * 60 * 1000,
        "DISCOVERY_THIRD_PARTY_CACHE_TTL_MS"
      ),
      aiPlanTtlMs: parseInteger(env.AI_PLAN_CACHE_TTL_MS, 10 * 60 * 1000, "AI_PLAN_CACHE_TTL_MS")
    }
  };
}

export function getExtensionBuildConfig(env = process.env, options = {}) {
  const target = normalizeAppEnv(options.target || env.BUILD_TARGET || env.APP_ENV || env.NODE_ENV || "development");
  const isProduction = target === "production";
  const apiBaseUrl = normalizeUrl(env.KOL_API_BASE_URL || env.API_BASE_URL || DEFAULT_API_BASE_URL, "KOL_API_BASE_URL");

  if (isProduction && new URL(apiBaseUrl).protocol !== "https:") {
    throw new ConfigError("生产扩展构建必须使用 HTTPS API 地址，请配置 KOL_API_BASE_URL=https://...");
  }

  const apiOrigin = new URL(apiBaseUrl).origin;
  const hostPermissions = isProduction
    ? [`${apiOrigin}/*`]
    : uniqueValues([...LOCAL_HOST_PERMISSIONS, `${apiOrigin}/*`]);

  return {
    target,
    isProduction,
    apiBaseUrl,
    apiOrigin,
    hostPermissions,
    authTokenConfigured: Boolean(env.KOL_API_AUTH_TOKEN || env.API_AUTH_TOKEN)
  };
}

export function getCorsHeaders(req, config) {
  const origin = String(req.headers.origin || "");
  const headers = {
    "Access-Control-Allow-Headers": "content-type, authorization",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Content-Type": "application/json; charset=utf-8"
  };

  if (config.cors.allowAllOrigins) {
    headers["Access-Control-Allow-Origin"] = "*";
    return headers;
  }

  const allowedOrigin = config.cors.allowedOrigins.includes(origin)
    ? origin
    : config.cors.allowedOrigins[0] || "null";
  headers["Access-Control-Allow-Origin"] = allowedOrigin;
  headers.Vary = "Origin";
  return headers;
}

export function getHealthConfigSummary(config) {
  return {
    version: config.version,
    env: config.appEnv,
    server: {
      host: config.server.host,
      port: config.server.port,
      publicBaseUrlConfigured: Boolean(config.server.publicBaseUrl)
    },
    accessControl: {
      authRequired: config.auth.required,
      limitsEnabled: config.limits.enabled
    },
    cache: {
      driver: config.cache.driver,
      redisConfigured: config.cache.redisConfigured,
      redisRequired: config.cache.redisRequired
    },
    queue: {
      limitsEnabled: config.queue.limitsEnabled,
      maxConcurrent: config.queue.maxConcurrent,
      maxSize: config.queue.maxSize,
      timeoutMs: config.queue.timeoutMs
    },
    usage: {
      sink: config.usage.sink
    }
  };
}

function normalizeAppEnv(value) {
  const normalized = String(value || "development").trim().toLowerCase();
  if (normalized === "prod") return "production";
  if (normalized === "dev" || normalized === "local") return "development";
  if (normalized === "test") return "test";
  return normalized || "development";
}

function normalizeHost(value) {
  const host = String(value || "").trim();
  if (!host) throw new ConfigError("HOST 不能为空");
  return host;
}

function parseInteger(value, fallback, name) {
  if (value == null || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new ConfigError(`${name} 必须是非负整数`);
  }
  return parsed;
}

function parseBoolean(value, fallback) {
  if (value == null || value === "") return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (TRUE_VALUES.has(normalized)) return true;
  if (FALSE_VALUES.has(normalized)) return false;
  return fallback;
}

function parseList(value) {
  return String(value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function normalizeDriver(value, allowed, name) {
  const normalized = String(value || "").trim().toLowerCase();
  if (!allowed.includes(normalized)) {
    throw new ConfigError(`${name} 必须是 ${allowed.join(", ")} 之一`);
  }
  return normalized;
}

function normalizeUrl(value, name) {
  const normalized = String(value || "").trim().replace(/\/+$/, "");
  try {
    const url = new URL(normalized);
    if (!["http:", "https:"].includes(url.protocol)) {
      throw new Error("unsupported protocol");
    }
    return url.toString().replace(/\/+$/, "");
  } catch {
    throw new ConfigError(`${name} 必须是合法 HTTP(S) URL`);
  }
}

function normalizeOptionalUrl(value) {
  if (!String(value || "").trim()) return "";
  return normalizeUrl(value, "PUBLIC_BASE_URL");
}

function uniqueValues(values) {
  return [...new Set(values)];
}

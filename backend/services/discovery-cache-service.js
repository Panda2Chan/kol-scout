import { createHash } from "node:crypto";
import { createMemoryCacheAdapter } from "./cache-service.js";

const DEFAULT_CACHE_TTL_MS = 10 * 60 * 1000;
const MAX_CACHE_ENTRIES = 120;
const DISABLED_VALUES = new Set(["1", "true", "yes", "on"]);

let discoveryCacheAdapter = createMemoryCacheAdapter();

export function configureDiscoveryCache(options = {}) {
  discoveryCacheAdapter = options.cacheAdapter || createMemoryCacheAdapter();
}

export function buildThirdPartyDiscoveryCacheKey({
  platform,
  provider,
  brief,
  filters,
  limit,
  locale
} = {}) {
  const payload = stableStringify({
    version: 3,
    platform: normalizeText(platform),
    provider: normalizeText(provider),
    keyword: normalizeKeyword(brief?.rawText || brief?.query || ""),
    filters: normalizeFiltersForCache(filters),
    limit: Number(limit || 0),
    locale: normalizeText(locale || "zh-CN")
  });

  return {
    raw: payload,
    hash: createHash("sha256").update(payload).digest("hex").slice(0, 16),
    key: `kol-scout:third-party-discovery:${createHash("sha256").update(payload).digest("hex").slice(0, 24)}`
  };
}

export async function getThirdPartyDiscoveryCache(cacheKey, now = Date.now()) {
  if (isThirdPartyCacheDisabled()) return null;
  const entry = await discoveryCacheAdapter.get(cacheKey.key);
  if (!entry) return null;

  if (entry.expiresAt <= now) {
    await discoveryCacheAdapter.delete(cacheKey.key);
    return null;
  }

  return {
    cacheKeyHash: cacheKey.hash,
    ageMs: now - entry.createdAt,
    expiresInMs: entry.expiresAt - now,
    ttlMs: entry.ttlMs,
    kind: entry.kind,
    creators: entry.kind === "success" ? restoreCreators(entry.payload) : null,
    error: entry.kind === "error" ? restoreError(entry.payload) : null
  };
}

export async function setThirdPartyDiscoveryCache(cacheKey, creators, now = Date.now()) {
  if (isThirdPartyCacheDisabled()) return null;
  const ttlMs = getThirdPartyCacheTtlMs();
  const entry = {
    kind: "success",
    createdAt: now,
    expiresAt: now + ttlMs,
    ttlMs,
    payload: snapshotCreators(creators)
  };
  await writeCacheEntry(cacheKey.key, entry, now);
  return {
    cacheKeyHash: cacheKey.hash,
    ttlMs
  };
}

export async function setThirdPartyDiscoveryErrorCache(cacheKey, error, now = Date.now()) {
  if (isThirdPartyCacheDisabled()) return null;
  if (!isCacheableDiscoveryError(error)) return null;

  const ttlMs = getThirdPartyCacheTtlMs();
  const entry = {
    kind: "error",
    createdAt: now,
    expiresAt: now + ttlMs,
    ttlMs,
    payload: snapshotError(error)
  };
  await writeCacheEntry(cacheKey.key, entry, now);
  return {
    cacheKeyHash: cacheKey.hash,
    ttlMs
  };
}

export function getThirdPartyCacheTtlMs() {
  const configured = Number(process.env.DISCOVERY_THIRD_PARTY_CACHE_TTL_MS || DEFAULT_CACHE_TTL_MS);
  return Number.isFinite(configured) && configured > 0 ? Math.round(configured) : DEFAULT_CACHE_TTL_MS;
}

export function isThirdPartyCacheDisabled() {
  return DISABLED_VALUES.has(String(process.env.DISCOVERY_THIRD_PARTY_CACHE_DISABLED || "").toLowerCase());
}

async function writeCacheEntry(key, entry) {
  await discoveryCacheAdapter.set(key, entry, { ttlMs: entry.ttlMs });
}

function snapshotCreators(creators) {
  return {
    items: cloneJsonSafe(Array.isArray(creators) ? creators : []),
    discoveryMeta: cloneJsonSafe(creators?.discoveryMeta || null)
  };
}

function restoreCreators(payload = {}) {
  const creators = cloneJsonSafe(payload.items || []);
  if (payload.discoveryMeta) {
    Object.defineProperty(creators, "discoveryMeta", {
      value: cloneJsonSafe(payload.discoveryMeta),
      enumerable: false
    });
  }
  return creators;
}

function snapshotError(error = {}) {
  return {
    name: error.name || "Error",
    message: error.message || String(error),
    code: error.code || "",
    statusCode: error.statusCode || 500
  };
}

function restoreError(payload = {}) {
  const error = new Error(payload.message || "三方数据缓存为空结果");
  error.name = payload.name || "Error";
  error.code = payload.code || "";
  error.statusCode = payload.statusCode || 500;
  return error;
}

function isCacheableDiscoveryError(error = {}) {
  return error.code === "DISCOVERY_EMPTY" || error.name === "DiscoveryEmptyError" || error.statusCode === 200;
}

function normalizeFiltersForCache(filters = {}) {
  return {
    country: normalizeText(filters.country || ""),
    maxFakeFollowerRisk: normalizeText(filters.maxFakeFollowerRisk || ""),
    minFollowers: Number(filters.minFollowers || 0),
    minMatchScore: Number(filters.minMatchScore || 0),
    minQualityScore: Number(filters.minQualityScore || 0),
    requiredGender: normalizeText(filters.requiredGender || ""),
    requiredRegion: normalizeText(filters.requiredRegion || filters.requiredRegionGroup || ""),
    basicTraits: normalizeBasicTraits(filters.basicTraits)
  };
}

function normalizeBasicTraits(traits = []) {
  return (Array.isArray(traits) ? traits : [])
    .map((trait) => normalizeText(trait.id || trait))
    .filter(Boolean)
    .sort();
}

function normalizeKeyword(value) {
  return normalizeText(value).replace(/\s+/g, " ");
}

function normalizeText(value) {
  return String(value || "").trim().toLowerCase();
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

export const __testing = {
  async clearThirdPartyDiscoveryCache() {
    await discoveryCacheAdapter.clear();
  },
  async size() {
    return discoveryCacheAdapter.size();
  },
  configureMemoryCache(options = {}) {
    discoveryCacheAdapter = createMemoryCacheAdapter(options);
  }
};

import { buildCreatorSearchPlan, matchCreators, normalizeBrief } from "./match-service.js";
import { buildAiCreatorSearchPlan, discoverCreatorsWithAiWebSearch } from "./ai-search-service.js";

const DEFAULT_FILTERS = {
  minMatchScore: 50,
  minQualityScore: 55,
  minFollowers: 0,
  maxFakeFollowerRisk: "medium"
};

const RISK_RANK = { low: 1, medium: 2, high: 3 };
const DISCOVERY_TOTAL_TIMEOUT_MS = 5 * 60 * 1000;

export class DiscoveryEmptyError extends Error {
  constructor(message) {
    super(message);
    this.name = "DiscoveryEmptyError";
    this.statusCode = 200;
    this.code = "DISCOVERY_EMPTY";
  }
}

export class DiscoveryTimeoutError extends Error {
  constructor(timeoutMs = DISCOVERY_TOTAL_TIMEOUT_MS) {
    const timeoutSeconds = Math.ceil(Number(timeoutMs || DISCOVERY_TOTAL_TIMEOUT_MS) / 1000);
    const message = timeoutSeconds >= 60 && timeoutSeconds % 60 === 0
      ? `全站匹配超过 ${timeoutSeconds / 60} 分钟，请缩小筛选条件后重试。`
      : `全站匹配超过 ${timeoutSeconds} 秒，请缩小筛选条件后重试。`;
    super(message);
    this.name = "DiscoveryTimeoutError";
    this.statusCode = 504;
    this.code = "DISCOVERY_TIMEOUT";
  }
}

export async function discoverCreators(briefInput = {}, registry, options = {}) {
  const totalTimeoutMs = readTimeoutMs(options.timeoutMs || process.env.DISCOVERY_TOTAL_TIMEOUT_MS, DISCOVERY_TOTAL_TIMEOUT_MS);
  const totalSignal = createTimeoutSignal(
    totalTimeoutMs,
    options.signal
  );
  const brief = normalizeBrief(briefInput);
  const platform = normalizePlatform(options.platform || brief.platforms[0] || "x");
  const provider = registry.get(platform);

  if (!provider?.discoverCreators) {
    throw new Error(`Unsupported discovery platform: ${platform}`);
  }

  const limit = clamp(Number(options.limit || 20), 1, 50);
  const filters = normalizeFilters(options.filters || {}, brief);
  const fallbackPlan = buildCreatorSearchPlan(brief, { platform, locale: options.locale || "zh-CN" });
  const plan = platform === "x"
    ? await runWithAbort(buildAiCreatorSearchPlan(brief, fallbackPlan, {
      platform,
      locale: options.locale || "zh-CN",
      filters,
      requireAi: false,
      signal: totalSignal
    }), totalSignal, totalTimeoutMs)
    : {
      ...fallbackPlan,
      aiSearch: {
        enabled: false,
        reason: "当前 AI 搜索规划仅用于 X，TikTok 使用规则搜索计划"
      }
    };
  const discoveryOptions = {
    limit: platform === "tiktok" ? Math.min(Math.max(limit * 2, 10), 15) : Math.max(limit * 3, 24),
    filters,
    locale: options.locale || "zh-CN",
    signal: totalSignal
  };
  let aiWebSearch = null;
  let dataSource = provider.sourceName || "unknown";
  let fetched = [];

  if (platform === "x" && plan.aiSearch?.enabled && process.env.AI_WEB_SEARCH_DISABLED !== "true") {
    try {
      aiWebSearch = await runWithAbort(discoverCreatorsWithAiWebSearch(brief, plan, {
        ...discoveryOptions,
        platform,
        limit: Math.min(Math.max(limit, 8), 20)
      }), totalSignal, totalTimeoutMs);
      fetched = aiWebSearch.creators;
      fetched = await runWithAbort(enrichAiWebSearchCreators(fetched, provider, 20, totalSignal), totalSignal, totalTimeoutMs);
      dataSource = "ai-web-search";
    } catch (error) {
      if (totalSignal.aborted) throw new DiscoveryTimeoutError(totalTimeoutMs);
      aiWebSearch = {
        enabled: false,
        error: error.message,
        fallback: provider.sourceName || "unknown"
      };
    }
  }

  if (!fetched.length) {
    throwIfAborted(totalSignal, totalTimeoutMs);
    try {
      fetched = await runWithAbort(provider.discoverCreators(plan, discoveryOptions), totalSignal, totalTimeoutMs);
    } catch (error) {
      if (totalSignal.aborted || isTimeoutError(error)) throw new DiscoveryTimeoutError(totalTimeoutMs);
      throw error;
    }
    throwIfAborted(totalSignal, totalTimeoutMs);
    dataSource = aiWebSearch?.fallback ? `${provider.sourceName || "unknown"}-fallback` : provider.sourceName || "unknown";
  }

  if (!fetched.length) {
    throw new DiscoveryEmptyError("真实数据源未返回候选账号，请调整关键词或配置 KOL_DATA_API_URL 三方数据源。");
  }

  const normalized = dedupeCreators(
    fetched.map((creator) => normalizeDiscoveredCreator(creator, platform))
  );
  const matchById = new Map(matchCreators(brief, normalized).map((item) => [item.creatorId, item.match]));

  const analyzed = normalized.map((creator) => {
    const baseMatch = matchById.get(creator.id) || {};
    const quality = analyzeCreatorQuality(creator);
    const finalScore = calculateFinalScore(baseMatch.score || 0, quality);

    return {
      ...creator,
      quality,
      match: {
        ...baseMatch,
        score: finalScore,
        provider: "discovery-rules-v1",
        reasons: buildDiscoveryReasons(baseMatch, quality),
        concerns: [...(baseMatch.concerns || []), ...quality.concerns],
        dimensions: {
          ...(baseMatch.dimensions || {}),
          baseMatch: baseMatch.score || 0,
          quality: quality.score,
          sourceRelevance: creator.relevanceScore ?? creator.discovery?.relevanceScore ?? null,
          fakeFollowerRisk: quality.fakeFollowerRisk
        }
      },
      score: finalScore
    };
  });

  const rejected = [];
  const kept = [];

  for (const creator of analyzed) {
    const reason = getFilteredReason(creator, filters);
    if (reason) {
      rejected.push({
        id: creator.id,
        name: creator.name,
        handle: creator.handle,
        reason
      });
      continue;
    }
    kept.push(creator);
  }

  const candidates = kept.sort((a, b) => b.score - a.score).slice(0, limit);

  return {
    platform,
    plan,
    filters,
    candidates,
    rejected: rejected.slice(0, 20),
    summary: {
      totalFetched: normalized.length,
      kept: candidates.length,
      filtered: rejected.length,
      filteredReasons: countReasons(rejected),
      dataSource,
      aiSearch: {
        enabled: Boolean(plan.aiSearch?.enabled),
        provider: plan.aiSearch?.provider || "",
        model: plan.aiSearch?.model || "",
        cached: Boolean(plan.aiSearch?.cached),
        reason: plan.aiSearch?.reason || "",
        queries: plan.aiSearch?.queries || [],
        webSearch: aiWebSearch?.meta || (aiWebSearch ? {
          enabled: false,
          error: aiWebSearch.error || "",
          fallback: aiWebSearch.fallback || ""
        } : null)
      }
    }
  };
}

function readTimeoutMs(value, fallback) {
  const timeoutMs = Number(value || fallback);
  return Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : fallback;
}

function createTimeoutSignal(timeoutMs, parentSignal) {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  if (!parentSignal) return timeoutSignal;
  if (parentSignal.aborted) return parentSignal;
  if (AbortSignal.any) return AbortSignal.any([parentSignal, timeoutSignal]);

  const controller = new AbortController();
  const abort = () => {
    controller.abort(parentSignal.aborted ? parentSignal.reason : timeoutSignal.reason);
  };
  parentSignal.addEventListener("abort", abort, { once: true });
  timeoutSignal.addEventListener("abort", abort, { once: true });
  return controller.signal;
}

function throwIfAborted(signal, timeoutMs) {
  if (!signal?.aborted) return;
  throw new DiscoveryTimeoutError(timeoutMs);
}

function runWithAbort(promise, signal, timeoutMs) {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(new DiscoveryTimeoutError(timeoutMs));

  return Promise.race([
    promise,
    new Promise((_, reject) => {
      signal.addEventListener("abort", () => reject(new DiscoveryTimeoutError(timeoutMs)), { once: true });
    })
  ]);
}

function isTimeoutError(error) {
  const message = String(error?.message || error || "");
  return error?.name === "TimeoutError" || error?.name === "AbortError" || /aborted|timeout/i.test(message);
}

async function enrichAiWebSearchCreators(creators, provider, maxEnrichCount, signal) {
  if (!provider?.enrich || !Array.isArray(creators) || !creators.length) return creators;

  const enriched = [];
  for (const creator of creators) {
    if (enriched.length >= maxEnrichCount) {
      enriched.push(creator);
      continue;
    }

    enriched.push(await runWithAbort(provider.enrich(creator, { signal }), signal));
  }
  return enriched;
}

export function analyzeCreatorQuality(creator) {
  const metrics = creator.metrics || {};
  const followers = Number(metrics.followers || 0);
  const following = Number(metrics.following || 0);
  const posts = Number(metrics.posts || 0);
  const avgEngagement = Number(metrics.avgEngagement || metrics.averageEngagement || 0);
  const engagementRate = followers && avgEngagement ? avgEngagement / followers : null;
  const haystack = [
    creator.name,
    creator.handle,
    creator.bio,
    creator.discovery?.evidenceText,
    ...(creator.tags || [])
  ].join(" ").toLowerCase();

  const signals = [];
  const concerns = [];
  let score = 70;
  let fakeFollowerRisk = "low";

  if (creator.bio && creator.bio.length >= 40) {
    score += 8;
    signals.push("简介信息完整");
  } else {
    score -= 12;
    concerns.push("简介过短或缺失");
  }

  if (followers > 0) score += 6;
  if (posts >= 100) score += 6;
  if (creator.avatarUrl) score += 4;

  if (creator.discovery?.kind === "web-search" && !(creator.tags || []).length) {
    score -= 20;
    concerns.push("搜索结果缺少可验证的主题命中");
  }

  if (engagementRate != null) {
    if (engagementRate >= 0.02) {
      score += 12;
      signals.push("互动率较健康");
    } else if (engagementRate >= 0.006) {
      score += 5;
    } else if (followers >= 50_000) {
      score -= 35;
      fakeFollowerRisk = "high";
      concerns.push("粉丝量较高但互动率异常偏低");
    } else {
      score -= 12;
      fakeFollowerRisk = "medium";
      concerns.push("互动率偏低");
    }
  } else if (followers >= 20_000) {
    score -= 8;
    fakeFollowerRisk = "medium";
    concerns.push("缺少互动数据，需二次校验粉丝质量");
  }

  if (followers >= 10_000 && following > followers * 1.2) {
    score -= 18;
    fakeFollowerRisk = maxRisk(fakeFollowerRisk, "medium");
    concerns.push("关注数相对粉丝数异常偏高");
  }

  if (posts > 0 && posts < 20) {
    score -= 18;
    concerns.push("内容沉淀过少");
  }

  if (/(giveaway|airdrop|follow back|dm for promo|100%|博彩|成人|抽奖|擦边|互关|私信互关|premium\+|do not follow|不要关注|フォローしない|rt\/qrt|deadlykalesh|gharkekalesh)/i.test(haystack)) {
    score -= 25;
    fakeFollowerRisk = maxRisk(fakeFollowerRisk, "high");
    concerns.push("命中低质量或高风险内容信号");
  }

  if (/(official|store|shop|brand|shein|news|shopping|官网|旗舰店|官方|新闻)/i.test(haystack)) {
    score -= 18;
    concerns.push("存在品牌或媒体弱信号，需复核");
  }

  if (isLikelyBrandAccount(creator, haystack)) {
    score -= 35;
    fakeFollowerRisk = maxRisk(fakeFollowerRisk, "medium");
    concerns.push("疑似品牌号，不符合个人 OP 画像");
  }

  if (/(we do not own|do not own any photos|re-?post|owner'?s name|搬运|转载|合集|collection|curated|fan account)/i.test(haystack)) {
    score -= 32;
    fakeFollowerRisk = maxRisk(fakeFollowerRisk, "medium");
    concerns.push("疑似搬运或聚合账号，不符合个人 OP 画像");
  }

  if (/(showcas(?:e|ing) our products|free shipping|coupon|costume shop|cosplay shop|supplier|wholesale|商品链接|产品目录|店铺链接)/i.test(haystack)) {
    score -= 35;
    fakeFollowerRisk = maxRisk(fakeFollowerRisk, "medium");
    concerns.push("疑似商品或店铺账号，不符合个人 OP 画像");
  }

  if (String(creator.name || "").length > 100 && !creator.bio) {
    score -= 28;
    fakeFollowerRisk = maxRisk(fakeFollowerRisk, "medium");
    concerns.push("搜索标题解析异常，无法验证创作者身份");
  }

  if (creator.name === "X" && !creator.bio && !(creator.tags || []).length) {
    score -= 30;
    fakeFollowerRisk = maxRisk(fakeFollowerRisk, "medium");
    concerns.push("主页信息缺失，无法验证创作者身份");
  }

  score = clamp(Math.round(score), 0, 100);

  return {
    score,
    level: score >= 75 ? "high" : score >= 55 ? "medium" : "low",
    fakeFollowerRisk,
    engagementRate: engagementRate == null ? null : Number(engagementRate.toFixed(4)),
    signals,
    concerns
  };
}

function normalizeDiscoveredCreator(input, platform) {
  const handle = normalizeHandle(input.handle || extractHandle(input.profileUrl));
  const rawHandle = handle.replace(/^@/, "");

  return {
    id: input.id || `${platform}:${handle || input.profileUrl || input.name}`.toLowerCase(),
    platform,
    name: input.name || handle || "Unknown creator",
    handle,
    profileUrl: input.profileUrl || buildProfileUrl(platform, rawHandle),
    avatarUrl: input.avatarUrl || "",
    bio: cleanCreatorBio(input.bio),
    contact: {
      email: input.contact?.email || "",
      source: input.contact?.source || "",
      available: Boolean(input.contact?.email)
    },
    metrics: {
      followers: input.metrics?.followers ?? null,
      following: input.metrics?.following ?? null,
      likes: input.metrics?.likes ?? null,
      posts: input.metrics?.posts ?? null,
      avgEngagement: input.metrics?.avgEngagement ?? input.metrics?.averageEngagement ?? null
    },
    relevanceScore: input.relevanceScore ?? input.discovery?.relevanceScore ?? null,
    tags: input.tags || [],
    discovery: {
      kind: input.discovery?.kind || "third-party-search",
      confidence: input.discovery?.confidence ?? 86,
      summary: input.discovery?.summary || "来自全站数据源的候选，已做匹配和质量初筛。",
      evidenceText: cleanEvidenceText(input.discovery?.evidenceText || [input.bio, ...(input.tags || [])].filter(Boolean).join(" ")),
      needsEnrichment: Boolean(input.discovery?.needsEnrichment),
      relevanceScore: input.discovery?.relevanceScore ?? input.relevanceScore ?? null,
      sourceProvider: input.discovery?.sourceProvider || input.sourceProvider || "third-party"
    },
    enrichment: {
      status: input.enrichment?.status || (input.discovery?.needsEnrichment ? "partial" : "enriched"),
      provider: input.enrichment?.provider || input.sourceProvider || "third-party",
      lastEnrichedAt: Date.now(),
      error: ""
    },
    source: {
      pageUrl: input.source?.pageUrl || "",
      pageTitle: input.source?.pageTitle || "全站匹配",
      capturedAt: Date.now()
    }
  };
}

function cleanCreatorBio(value) {
  const text = String(value || "").trim();
  return isBoilerplateProfileText(text) ? "" : text;
}

function cleanEvidenceText(value) {
  return String(value || "")
    .split(/\r?\n|;\s*/)
    .map((line) => line.trim())
    .filter((line) => line && !isBoilerplateProfileText(line))
    .join("\n");
}

function isBoilerplateProfileText(text) {
  return /Browse your favorite items/i.test(text)
    || /TikTok Shop is now available/i.test(text)
    || /Visit TikTok to discover more trending creators/i.test(text)
    || /Skip to content|For You|Following|LIVE|Log in to follow creators/i.test(text);
}

function calculateFinalScore(matchScore, quality) {
  const riskPenalty = quality.fakeFollowerRisk === "high" ? 35 : quality.fakeFollowerRisk === "medium" ? 8 : 0;
  return clamp(Math.round(matchScore * 0.72 + quality.score * 0.28 - riskPenalty), 0, 100);
}

function buildDiscoveryReasons(baseMatch, quality) {
  return [
    ...(baseMatch.reasons || []).slice(0, 2),
    quality.score >= 75 ? "质量评分通过" : "",
    quality.engagementRate ? `互动率 ${(quality.engagementRate * 100).toFixed(2)}%` : "",
    quality.fakeFollowerRisk === "low" ? "假粉风险低" : ""
  ].filter(Boolean);
}

function getFilteredReason(creator, filters) {
  if (creator.quality?.concerns?.some((concern) => concern.includes("品牌号"))) return "疑似品牌号";
  if (creator.quality?.concerns?.some((concern) => concern.includes("搬运") || concern.includes("商品"))) return "疑似聚合或商品号";
  if (creator.quality?.concerns?.some((concern) => concern.includes("无法验证创作者身份"))) return "信息不足";
  if (creator.quality?.concerns?.some((concern) => concern.includes("标题解析异常"))) return "信息不足";
  if (creator.discovery?.kind === "web-search" && !(creator.tags || []).length) return "低匹配度";
  if (filters.minFollowers && creator.metrics?.followers == null) {
    return "粉丝数未知";
  }
  if (filters.minFollowers && creator.metrics?.followers != null && Number(creator.metrics.followers) < filters.minFollowers) {
    return "粉丝数不足";
  }
  if ((creator.match?.score || 0) < filters.minMatchScore && !hasPlatformSearchEvidence(creator, filters.minMatchScore)) {
    return "低匹配度";
  }
  if ((creator.quality?.score || 0) < filters.minQualityScore) return "低质量";
  if (RISK_RANK[creator.quality?.fakeFollowerRisk || "high"] > RISK_RANK[filters.maxFakeFollowerRisk]) {
    return "疑似假粉或异常互动";
  }
  return "";
}

function hasPlatformSearchEvidence(creator, minMatchScore) {
  if (creator.platform !== "tiktok" || creator.discovery?.kind !== "web-search") return false;
  if ((creator.tags || []).length < 2) return false;
  return (creator.match?.dimensions?.baseMatch || creator.match?.score || 0) >= Math.max(45, minMatchScore - 8);
}

function isLikelyBrandAccount(creator, haystack) {
  const handle = String(creator.handle || "").toLowerCase();
  const name = String(creator.name || "").toLowerCase();
  const profileText = [handle, name].join(" ");
  const brandTerms = [
    "cosmetics",
    "beauty brand",
    "shop",
    "store",
    "mall",
    "news",
    "magazine",
    "products",
    "shopping"
  ];

  return handle.endsWith("_com")
    || brandTerms.some((term) => profileText.includes(term))
    || /\b(?:official|flagship)\s+(?:store|shop|brand)\b/i.test(haystack)
    || /(?:官方旗舰店|官方店铺|品牌官方)/.test(haystack);
}

function normalizeFilters(filters, brief = {}) {
  const briefMinFollowers = brief.followerRange?.min || 0;
  const minFollowers = filters.minFollowers || filters.minFollowerCount || briefMinFollowers || DEFAULT_FILTERS.minFollowers;
  return {
    ...DEFAULT_FILTERS,
    ...filters,
    minFollowers: Math.max(0, Number(minFollowers) || 0),
    maxFakeFollowerRisk: filters.maxFakeFollowerRisk || DEFAULT_FILTERS.maxFakeFollowerRisk
  };
}

function dedupeCreators(creators) {
  const byId = new Map();
  for (const creator of creators) {
    if (!creator.id) continue;
    const previous = byId.get(creator.id);
    byId.set(creator.id, previous ? mergeCreator(previous, creator) : creator);
  }
  return [...byId.values()];
}

function mergeCreator(previous, next) {
  return {
    ...previous,
    ...next,
    metrics: { ...previous.metrics, ...next.metrics },
    tags: [...new Set([...(previous.tags || []), ...(next.tags || [])])],
    discovery: { ...previous.discovery, ...next.discovery }
  };
}

function countReasons(rejected) {
  return rejected.reduce((counts, item) => {
    counts[item.reason] = (counts[item.reason] || 0) + 1;
    return counts;
  }, {});
}

function normalizePlatform(platform) {
  const normalized = String(platform || "x").toLowerCase();
  return normalized === "twitter" ? "x" : normalized;
}

function buildProfileUrl(platform, rawHandle) {
  if (!rawHandle) return "";
  if (platform === "tiktok") return `https://www.tiktok.com/@${rawHandle}`;
  return `https://x.com/${rawHandle}`;
}

function normalizeHandle(handle) {
  if (!handle) return "";
  const raw = String(handle).replace(/^@/, "").trim();
  return raw ? `@${raw}` : "";
}

function extractHandle(profileUrl = "") {
  try {
    const url = new URL(profileUrl);
    const host = url.hostname.replace(/^www\./, "").toLowerCase();
    const match = host === "tiktok.com"
      ? url.pathname.match(/^\/@([A-Za-z0-9._]{2,24})(?:\/|$)/)
      : url.pathname.match(/^\/([A-Za-z0-9_]{1,15})(?:\/|$)/);
    return match ? `@${match[1]}` : "";
  } catch {
    return "";
  }
}

function maxRisk(left, right) {
  return RISK_RANK[left] >= RISK_RANK[right] ? left : right;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}
